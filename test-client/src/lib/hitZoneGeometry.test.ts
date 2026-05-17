import { describe, it, expect } from "vitest";
import { computeHitZoneGeometry, CROSSHAIR_X, HIT_ZONE_HALF } from "./hitZoneGeometry";

describe("computeHitZoneGeometry", () => {
  const BASE = { bpm: 30, audioLatencyMs: 0, displayLatencyMs: 0 };

  it("offset is zero when latency is zero", () => {
    const result = computeHitZoneGeometry(BASE);
    expect(result.offsetPct).toBe(0);
    expect(result.effectiveCenter).toBe(CROSSHAIR_X);
  });

  it("positive latency shifts debug-hitzone to the right", () => {
    const result = computeHitZoneGeometry({
      ...BASE,
      audioLatencyMs: 200,
      displayLatencyMs: 50,
    });
    expect(result.offsetPct).toBeGreaterThan(0);
    expect(result.effectiveCenter).toBeGreaterThan(CROSSHAIR_X);
  });

  it("offset is ~25% of zone width at typical latency", () => {
    // At 30 BPM: travelTime = 6s, pctPerMs = 110/6000 ≈ 0.01833
    // Zone width (no container) = HIT_ZONE_HALF * 2 = 12%
    // 25% of 12% = 3%  →  latencyMs ≈ 3 / 0.01833 ≈ 163.6ms
    const result = computeHitZoneGeometry({
      ...BASE,
      audioLatencyMs: 120,
      displayLatencyMs: 44,
    });
    const zoneWidth = result.halfPct * 2;
    const ratio = result.offsetPct / zoneWidth;
    expect(ratio).toBeCloseTo(0.25, 1); // within 0.05
  });

  it("offset scales linearly with latency", () => {
    const single = computeHitZoneGeometry({
      ...BASE,
      audioLatencyMs: 100,
      displayLatencyMs: 0,
    });
    const doubled = computeHitZoneGeometry({
      ...BASE,
      audioLatencyMs: 200,
      displayLatencyMs: 0,
    });
    expect(doubled.offsetPct).toBeCloseTo(single.offsetPct * 2, 10);
  });

  it("offset scales inversely with BPM", () => {
    const latency = { audioLatencyMs: 150, displayLatencyMs: 0 };
    const slow = computeHitZoneGeometry({ ...latency, bpm: 30 });
    const fast = computeHitZoneGeometry({ ...latency, bpm: 60 });
    // Double BPM → half travelTime → double pctPerMs → double offset
    // Wait — pctPerMs = 110 / (travelTime * 1000), and travelTime = (60/bpm)*3
    // So pctPerMs = 110*bpm / (60*3*1000) = 110*bpm / 180000
    // Higher BPM → higher pctPerMs → LARGER offset (notes move faster)
    expect(fast.offsetPct).toBeGreaterThan(slow.offsetPct);
    expect(fast.offsetPct).toBeCloseTo(slow.offsetPct * 2, 10);
  });
});
