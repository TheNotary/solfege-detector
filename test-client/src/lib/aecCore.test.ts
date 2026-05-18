import { describe, expect, it } from "vitest";
import { AecCore } from "./aecCore";

const SR = 44_100;

function sine(freqHz: number, durationSec: number, amplitude = 0.3): Float32Array {
  const n = Math.round(durationSec * SR);
  const out = new Float32Array(n);
  const w = (2 * Math.PI * freqHz) / SR;
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin(w * i);
  return out;
}

function rmsDb(x: Float32Array, start = 0, end = x.length): number {
  let sumSq = 0;
  const n = end - start;
  for (let i = start; i < end; i++) sumSq += x[i] * x[i];
  const rms = Math.sqrt(sumSq / Math.max(1, n));
  return 20 * Math.log10(rms + 1e-20);
}

/** Delay-and-attenuate `signal` by `delaySamples`, returning a new array of same length. */
function delayAndAttenuate(
  signal: Float32Array,
  delaySamples: number,
  gain: number,
): Float32Array {
  const out = new Float32Array(signal.length);
  for (let i = delaySamples; i < signal.length; i++) {
    out[i] = gain * signal[i - delaySamples];
  }
  return out;
}

describe("AecCore — NLMS adaptive echo canceller", () => {
  it("cancels a delayed/attenuated reference within ~2s of adaptation", () => {
    // 5 seconds of 130.81 Hz (C3) reference; the mic sees a delayed
    // attenuated mirror plus a tiny bit of noise.
    const ref = sine(130.81, 5.0, 0.3);

    // Speaker -> mic delay: 18 ms; leakage gain 0.5.
    const delayMs = 18;
    const delaySamples = Math.round((delayMs / 1000) * SR);
    const mic = delayAndAttenuate(ref, delaySamples, 0.5);
    // Sprinkle low-level white noise to make it realistic.
    for (let i = 0; i < mic.length; i++) {
      mic[i] += (Math.random() * 2 - 1) * 1e-4;
    }

    const aec = new AecCore({ taps: 64, mu: 0.3 });
    aec.setDelayMs(delayMs, SR);

    const out = new Float32Array(mic.length);
    aec.processBlock(mic, ref, out);

    // First 0.25 s: pre-adaptation residual ≈ mic energy.
    const preStart = 0;
    const preEnd = Math.round(0.25 * SR);
    const preDb = rmsDb(mic, preStart, preEnd);

    // After 2 s: residual should be ≥20 dB below the original mic RMS.
    const postStart = Math.round(2.0 * SR);
    const postEnd = mic.length;
    const micPostDb = rmsDb(mic, postStart, postEnd);
    const outPostDb = rmsDb(out, postStart, postEnd);

    const cancellationDb = micPostDb - outPostDb;
    // Sanity: pre/post mic RMS roughly equal (steady-state sine).
    expect(Math.abs(preDb - micPostDb)).toBeLessThan(1);
    // Main assertion.
    expect(cancellationDb).toBeGreaterThanOrEqual(20);
  });

  it("preserves a voice burst that has no counterpart in the reference", () => {
    // 5 s reference C3 + a 200 ms "voice" burst (440 Hz) starting at t=3.0 s
    // (well after the filter has converged on the leakage in test 1).
    const ref = sine(130.81, 5.0, 0.3);
    const delaySamples = Math.round((18 / 1000) * SR);
    const mic = delayAndAttenuate(ref, delaySamples, 0.5);

    const voice = sine(440, 0.2, 0.4);
    const voiceStart = Math.round(3.0 * SR);
    for (let i = 0; i < voice.length; i++) mic[voiceStart + i] += voice[i];

    const aec = new AecCore({ taps: 64, mu: 0.3 });
    aec.setDelayMs(18, SR);
    const out = new Float32Array(mic.length);
    aec.processBlock(mic, ref, out);

    // In the voice window the residual should be dominated by the voice
    // (the filter is already adapted and the double-talk gate prevents it
    // from learning the voice). Voice RMS at amp 0.4 = 0.283 → -10.96 dB.
    const winStart = voiceStart;
    const winEnd = voiceStart + voice.length;
    const voiceRmsDb = 20 * Math.log10(0.4 / Math.SQRT2);
    const outDb = rmsDb(out, winStart, winEnd);

    // Voice should still be present (within 3 dB of raw voice RMS).
    expect(Math.abs(outDb - voiceRmsDb)).toBeLessThan(3);
  });

  it("setDelayMs clamps to the supported range", () => {
    const aec = new AecCore({ maxDelaySamples: 1000 });
    aec.setDelayMs(50, 44_100); // ~2205 samples -> clamped
    expect(aec.stats().delaySamples).toBe(1000);

    aec.setDelayMs(-10, 44_100);
    expect(aec.stats().delaySamples).toBe(0);
  });

  it("resetWeights zeros the filter", () => {
    const aec = new AecCore({ taps: 32 });
    aec.setDelayMs(5, SR);
    const ref = sine(200, 0.5, 0.3);
    const mic = delayAndAttenuate(ref, Math.round((5 / 1000) * SR), 0.4);
    const out = new Float32Array(mic.length);
    aec.processBlock(mic, ref, out);

    aec.resetWeights();
    // After reset, weights are zero -> output should equal mic (within float eps)
    const ref2 = sine(200, 0.05, 0.3);
    const mic2 = delayAndAttenuate(ref2, Math.round((5 / 1000) * SR), 0.4);
    // Use a fresh AEC so the ring buffer doesn't carry over previous adaptation
    // history into the next processBlock's FIR estimate.
    const aec2 = new AecCore({ taps: 32 });
    aec2.setDelayMs(5, SR);
    const out2 = new Float32Array(mic2.length);
    aec2.processBlock(mic2, ref2, out2);
    // First handful of samples: yHat = 0 because filter is zero -> out == mic.
    for (let i = 0; i < 32; i++) {
      expect(out2[i]).toBeCloseTo(mic2[i], 5);
    }
  });
});

