/**
 * Pure-TypeScript NLMS adaptive echo canceller core.
 *
 * Mirrors the algorithm implemented in `test-client/public/aec-processor.js`
 * (which runs inside an `AudioWorkletProcessor`). The worklet cannot import
 * from TS modules under `src/`, so both files maintain their own copy of the
 * algorithm. **Keep them in sync.** Algorithm changes here must be mirrored
 * in `aec-processor.js` and vice versa.
 *
 * The canceller models the speaker -> room -> mic path as a short FIR filter
 * applied to a *delayed* reference signal (the audio the app itself is
 * playing). The bulk speaker -> mic delay is removed by a ring-buffer delay
 * line seeded from the existing audio-input latency calibration; the
 * remaining filter taps absorb the residual impulse response.
 *
 * `processBlock` consumes paired blocks of mic and reference samples and
 * writes the cleaned residual (mic minus the estimated leakage) into the
 * output array. Adaptation is frozen when mic energy dominates the reference
 * energy (double-talk protection) so the filter does not learn the user's
 * voice.
 */

export interface AecCoreOptions {
  /** FIR filter length in taps (default 256). Clamped to [16, 2048]. */
  taps?: number;
  /** NLMS step size mu (default 0.2). */
  mu?: number;
  /** Normalization regularization epsilon (default 1e-3). */
  eps?: number;
  /**
   * Ratio at which mic energy >> reference energy is treated as
   * "double-talk" and adaptation is frozen (default 4).
   */
  doubleTalkRatio?: number;
  /** Maximum supported delay in samples (default 22050 = ~500 ms @ 44.1 kHz). */
  maxDelaySamples?: number;
  /** Energy tracker IIR smoothing coefficient (default 0.001). */
  energyAlpha?: number;
}

export const AEC_DEFAULTS = {
  taps: 256,
  mu: 0.2,
  eps: 1e-3,
  // Freeze adaptation when smoothed mic energy exceeds smoothed reference
  // energy. In a leakage-only steady state the mic carries `G^2 * ref_energy`
  // (leakage gain G <= 1) so mic < ref; the moment mic significantly exceeds
  // ref the user is singing and NLMS would otherwise learn the voice.
  doubleTalkRatio: 1.5,
  maxDelaySamples: 22050,
  energyAlpha: 0.001,
} as const;

export class AecCore {
  private taps: number;
  private mu: number;
  private eps: number;
  private doubleTalkRatio: number;
  private maxDelaySamples: number;
  private alpha: number;

  /** Adaptive filter weights, length === `taps`. */
  private w: Float32Array;
  /** Ring buffer of past reference samples. */
  private ring: Float32Array;
  private ringSize: number;
  /** Next write position in the ring buffer. */
  private writePos = 0;
  /** Bulk delay (samples) between reference and mic. */
  private delaySamples = 0;

  /** IIR-smoothed energy trackers (squared-sample units). */
  private refEnergy = 0;
  private micEnergy = 0;
  private errEnergy = 0;

  constructor(options: AecCoreOptions = {}) {
    this.taps = clamp(
      options.taps ?? AEC_DEFAULTS.taps,
      16,
      2048,
    );
    this.mu = options.mu ?? AEC_DEFAULTS.mu;
    this.eps = options.eps ?? AEC_DEFAULTS.eps;
    this.doubleTalkRatio =
      options.doubleTalkRatio ?? AEC_DEFAULTS.doubleTalkRatio;
    this.maxDelaySamples =
      options.maxDelaySamples ?? AEC_DEFAULTS.maxDelaySamples;
    this.alpha = options.energyAlpha ?? AEC_DEFAULTS.energyAlpha;

    this.w = new Float32Array(this.taps);
    this.ringSize = this.maxDelaySamples + this.taps + 128;
    this.ring = new Float32Array(this.ringSize);
  }

  /** Set the bulk reference -> mic delay in samples (clamped to allowed range). */
  setDelaySamples(d: number): void {
    this.delaySamples = clamp(Math.round(d), 0, this.maxDelaySamples);
  }

  /** Set the bulk reference -> mic delay in milliseconds at the given rate. */
  setDelayMs(ms: number, sampleRate: number): void {
    this.setDelaySamples((ms / 1000) * sampleRate);
  }

  /** Zero the adaptive filter and energy trackers (but keep the ring buffer). */
  resetWeights(): void {
    this.w.fill(0);
    this.refEnergy = 0;
    this.micEnergy = 0;
    this.errEnergy = 0;
  }

  /** Diagnostics. */
  stats(): {
    delaySamples: number;
    taps: number;
    refEnergyDb: number;
    micEnergyDb: number;
    residualDb: number;
  } {
    return {
      delaySamples: this.delaySamples,
      taps: this.taps,
      refEnergyDb: 10 * Math.log10(this.refEnergy + 1e-20),
      micEnergyDb: 10 * Math.log10(this.micEnergy + 1e-20),
      residualDb: 10 * Math.log10(this.errEnergy + 1e-20),
    };
  }

  /**
   * Process one block of paired mic + reference samples, writing the cleaned
   * residual into `output`. All three arrays must be the same length. The
   * `output` array may alias `mic` (in-place is supported).
   */
  processBlock(
    mic: Float32Array,
    ref: Float32Array,
    output: Float32Array,
  ): void {
    const n = mic.length;
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
      // Push the current reference sample into the ring.
      ring[this.writePos] = ref[i];
      this.writePos = this.writePos + 1;
      if (this.writePos >= ringSize) this.writePos = 0;

      // Compute FIR estimate y_hat = sum_{k=0..taps-1} w[k] * x[k]
      // where x[k] is the reference sample delayed by (D + k) samples.
      // The most-recently-written sample is at writePos - 1; the first tap
      // therefore sits at base = writePos - 1 - D, tap k at base - k.
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

      const m = mic[i];
      const e = m - yHat;
      output[i] = e;

      // IIR-smooth energy trackers.
      this.micEnergy += alpha * (m * m - this.micEnergy);
      this.refEnergy += alpha * (ref[i] * ref[i] - this.refEnergy);
      this.errEnergy += alpha * (e * e - this.errEnergy);

      // Double-talk: if the mic carries much more energy than the reference
      // can plausibly explain (filter gain ~ 1), the user is singing and we
      // freeze adaptation to avoid learning the voice.
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
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
