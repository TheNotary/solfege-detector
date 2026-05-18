import { describe, expect, it } from "vitest";
import { measureBulkDelaySamples, samplesToMs } from "./delayCalibration";

const SR = 44_100;

function sine(freqHz: number, durationSec: number, amplitude = 0.3): Float32Array {
  const n = Math.round(durationSec * SR);
  const out = new Float32Array(n);
  const w = (2 * Math.PI * freqHz) / SR;
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin(w * i);
  return out;
}

function click(freqHz: number, amplitude = 0.5, attackSec = 0.001, releaseSec = 0.019): Float32Array {
  const total = attackSec + releaseSec;
  const n = Math.round(total * SR);
  const out = new Float32Array(n);
  const w = (2 * Math.PI * freqHz) / SR;
  const attackN = Math.round(attackSec * SR);
  for (let i = 0; i < n; i++) {
    const env = i < attackN ? i / Math.max(1, attackN) : 1 - (i - attackN) / Math.max(1, n - attackN);
    out[i] = amplitude * env * Math.sin(w * i);
  }
  return out;
}

function addAt(target: Float32Array, src: Float32Array, atSample: number): void {
  for (let i = 0; i < src.length; i++) {
    const j = atSample + i;
    if (j >= 0 && j < target.length) target[j] += src[i];
  }
}

function delayedCopy(ref: Float32Array, delaySamples: number, gain: number): Float32Array {
  const out = new Float32Array(ref.length);
  for (let i = delaySamples; i < ref.length; i++) {
    out[i] = gain * ref[i - delaySamples];
  }
  return out;
}

describe("measureBulkDelaySamples", () => {
  it("recovers a known delay from a click probe within ±1 sample", () => {
    const N = 4096;
    const ref = new Float32Array(N);
    // Probe click well inside the window so a 500-sample delay still has
    // overlap to correlate against.
    addAt(ref, click(1500), 1000);
    const trueDelay = 500;
    const mic = delayedCopy(ref, trueDelay, 0.5);

    const { delaySamples, peakCorrelation, confidence } = measureBulkDelaySamples(mic, ref, {
      maxSamples: 1500,
    });
    expect(Math.abs(delaySamples - trueDelay)).toBeLessThanOrEqual(1);
    expect(peakCorrelation).toBeGreaterThan(0.9);
    expect(confidence).toBeGreaterThan(3);
  });

  it("recovers a delay near the upper end of the search range", () => {
    const N = 8192;
    const ref = new Float32Array(N);
    addAt(ref, click(1500), 1500);
    const trueDelay = 1800;
    const mic = delayedCopy(ref, trueDelay, 0.4);

    const { delaySamples, confidence } = measureBulkDelaySamples(mic, ref, {
      maxSamples: 2200,
    });
    expect(Math.abs(delaySamples - trueDelay)).toBeLessThanOrEqual(1);
    expect(confidence).toBeGreaterThan(5);
  });

  it("recovers a delay from a sustained drone reference + mic mixture", () => {
    // 200 ms of 130.81 Hz drone. The mic sees a delayed attenuated copy
    // PLUS uncorrelated white noise at -40 dB.
    const ref = sine(130.81, 0.2, 0.3);
    const trueDelay = 800;
    const mic = delayedCopy(ref, trueDelay, 0.4);
    for (let i = 0; i < mic.length; i++) mic[i] += (Math.random() * 2 - 1) * 0.003;

    const { delaySamples, peakCorrelation, confidence } = measureBulkDelaySamples(mic, ref, {
      maxSamples: 2000,
    });
    // A pure sinusoid is periodic so the correlation peaks at the true
    // delay AND at every period offset. Verify the picked lag is *some*
    // valid match (within 2 samples of true delay modulo the period).
    const periodSamples = SR / 130.81;
    const diff = delaySamples - trueDelay;
    const cycles = Math.round(diff / periodSamples);
    const residual = Math.abs(diff - cycles * periodSamples);
    expect(residual).toBeLessThan(2);
    // Correlation at any valid match should be near 1.
    expect(Math.abs(peakCorrelation)).toBeGreaterThan(0.95);
    // Confidence is modest because every period offset also lights up —
    // this is expected behavior and motivates using a transient probe
    // (click) rather than a pure tone for calibration.
    expect(confidence).toBeGreaterThan(1.3);
  });

  it("reports near-zero confidence when the reference is silent", () => {
    const N = 4096;
    const ref = new Float32Array(N); // all zeros
    const mic = new Float32Array(N);
    for (let i = 0; i < N; i++) mic[i] = (Math.random() * 2 - 1) * 0.01;

    const { peakCorrelation, confidence } = measureBulkDelaySamples(mic, ref, {
      maxSamples: 1000,
    });
    expect(peakCorrelation).toBe(0);
    expect(confidence).toBe(0);
  });

  it("reports low confidence when mic carries unrelated noise only", () => {
    const N = 4096;
    const ref = new Float32Array(N);
    addAt(ref, click(1500), 1000);
    const mic = new Float32Array(N);
    // Deterministic PRNG (mulberry32) so this isn't flaky against the
    // hard threshold below.
    let s = 0x12345678;
    const rand = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < N; i++) mic[i] = (rand() * 2 - 1) * 0.01;

    const { confidence } = measureBulkDelaySamples(mic, ref, { maxSamples: 1500 });
    // With a click in ref and only random noise in mic, peak/median is
    // bounded; production accept gate is 5.
    expect(confidence).toBeLessThan(5);
  });

  it("throws on length mismatch and invalid ranges", () => {
    const a = new Float32Array(1000);
    const b = new Float32Array(900);
    expect(() => measureBulkDelaySamples(a, b)).toThrow(/length/);

    const c = new Float32Array(100);
    expect(() => measureBulkDelaySamples(c, c, { maxSamples: 500 })).toThrow(/too short/);

    const d = new Float32Array(2000);
    expect(() =>
      measureBulkDelaySamples(d, d, { minSamples: 100, maxSamples: 50 }),
    ).toThrow(/maxSamples/);
  });

  it("samplesToMs converts correctly", () => {
    expect(samplesToMs(441, 44_100)).toBeCloseTo(10, 6);
    expect(samplesToMs(0, 44_100)).toBe(0);
  });
});