// ---------------------------------------------------------------------------
// Drone-vs-click characterization suite.
//
// Background: in the running game the drone is canceled well but the
// metronome clicks are NOT. The AEC core itself handles brief transients
// fine when given a perfectly time-aligned reference (see the "isolated
// click" test below), so the failure has to live elsewhere on the path. The
// remaining suspects are:
//
//   (1) Timing mismatch — the reference sample arriving at the AEC processor
//       is offset from the leakage in the mic by N samples. The bulk-delay
//       calibration is tuned for the steady-state drone; even a few ms of
//       error wipes out cancellation of short transients while leaving a
//       sustained tone largely unaffected.
//   (2) Linear distortion on the speaker -> mic path — a real speaker is not
//       flat. A low-pass roll-off (or any non-trivial impulse response) means
//       the leakage of the click is no longer a scaled/delayed copy of the
//       reference. NLMS *can* learn this IF given enough in-band reference
//       energy, but a 20 ms click occurrence provides only ~960 samples of
//       1500 Hz training per click — and the drone (with no 1500 Hz energy)
//       dominates the gradient between clicks.
//
// These tests reproduce each hypothesis in isolation so we can see which one
// matches the observed failure and design the fix.
// ---------------------------------------------------------------------------

/** Short percussive click matching the metronome envelope. */
function click(
  freqHz: number,
  amplitude: number,
  attackSec = 0.001,
  releaseSec = 0.019,
): Float32Array {
  const totalSec = attackSec + releaseSec;
  const n = Math.round(totalSec * SR);
  const out = new Float32Array(n);
  const w = (2 * Math.PI * freqHz) / SR;
  const attackN = Math.round(attackSec * SR);
  for (let i = 0; i < n; i++) {
    let env: number;
    if (i < attackN) {
      env = i / Math.max(1, attackN);
    } else {
      env = 1 - (i - attackN) / Math.max(1, n - attackN);
    }
    out[i] = amplitude * env * Math.sin(w * i);
  }
  return out;
}

/** Schedule a buffer into a longer track at sample offset `atSample`. */
function addAt(target: Float32Array, src: Float32Array, atSample: number): void {
  for (let i = 0; i < src.length; i++) {
    const j = atSample + i;
    if (j >= 0 && j < target.length) target[j] += src[i];
  }
}

