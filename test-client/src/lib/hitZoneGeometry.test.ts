import { describe, it, expect } from "vitest";
import { computeHitZoneGeometry, CROSSHAIR_X, HIT_ZONE_HALF } from "./hitZoneGeometry";

describe("computeHitZoneGeometry", () => {
  const BASE = { bpm: 30, audioLatencyMs: 0, displayLatencyMs: 0 };

  it("offset is zero when latency is zero", () => {
    const result = computeHitZoneGeometry(BASE);
    expect(result.offsetPct).toBe(0);
    expect(result.effectiveCenter).toBe(CROSSHAIR_X);
  });

  it("positive latency shifts debug-hitzone to the left", () => {
    const result = computeHitZoneGeometry({
      ...BASE,
      audioLatencyMs: 200,
      displayLatencyMs: 50,
    });
    expect(result.offsetPct).toBeGreaterThan(0);
    expect(result.effectiveCenter).toBeLessThan(CROSSHAIR_X);
    expect(result.effectiveCenter).toBeCloseTo(CROSSHAIR_X - result.offsetPct, 10);
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

  it("halfPct defaults to HIT_ZONE_HALF when no container width is given", () => {
    const result = computeHitZoneGeometry(BASE);
    expect(result.halfPct).toBe(HIT_ZONE_HALF);
  });

  it("debug box pixel-width matches 2 * crosshairHalfPx on a wide viewport", () => {
    const containerWidthPx = 1920;
    const crosshairHalfPx = 80;
    const result = computeHitZoneGeometry({
      ...BASE,
      containerWidthPx,
      crosshairHalfPx,
    });
    const debugBoxPx = (result.halfPct / 100) * containerWidthPx;
    expect(debugBoxPx).toBeCloseTo(crosshairHalfPx, 3);
  });

  it("debug box pixel-width matches 2 * crosshairHalfPx on a narrow viewport", () => {
    // Guards against the historical Math.min(visualHalfPct, HIT_ZONE_HALF) cap
    // which truncated the debug zone on narrow viewports while the visual
    // crosshair-zone stayed at 160px, producing a width mismatch.
    const containerWidthPx = 800;
    const crosshairHalfPx = 80;
    const result = computeHitZoneGeometry({
      ...BASE,
      containerWidthPx,
      crosshairHalfPx,
    });
    const debugBoxPx = (result.halfPct / 100) * containerWidthPx;
    expect(debugBoxPx).toBeCloseTo(crosshairHalfPx, 3);
  });
});
