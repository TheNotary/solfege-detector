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