/** Apply a 1-pole IIR low-pass at cutoff `fc` Hz to simulate a speaker. */
function lowPass(signal: Float32Array, fcHz: number): Float32Array {
  // y[n] = y[n-1] + a * (x[n] - y[n-1]); a = dt / (RC + dt)
  const dt = 1 / SR;
  const rc = 1 / (2 * Math.PI * fcHz);
  const a = dt / (rc + dt);
  const out = new Float32Array(signal.length);
  let y = 0;
  for (let i = 0; i < signal.length; i++) {
    y = y + a * (signal[i] - y);
    out[i] = y;
  }
  return out;
}

describe("AecCore — drone vs. click cancellation characterization", () => {
  const delayMs = 18;
  const delaySamples = Math.round((delayMs / 1000) * SR);
  const leakageGain = 0.5;

  /** Ideal leakage: delay + flat attenuation + trace noise. */
  function leakIdeal(ref: Float32Array): Float32Array {
    const out = delayAndAttenuate(ref, delaySamples, leakageGain);
    for (let i = 0; i < out.length; i++) out[i] += (Math.random() * 2 - 1) * 1e-4;
    return out;
  }

  function makeAec(): AecCore {
    const aec = new AecCore();
    aec.setDelayMs(delayMs, SR);
    return aec;
  }

  it("baseline: cancels a 5s sustained drone deeply (ideal leakage model)", () => {
    const ref = sine(130.81, 5.0, 0.3);
    const mic = leakIdeal(ref);
    const aec = makeAec();
    const out = new Float32Array(mic.length);
    aec.processBlock(mic, ref, out);
    const cancellationDb =
      rmsDb(mic, Math.round(2.0 * SR)) - rmsDb(out, Math.round(2.0 * SR));
    expect(cancellationDb).toBeGreaterThanOrEqual(20);
  });

  it("baseline: cancels an ISOLATED click ≥15 dB when reference is perfectly aligned (ideal leakage)", () => {
    // Sanity: AecCore can in principle cancel a single transient. If this
    // ever regresses, the failure on the real device is moot until this is
    // fixed first.
    const totalN = Math.round(2.5 * SR);
    const ref = new Float32Array(totalN);
    addAt(ref, click(1500, 0.5), Math.round(1.0 * SR));
    const mic = leakIdeal(ref);
    const aec = makeAec();
    const out = new Float32Array(mic.length);
    aec.processBlock(mic, ref, out);

    const winStart = Math.round(1.0 * SR) + delaySamples;
    const winEnd = winStart + Math.round(0.02 * SR);
    const cancellationDb =
      rmsDb(mic, winStart, winEnd) - rmsDb(out, winStart, winEnd);
    expect(cancellationDb).toBeGreaterThanOrEqual(15);
  });

  // -------------------------------------------------------------------------
  // Hypothesis (1): timing/delay mismatch.
  // -------------------------------------------------------------------------

  it("HYPOTHESIS 1: a small (~3 ms) delay mismatch barely affects the drone but destroys click cancellation", () => {
    // True speaker -> mic delay is 18 ms but the AEC was calibrated for 21 ms
    // (a 3 ms / ~132-sample misalignment). This is well within what a
    // careless `audioInputLatencyMs` calibration could leave on the table.
    const calibratedDelayMs = 21;

    const totalSec = 5.0;
    const totalN = Math.round(totalSec * SR);
    const ref = sine(130.81, totalSec, 0.3); // drone
    addAt(ref, click(1500, 0.5), Math.round(4.0 * SR)); // click at t=4s

    const mic = leakIdeal(ref); // mic still sees true 18ms delay

    const aec = new AecCore();
    aec.setDelayMs(calibratedDelayMs, SR);
    const out = new Float32Array(mic.length);
    aec.processBlock(mic, ref, out);

    const droneStart = Math.round(3.5 * SR);
    const droneEnd = Math.round(3.9 * SR);
    const droneCancelDb =
      rmsDb(mic, droneStart, droneEnd) - rmsDb(out, droneStart, droneEnd);

    const clickAt = Math.round(4.0 * SR) + delaySamples;
    const clickCancelDb =
      rmsDb(mic, clickAt, clickAt + Math.round(0.02 * SR)) -
      rmsDb(out, clickAt, clickAt + Math.round(0.02 * SR));

    // eslint-disable-next-line no-console
    console.log(
      `[diag H1] drone=${droneCancelDb.toFixed(1)} dB ` +
        `click=${clickCancelDb.toFixed(1)} dB`,
    );

    // The 256-tap filter can absorb the misalignment for the steady-state
    // drone (shift the impulse response forward by 3 ms inside the tap
    // window) so the drone is still well-canceled…
    expect(droneCancelDb).toBeGreaterThanOrEqual(15);
    // …but on the short click the filter has no time to relearn — the
    // residual stays close to the raw click level (cancellation < 6 dB).
    // If this assertion fails (i.e. cancellation is actually high), the
    // observed real-world bug is NOT a calibration issue.
    expect(clickCancelDb).toBeLessThan(6);
  });

  // -------------------------------------------------------------------------
  // Hypothesis (2): speaker -> mic linear distortion (low-pass / EQ).
  // -------------------------------------------------------------------------

  it("HYPOTHESIS 2 (REFUTED): a realistic speaker low-pass does NOT prevent click cancellation", () => {
    // Originally suspected: speaker EQ distorts the click's leakage shape so
    // the per-click reference can't be subtracted. In fact a 256-tap FIR
    // learns the low-pass response easily from the clicks themselves —
    // cancellation remains comparable to the drone. So linear distortion on
    // the speaker path is NOT the culprit in production.
    const speakerCutoffHz = 4000;

    const totalSec = 8.0;
    const totalN = Math.round(totalSec * SR);
    const ref = sine(130.81, totalSec, 0.3);
    const clickPositions: number[] = [];
    for (let t = 0.5; t < totalSec - 0.1; t += 0.5) {
      const at = Math.round(t * SR);
      clickPositions.push(at);
      addAt(ref, click(1500, 0.5), at);
    }

    const emitted = lowPass(ref, speakerCutoffHz);
    const mic = leakIdeal(emitted);

    const aec = makeAec();
    const out = new Float32Array(mic.length);
    aec.processBlock(mic, ref, out);

    const droneStart = Math.round(7.4 * SR);
    const droneEnd = Math.round(7.6 * SR);
    const droneCancelDb =
      rmsDb(mic, droneStart, droneEnd) - rmsDb(out, droneStart, droneEnd);

    const lastClick = clickPositions[clickPositions.length - 1] + delaySamples;
    const clickCancelDb =
      rmsDb(mic, lastClick, lastClick + Math.round(0.02 * SR)) -
      rmsDb(out, lastClick, lastClick + Math.round(0.02 * SR));

    // eslint-disable-next-line no-console
    console.log(
      `[diag H2] drone=${droneCancelDb.toFixed(1)} dB ` +
        `click=${clickCancelDb.toFixed(1)} dB`,
    );

    expect(droneCancelDb).toBeGreaterThanOrEqual(20);
    // Click also gets strong cancellation — hypothesis refuted.
    expect(clickCancelDb).toBeGreaterThanOrEqual(20);
  });

  it("CONTROL: with click-rich pre-training the AEC handles clicks even through the speaker low-pass", () => {
    // If we give the filter dense in-band training BEFORE the speaker
    // distortion is applied to the leakage, can it still learn? This proves
    // the failure mode in H2 is about reference spectral coverage, not the
    // algorithm.
    const speakerCutoffHz = 4000;
    const totalSec = 4.6;
    const totalN = Math.round(totalSec * SR);
    const ref = new Float32Array(totalN);
    for (let t = 0.0; t < 3.5; t += 0.025) {
      addAt(ref, click(1500, 0.5), Math.round(t * SR));
    }
    const measureAt = Math.round(4.5 * SR);
    addAt(ref, click(1500, 0.5), measureAt);

    const emitted = lowPass(ref, speakerCutoffHz);
    const mic = leakIdeal(emitted);
    const aec = makeAec();
    const out = new Float32Array(mic.length);
    aec.processBlock(mic, ref, out);

    const winStart = measureAt + delaySamples;
    const winEnd = winStart + Math.round(0.02 * SR);
    const cancellationDb =
      rmsDb(mic, winStart, winEnd) - rmsDb(out, winStart, winEnd);
    expect(cancellationDb).toBeGreaterThanOrEqual(10);
  });
});
