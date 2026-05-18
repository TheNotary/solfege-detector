import { useCallback, useMemo, useRef } from "react";

/**
 * A scheduled mic-time window during which a metronome click's leakage is
 * expected to dominate the microphone signal. Display-side consumers (volume
 * gate, onset detector, waveform render) should ignore mic samples whose
 * audio-time falls inside an active window.
 *
 * Both endpoints are in `AudioContext.currentTime` units (seconds).
 */
export interface ClickMaskWindow {
  startAudioTime: number;
  endAudioTime: number;
}

export interface ClickMaskStoreOptions {
  /**
   * Live-readable getter for the speaker→mic round-trip delay (ms). Read on
   * every `recordClick` call so calibration changes apply to the next click
   * without rebuilding state.
   */
  getDelayMs: () => number;
  /**
   * Length of the mask window applied AFTER the predicted mic-arrival time.
   * Defaults to 80 ms — covers the ~20 ms click envelope (attack + release +
   * stop padding in `useMetronome`) plus a typical small-room reverb tail of
   * ~30–60 ms.
   */
  maskDurationMs?: number;
  /**
   * Lead guard applied BEFORE the predicted mic-arrival time. Defaults to
   * 10 ms — absorbs cross-correlation peak jitter and any sub-block delay
   * mismatch.
   */
  leadGuardMs?: number;
}

export interface ClickMaskStore {
  /**
   * Record a scheduled click. Computes its mic-side window from the live
   * `getDelayMs()` value at call time.
   */
  recordClick: (clickAudioTime: number) => void;
  /**
   * `true` iff any recorded window contains `audioTime`. Also opportunistically
   * GCs windows whose end time is more than 1 s in the past so the store
   * doesn't grow unbounded.
   */
  isMaskedAt: (audioTime: number) => boolean;
  /** Drop all recorded windows. Call when the metronome stops or the toggle flips off. */
  clear: () => void;
  /**
   * Snapshot of the active mask windows for callers that need to do their
   * own bulk traversal (e.g. the waveform renderer scanning many samples
   * at once with a two-pointer sweep). The returned array is the live
   * internal store; treat as read-only and do not mutate.
   */
  getWindows: () => readonly ClickMaskWindow[];
}

export type UseClickMaskOptions = ClickMaskStoreOptions;
export type UseClickMaskReturn = ClickMaskStore;

export const CLICK_MASK_DEFAULTS = {
  // Click oscillator itself is ~20 ms (1 ms attack + 19 ms release), but
  // the speaker's physical ringing, room reverb, and any auto-gain on the
  // input chain extend the audible click well past that — empirically the
  // leakage tail trips onset detection up to ~200 ms after the play time.
  // Pick a duration that comfortably covers that envelope.
  maskDurationMs: 220,
  // Speaker→mic latency varies with audio backend, buffer sizes, and
  // bluetooth jitter. Even with a calibrated delay the actual arrival can
  // be ~20–30 ms earlier than predicted; the lead guard absorbs that so
  // the click's leading edge never escapes the window.
  leadGuardMs: 40,
  /** Drop windows whose endAudioTime is more than this far in the past. */
  gcLookbackSec: 1,
} as const;

/**
 * Pure (React-free) implementation of the click-mask store. The hook is a
 * thin React wrapper around this so unit tests can exercise the logic
 * without spinning up a renderer.
 */
export function createClickMaskStore(
  options: ClickMaskStoreOptions,
): ClickMaskStore {
  const maskDurationSec =
    (options.maskDurationMs ?? CLICK_MASK_DEFAULTS.maskDurationMs) / 1000;
  const leadGuardSec =
    (options.leadGuardMs ?? CLICK_MASK_DEFAULTS.leadGuardMs) / 1000;
  // Windows are stored sorted by `startAudioTime` (which they naturally are
  // because clicks are recorded in chronological order). The two-pointer
  // sweep in `WaveformCrosshair` relies on this invariant.
  const windows: ClickMaskWindow[] = [];

  function recordClick(clickAudioTime: number): void {
    const delaySec = Math.max(0, options.getDelayMs() / 1000);
    const center = clickAudioTime + delaySec;
    windows.push({
      startAudioTime: center - leadGuardSec,
      endAudioTime: center + maskDurationSec,
    });
  }

  function isMaskedAt(audioTime: number): boolean {
    if (windows.length === 0) return false;

    // GC: drop windows whose endAudioTime is more than `gcLookbackSec`
    // behind `audioTime`. Because windows are sorted by start time (and
    // therefore by end time, since durations are uniform), the stale prefix
    // is contiguous; find its boundary and splice once.
    const gcThreshold = audioTime - CLICK_MASK_DEFAULTS.gcLookbackSec;
    let firstLive = 0;
    while (
      firstLive < windows.length &&
      windows[firstLive].endAudioTime < gcThreshold
    ) {
      firstLive++;
    }
    if (firstLive > 0) windows.splice(0, firstLive);

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      if (audioTime < w.startAudioTime) {
        // Windows are sorted by start time; future windows can't contain
        // `audioTime` either.
        return false;
      }
      if (audioTime <= w.endAudioTime) return true;
    }
    return false;
  }

  function clear(): void {
    windows.length = 0;
  }

  function getWindows(): readonly ClickMaskWindow[] {
    return windows;
  }

  return { recordClick, isMaskedAt, clear, getWindows };
}

/**
 * Tracks predicted mic-time windows during which scheduled metronome clicks
 * will be audible to the microphone, so display-side consumers can ignore
 * those samples without changing the underlying AEC algorithm.
 *
 * The mask works independently of `feedbackCancellation`: it uses the
 * persisted/calibrated `audioLatencyMs` setting (via `getDelayMs`), not the
 * live `aecStats.delaySamples`, so clicks are masked even when the AEC is
 * off.
 *
 * The hook is pure logic — no Web Audio API access, no React state. All
 * mutations happen in refs so the high-frequency `recordClick` /
 * `isMaskedAt` calls don't trigger re-renders.
 */
export function useClickMask(options: UseClickMaskOptions): UseClickMaskReturn {
  const getDelayMsRef = useRef(options.getDelayMs);
  getDelayMsRef.current = options.getDelayMs;

  const maskDurationMs = options.maskDurationMs;
  const leadGuardMs = options.leadGuardMs;

  // One persistent store per mounted hook. We build it once and stash on a
  // ref so it survives re-renders without re-allocating. The internal
  // `getDelayMs` indirects through `getDelayMsRef` so live latency changes
  // take effect on the next `recordClick` without rebuilding the store.
  const storeRef = useRef<ClickMaskStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createClickMaskStore({
      getDelayMs: () => getDelayMsRef.current(),
      maskDurationMs,
      leadGuardMs,
    });
  }
  const store = storeRef.current;

  const recordClick = useCallback(
    (clickAudioTime: number) => store.recordClick(clickAudioTime),
    [store],
  );
  const isMaskedAt = useCallback(
    (audioTime: number) => store.isMaskedAt(audioTime),
    [store],
  );
  const clear = useCallback(() => store.clear(), [store]);
  const getWindows = useCallback(() => store.getWindows(), [store]);

  return useMemo(
    () => ({ recordClick, isMaskedAt, clear, getWindows }),
    [recordClick, isMaskedAt, clear, getWindows],
  );
}

