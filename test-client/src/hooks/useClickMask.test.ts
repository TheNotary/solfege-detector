import { describe, it, expect } from "vitest";
import {
  CLICK_MASK_DEFAULTS,
  createClickMaskStore,
} from "./useClickMask";

describe("createClickMaskStore", () => {
  it("returns false when nothing has been recorded", () => {
    const store = createClickMaskStore({ getDelayMs: () => 0 });
    expect(store.isMaskedAt(0)).toBe(false);
    expect(store.isMaskedAt(1.234)).toBe(false);
    expect(store.getWindows()).toHaveLength(0);
  });

  it("computes the mic-side window from clickAudioTime + delay, padded by lead/trail", () => {
    const store = createClickMaskStore({
      getDelayMs: () => 100, // 100 ms speaker→mic delay
      maskDurationMs: 80,
      leadGuardMs: 10,
    });
    store.recordClick(5.0);

    // Predicted mic-arrival = 5.0 + 0.1 = 5.1 s
    // Window = [5.1 - 0.01, 5.1 + 0.08] = [5.09, 5.18]
    const windows = store.getWindows();
    expect(windows).toHaveLength(1);
    expect(windows[0].startAudioTime).toBeCloseTo(5.09, 10);
    expect(windows[0].endAudioTime).toBeCloseTo(5.18, 10);
  });

  it("isMaskedAt returns true strictly inside the window and false outside", () => {
    const store = createClickMaskStore({
      getDelayMs: () => 100,
      maskDurationMs: 80,
      leadGuardMs: 10,
    });
    store.recordClick(5.0);

    // Just before the lead guard → unmasked.
    expect(store.isMaskedAt(5.08)).toBe(false);
    // Inside the lead guard → masked.
    expect(store.isMaskedAt(5.095)).toBe(true);
    // At predicted mic-arrival → masked.
    expect(store.isMaskedAt(5.1)).toBe(true);
    // Inside the trail → masked.
    expect(store.isMaskedAt(5.17)).toBe(true);
    // Just past the trail → unmasked.
    expect(store.isMaskedAt(5.181)).toBe(false);
  });

  it("inclusive at both endpoints (sample exactly on the boundary is masked)", () => {
    const store = createClickMaskStore({
      getDelayMs: () => 0,
      maskDurationMs: 80,
      leadGuardMs: 10,
    });
    store.recordClick(1.0);
    // Window = [0.99, 1.08]
    expect(store.isMaskedAt(0.99)).toBe(true);
    expect(store.isMaskedAt(1.08)).toBe(true);
  });

  it("falls back to documented defaults when maskDurationMs / leadGuardMs are omitted", () => {
    const store = createClickMaskStore({ getDelayMs: () => 0 });
    store.recordClick(0);
    const w = store.getWindows()[0];
    expect(w.startAudioTime).toBeCloseTo(
      -CLICK_MASK_DEFAULTS.leadGuardMs / 1000,
      10,
    );
    expect(w.endAudioTime).toBeCloseTo(
      CLICK_MASK_DEFAULTS.maskDurationMs / 1000,
      10,
    );
  });

  it("treats negative delays as zero (defensive clamp)", () => {
    const store = createClickMaskStore({
      getDelayMs: () => -50, // pathological: shouldn't shift the window left
      maskDurationMs: 80,
      leadGuardMs: 10,
    });
    store.recordClick(2.0);
    const w = store.getWindows()[0];
    expect(w.startAudioTime).toBeCloseTo(1.99, 10);
    expect(w.endAudioTime).toBeCloseTo(2.08, 10);
  });

  it("re-reads getDelayMs on every recordClick (live latency changes apply to NEW clicks only)", () => {
    let delayMs = 100;
    const store = createClickMaskStore({
      getDelayMs: () => delayMs,
      maskDurationMs: 80,
      leadGuardMs: 10,
    });

    store.recordClick(1.0); // window centered on 1.0 + 0.1 = 1.1
    delayMs = 200; // simulate user moving the latency slider
    store.recordClick(2.0); // window centered on 2.0 + 0.2 = 2.2

    const windows = store.getWindows();
    expect(windows[0].endAudioTime).toBeCloseTo(1.18, 10);
    // The first window is unaffected; only subsequent recordClick calls
    // pick up the new delay.
    expect(windows[1].startAudioTime).toBeCloseTo(2.19, 10);
    expect(windows[1].endAudioTime).toBeCloseTo(2.28, 10);
  });

  it("clear() drops all recorded windows", () => {
    const store = createClickMaskStore({ getDelayMs: () => 0 });
    store.recordClick(1.0);
    store.recordClick(2.0);
    expect(store.getWindows()).toHaveLength(2);

    store.clear();
    expect(store.getWindows()).toHaveLength(0);
    expect(store.isMaskedAt(1.0)).toBe(false);
  });

  it("GCs windows whose endAudioTime is more than gcLookbackSec behind the query", () => {
    const store = createClickMaskStore({
      getDelayMs: () => 0,
      maskDurationMs: 80,
      leadGuardMs: 10,
    });
    // Three windows at t=0, 1, 2. Each ends at start+0.08.
    store.recordClick(0);
    store.recordClick(1);
    store.recordClick(2);
    expect(store.getWindows()).toHaveLength(3);

    // Query at t=10: the gc threshold is 10 - 1 = 9, which is well past
    // every recorded window's end. All three should be dropped.
    store.isMaskedAt(10);
    expect(store.getWindows()).toHaveLength(0);
  });

  it("GC keeps windows that end within the lookback horizon", () => {
    const store = createClickMaskStore({
      getDelayMs: () => 0,
      maskDurationMs: 80,
      leadGuardMs: 10,
    });
    store.recordClick(0); // ends at 0.08
    store.recordClick(0.9); // ends at 0.98

    // Query at t=1.0. Threshold = 1.0 - 1.0 = 0.0. First window ends at
    // 0.08 (>= 0.0), so it survives. Both windows kept.
    store.isMaskedAt(1.0);
    expect(store.getWindows()).toHaveLength(2);

    // Query at t=1.5. Threshold = 0.5. First window (ends 0.08 < 0.5) is
    // dropped; second (ends 0.98) survives.
    store.isMaskedAt(1.5);
    expect(store.getWindows()).toHaveLength(1);
  });

  it("handles many overlapping windows correctly", () => {
    const store = createClickMaskStore({
      getDelayMs: () => 0,
      maskDurationMs: 100,
      leadGuardMs: 10,
    });
    // Clicks every 50 ms → each 110 ms window overlaps with neighbors.
    for (let i = 0; i < 5; i++) {
      store.recordClick(i * 0.05);
    }
    // A point that falls between two overlapping windows is still masked.
    expect(store.isMaskedAt(0.12)).toBe(true);
    // A point past all five windows is unmasked.
    expect(store.isMaskedAt(0.5)).toBe(false);
  });

  it("isMaskedAt short-circuits correctly for queries in the gap between windows", () => {
    const store = createClickMaskStore({
      getDelayMs: () => 0,
      maskDurationMs: 20, // short windows so there are gaps
      leadGuardMs: 5,
    });
    store.recordClick(1.0); // [0.995, 1.020]
    store.recordClick(2.0); // [1.995, 2.020]

    expect(store.isMaskedAt(1.5)).toBe(false); // in the gap
    expect(store.isMaskedAt(1.0)).toBe(true);
    expect(store.isMaskedAt(2.0)).toBe(true);
  });
});
