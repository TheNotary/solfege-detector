import { describe, expect, it } from "vitest";
import {
  VOCAL_HIGHCUT_HZ,
  VOCAL_LOWCUT_HZ,
  createVocalBandpassFilter,
} from "./vocalBandpass";

const SR = 44_100;

function sine(freqHz: number, durationSec: number, amplitude = 0.5): Float32Array {
  const n = Math.round(durationSec * SR);
  const out = new Float32Array(n);
  const w = (2 * Math.PI * freqHz) / SR;
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin(w * i);
  return out;
}

function rms(x: Float32Array, startIdx = 0): number {
  if (x.length <= startIdx) return 0;
  let sumSq = 0;
  let count = 0;
  for (let i = startIdx; i < x.length; i++) {
    sumSq += x[i] * x[i];
    count++;
  }
  return Math.sqrt(sumSq / count);
}

/**
 * RMS gain (dB) of a sine after the filter's transient has settled. We
 * skip the first quarter of the buffer to ignore the biquad's startup.
 */
function gainDb(freqHz: number, durationSec = 0.5): number {
  const input = sine(freqHz, durationSec);
  const filter = createVocalBandpassFilter(SR);
  const output = filter(input);
  const skip = Math.floor(input.length / 4);
  const ratio = rms(output, skip) / rms(input, skip);
  return 20 * Math.log10(ratio);
}

describe("createVocalBandpassFilter", () => {
  it("attenuates 40 Hz rumble by at least 20 dB", () => {
    // 4th-order HPF @ 80 Hz: 40 Hz is one octave below corner →
    // ~24 dB attenuation. Asserting ≥20 dB leaves slack for the
    // settling transient.
    expect(gainDb(40)).toBeLessThanOrEqual(-20);
  });

  it("passes 440 Hz (A4, mid vocal range) with ≤ 1 dB attenuation", () => {
    const g = gainDb(440);
    expect(g).toBeLessThanOrEqual(0.5);
    expect(g).toBeGreaterThanOrEqual(-1);
  });

  it("attenuates 4 kHz noise by at least 20 dB", () => {
    // 4th-order LPF @ 1100 Hz: 4 kHz is ~1.86 octaves above corner →
    // ~45 dB attenuation. 20 dB is a conservative floor.
    expect(gainDb(4000)).toBeLessThanOrEqual(-20);
  });

  it("is roughly -6 dB at the lower corner frequency", () => {
    // Two cascaded biquads each contribute -3 dB at the corner.
    const g = gainDb(VOCAL_LOWCUT_HZ);
    expect(g).toBeLessThanOrEqual(-4);
    expect(g).toBeGreaterThanOrEqual(-9);
  });

  it("is roughly -6 dB at the upper corner frequency", () => {
    const g = gainDb(VOCAL_HIGHCUT_HZ);
    expect(g).toBeLessThanOrEqual(-4);
    expect(g).toBeGreaterThanOrEqual(-9);
  });

  it("does not mutate the input buffer", () => {
    const input = sine(440, 0.05);
    const snapshot = new Float32Array(input);
    const filter = createVocalBandpassFilter(SR);
    filter(input);
    for (let i = 0; i < input.length; i++) {
      expect(input[i]).toBe(snapshot[i]);
    }
  });

  it("returns a fresh array of the same length on each call", () => {
    const filter = createVocalBandpassFilter(SR);
    const a = filter(sine(440, 0.01));
    const b = filter(sine(440, 0.01));
    expect(a).not.toBe(b);
    expect(a.length).toBe(b.length);
  });

  it("produces the same output when fed in one buffer vs streamed in chunks", () => {
    // State preservation across calls is critical for the live audio path
    // where samples arrive in ~4096-sample frames from the ScriptProcessor.
    const total = sine(440, 0.2);
    const whole = createVocalBandpassFilter(SR)(total);

    const streamed = new Float32Array(total.length);
    const streamFilter = createVocalBandpassFilter(SR);
    const CHUNK = 256;
    for (let off = 0; off < total.length; off += CHUNK) {
      const end = Math.min(off + CHUNK, total.length);
      const out = streamFilter(total.subarray(off, end));
      streamed.set(out, off);
    }

    // Allow tiny floating-point divergence.
    for (let i = 0; i < total.length; i++) {
      expect(Math.abs(whole[i] - streamed[i])).toBeLessThan(1e-6);
    }
  });
});
