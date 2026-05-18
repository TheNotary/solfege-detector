/**
 * AEC AudioWorkletProcessor — adaptive echo canceller for cancelling the
 * app's own drone + metronome bleed out of the mic signal.
 *
 * Algorithm mirror: this file's NLMS implementation MUST stay in sync with
 * `test-client/src/lib/aecCore.ts` (the pure-TypeScript twin used by tests).
 *
 * Wiring expected by the host:
 *   - input[0] = mic       (1 channel)
 *   - input[1] = reference (1 channel) — the mix of drone + metronome
 *   - output[0]            (1 channel) — cleaned mic
 *
 * Message protocol (postMessage to the worklet's port):
 *   { type: "setLatency", ms: number }     // bulk reference->mic delay
 *   { type: "setEnabled", on: boolean }    // bypass (pass mic through)
 *   { type: "setTaps", n: number }         // change FIR length; resets weights
 *   { type: "reset" }                      // zero weights + energy
 *   { type: "stats" }                      // request immediate stats post
 *   { type: "captureWindow", samples: number }
 *                                         // record the next N paired
 *                                         // (mic, ref) samples and post
 *                                         // them back in a single message
 *
 * Messages posted from the worklet:
 *   { type: "frame", samples: Float32Array }   // cleaned audio for display-side consumers
 *   { type: "stats", delaySamples, taps, refEnergyDb, micEnergyDb, residualDb }
 *   { type: "captureWindow", mic: Float32Array, ref: Float32Array, sampleRate: number }
 */

const DEFAULT_TAPS = 256;
const DEFAULT_MU = 0.2;
const DEFAULT_EPS = 1e-3;
// Freeze adaptation when smoothed mic energy exceeds smoothed reference
// energy. See aecCore.ts for derivation.
const DEFAULT_DOUBLE_TALK_RATIO = 1.5;
/** Max delay we'll support (samples). ~500 ms at 44.1 kHz. */
const MAX_DELAY_SAMPLES = 22050;
/** IIR energy smoothing coefficient. ~22 ms time constant at 44.1 kHz. */
const ENERGY_ALPHA = 0.001;
/** Auto-post stats every ~100 ms at 44.1 kHz. */
const STATS_INTERVAL_SAMPLES = 4410;
/** Cleaned-sample frame size posted to JS (samples). */
const TAP_FRAME_SAMPLES = 1024;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

class AecProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};

    this.taps = clamp(opts.taps | 0 || DEFAULT_TAPS, 16, 2048);
    this.mu = typeof opts.mu === "number" ? opts.mu : DEFAULT_MU;
    this.eps = typeof opts.eps === "number" ? opts.eps : DEFAULT_EPS;
    this.doubleTalkRatio =
      typeof opts.doubleTalkRatio === "number"
        ? opts.doubleTalkRatio
        : DEFAULT_DOUBLE_TALK_RATIO;
    this.enabled = true;

    this.delaySamples = 0;
    this.w = new Float32Array(this.taps);
    this.ringSize = MAX_DELAY_SAMPLES + this.taps + 128;
    this.ring = new Float32Array(this.ringSize);
    this.writePos = 0;

    this.alpha = ENERGY_ALPHA;
    this.refEnergy = 0;
    this.micEnergy = 0;
    this.errEnergy = 0;

    this.tapBuf = new Float32Array(TAP_FRAME_SAMPLES);
    this.tapPos = 0;
    this.statsCounter = 0;

    // captureWindow state: when `captureRemaining > 0`, every processed
    // sample is also copied into `captureMic`/`captureRef` and the result
    // is posted to the main thread when the buffer fills up.
    this.captureMic = null;
    this.captureRef = null;
    this.capturePos = 0;
    this.captureRemaining = 0;

    this.port.onmessage = (ev) => {
      const m = ev.data;
      if (!m || typeof m !== "object") return;
      switch (m.type) {
        case "setLatency": {
          if (typeof m.ms !== "number" || !isFinite(m.ms)) return;
          this.delaySamples = clamp(
            Math.round((m.ms / 1000) * sampleRate),
            0,
            MAX_DELAY_SAMPLES,
          );
          break;
        }
        case "setEnabled":
          this.enabled = !!m.on;
          break;
        case "setTaps": {
          const n = clamp(m.n | 0, 16, 2048);
          if (n !== this.taps) {
            this.taps = n;
            this.w = new Float32Array(this.taps);
            this.ringSize = MAX_DELAY_SAMPLES + this.taps + 128;
            this.ring = new Float32Array(this.ringSize);
            this.writePos = 0;
          }
          break;
        }
        case "reset":
          this.w.fill(0);
          this.refEnergy = 0;
          this.micEnergy = 0;
          this.errEnergy = 0;
          break;
        case "stats":
          this.postStats();
          break;
        case "captureWindow": {
          // Cap at ~1 s @ 96 kHz so a malformed message can't allocate
          // unbounded memory inside the audio thread.
          const n = clamp(m.samples | 0, 16, 96000);
          this.captureMic = new Float32Array(n);
          this.captureRef = new Float32Array(n);
          this.capturePos = 0;
          this.captureRemaining = n;
          break;
        }
      }
    };
  }

  postStats() {
    this.port.postMessage({
      type: "stats",
      delaySamples: this.delaySamples,
      taps: this.taps,
      refEnergyDb: 10 * Math.log10(this.refEnergy + 1e-20),
      micEnergyDb: 10 * Math.log10(this.micEnergy + 1e-20),
      residualDb: 10 * Math.log10(this.errEnergy + 1e-20),
    });
  }

  pushTap(s) {
    this.tapBuf[this.tapPos++] = s;
    if (this.tapPos >= this.tapBuf.length) {
      const copy = new Float32Array(this.tapBuf);
      this.port.postMessage({ type: "frame", samples: copy }, [copy.buffer]);
      this.tapBuf = new Float32Array(TAP_FRAME_SAMPLES);
      this.tapPos = 0;
    }
  }

  /**
   * Append a paired (mic, ref) sample to the active capture window, if any.
   * Posts the window back to the main thread and arms for the next request
   * the moment it fills up.
   */
  recordCapture(micS, refS) {
    if (this.captureRemaining <= 0) return;
    this.captureMic[this.capturePos] = micS;
    this.captureRef[this.capturePos] = refS;
    this.capturePos++;
    this.captureRemaining--;
    if (this.captureRemaining <= 0) {
      const micOut = this.captureMic;
      const refOut = this.captureRef;
      this.captureMic = null;
      this.captureRef = null;
      this.capturePos = 0;
      this.port.postMessage(
        {
          type: "captureWindow",
          mic: micOut,
          ref: refOut,
          sampleRate,
        },
        [micOut.buffer, refOut.buffer],
      );
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outCh = output[0];
    const n = outCh.length;

    const micInput = inputs[0];
    const refInput = inputs[1];
    const micCh = micInput && micInput[0] ? micInput[0] : null;
    const refCh = refInput && refInput[0] ? refInput[0] : null;

    // No mic signal: emit silence (and keep the ring zero-filled in step).
    if (!micCh) {
      outCh.fill(0);
      return true;
    }

    // Disabled or no reference -> pass mic through. Still advance the ring
    // with zeros (or the reference if present) so weights don't go stale
    // relative to wall-clock when re-enabled.
    if (!this.enabled || !refCh) {
      for (let i = 0; i < n; i++) {
        const refS = refCh ? refCh[i] : 0;
        this.ring[this.writePos] = refS;
        this.writePos = this.writePos + 1;
        if (this.writePos >= this.ringSize) this.writePos = 0;
        const s = micCh[i];
        outCh[i] = s;
        this.pushTap(s);
        this.recordCapture(s, refS);
      }
      return true;
    }

    const taps = this.taps;
    const ring = this.ring;
    const ringSize = this.ringSize;
    const w = this.w;
    const D = this.delaySamples;
    const mu = this.mu;
    const eps = this.eps;
    const dtRatio = this.doubleTalkRatio;
    const alpha = this.alpha;

    for (let i = 0; i < n; i++) {
      ring[this.writePos] = refCh[i];
      this.writePos = this.writePos + 1;
      if (this.writePos >= ringSize) this.writePos = 0;

      let yHat = 0;
      let normSq = 0;
      let base = this.writePos - 1 - D;
      if (base < 0) base += ringSize;
      for (let k = 0; k < taps; k++) {
        let idx = base - k;
        if (idx < 0) idx += ringSize;
        const xk = ring[idx];
        yHat += w[k] * xk;
        normSq += xk * xk;
      }

      const mic = micCh[i];
      const e = mic - yHat;
      outCh[i] = e;
      this.pushTap(e);
      this.recordCapture(mic, refCh[i]);

      this.micEnergy += alpha * (mic * mic - this.micEnergy);
      this.refEnergy += alpha * (refCh[i] * refCh[i] - this.refEnergy);
      this.errEnergy += alpha * (e * e - this.errEnergy);

      const dtActive = this.micEnergy > dtRatio * this.refEnergy + 1e-8;

      if (!dtActive && normSq > 1e-9) {
        const step = mu / (normSq + eps);
        const stepErr = step * e;
        for (let k = 0; k < taps; k++) {
          let idx = base - k;
          if (idx < 0) idx += ringSize;
          w[k] += stepErr * ring[idx];
        }
      }

      this.statsCounter++;
      if (this.statsCounter >= STATS_INTERVAL_SAMPLES) {
        this.statsCounter = 0;
        this.postStats();
      }
    }

    return true;
  }
}

registerProcessor("aec-processor", AecProcessor);
