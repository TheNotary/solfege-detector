import { useCallback, useEffect, useRef } from "react";

export interface MetronomeStartOptions {
  /** Called when a beat is scheduled to read the current tempo (re-read every beat). */
  getBpm: () => number;
  /** Called when a beat is scheduled to read the current offset in seconds (re-read every beat). */
  getOffsetSec: () => number;
  /** When true, every 4th beat is louder and higher-pitched. Default false. */
  accentDownbeats?: boolean;
}

export interface UseMetronomeReturn {
  start: (opts: MetronomeStartOptions) => void;
  stop: () => void;
  setVolume: (v: number) => void;
  isRunning: () => boolean;
}

const LOOKAHEAD_MS = 200;
const SCHEDULE_AHEAD_SEC = 0.3;
const START_DELAY_SEC = 0.05;

const BASE_FREQ_HZ = 1500;
const ACCENT_FREQ_HZ = 2000;
const ACCENT_GAIN_MULT = 1.2;

const ATTACK_SEC = 0.001;
const RELEASE_SEC = 0.019;
const STOP_PADDING_SEC = 0.01;

const DEFAULT_VOLUME = 0.25;

/**
 * Open-ended Web Audio metronome scheduler.
 *
 * Pre-schedules clicks sample-accurately via a lookahead loop so beats stay
 * locked to the AudioContext clock and don't drift like `setTimeout`-driven
 * metronomes do. The BPM and offset are re-read on every scheduled beat so
 * live changes apply on the next tick without resetting phase.
 *
 * Consumes a shared `AudioContext` (do not create a new one) so the metronome
 * clock matches other audio in the app (e.g. the drone).
 *
 * When `monitorNode` is provided, each scheduled click's gain is connected to
 * *both* `ctx.destination` (audible output) and the monitor node, giving
 * downstream consumers (e.g. an AEC worklet) sample-accurate access to the
 * exact click signal the speakers are playing. Audible output is unchanged.
 */
export function useMetronome(
  audioContext: AudioContext | null,
  monitorNode: AudioNode | null = null,
): UseMetronomeReturn {
  const runningRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const t0Ref = useRef(0);
  const beatIndexRef = useRef(0);
  const volumeRef = useRef(DEFAULT_VOLUME);
  const optsRef = useRef<MetronomeStartOptions | null>(null);
  /** Oscillators scheduled but not yet stopped. */
  const pendingRef = useRef<Set<OscillatorNode>>(new Set());
  const monitorRef = useRef<AudioNode | null>(monitorNode);
  monitorRef.current = monitorNode;

  const scheduleBeat = useCallback(
    (when: number, accent: boolean) => {
      const ctx = audioContext;
      if (!ctx) return;

      const baseVolume = volumeRef.current;
      const volume = accent ? baseVolume * ACCENT_GAIN_MULT : baseVolume;
      const freq = accent ? ACCENT_FREQ_HZ : BASE_FREQ_HZ;

      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(volume, when + ATTACK_SEC);
      gain.gain.linearRampToValueAtTime(0, when + ATTACK_SEC + RELEASE_SEC);

      osc.connect(gain);
      gain.connect(ctx.destination);
      if (monitorRef.current) {
        try {
          gain.connect(monitorRef.current);
        } catch {
          // ignore — monitor may be in a different context (shouldn't happen)
        }
      }

      pendingRef.current.add(osc);
      osc.onended = () => {
        pendingRef.current.delete(osc);
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {
          // ignore — already disconnected
        }
      };

      osc.start(when);
      osc.stop(when + ATTACK_SEC + RELEASE_SEC + STOP_PADDING_SEC);
    },
    [audioContext],
  );

  const tick = useCallback(() => {
    const ctx = audioContext;
    const opts = optsRef.current;
    if (!ctx || !opts || !runningRef.current) return;

    const horizon = ctx.currentTime + SCHEDULE_AHEAD_SEC;

    // Schedule all beats whose firing time is within the lookahead horizon.
    // Re-read BPM and offset on each beat so live changes apply on the next
    // beat without phase reset.
    // Safety cap to avoid runaway loops if BPM is misconfigured.
    let safety = 64;
    while (safety-- > 0) {
      const n = beatIndexRef.current;
      const bpm = Math.max(1, opts.getBpm());
      const offset = opts.getOffsetSec();
      const beatTime = t0Ref.current + n * (60 / bpm) + offset;

      if (beatTime > horizon) break;

      // Skip beats that have already passed (e.g. after a long tab freeze).
      if (beatTime >= ctx.currentTime) {
        const accent = !!opts.accentDownbeats && n % 4 === 0;
        scheduleBeat(beatTime, accent);
      }

      beatIndexRef.current = n + 1;
    }
  }, [audioContext, scheduleBeat]);

  const stop = useCallback(() => {
    runningRef.current = false;
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    // Cancel any oscillators that haven't fired yet (or are mid-fire).
    const ctx = audioContext;
    const stopAt = ctx ? ctx.currentTime : 0;
    for (const osc of pendingRef.current) {
      try {
        osc.stop(stopAt);
      } catch {
        // ignore — already stopped
      }
    }
    pendingRef.current.clear();
    optsRef.current = null;
    beatIndexRef.current = 0;
  }, [audioContext]);

  const start = useCallback(
    (opts: MetronomeStartOptions) => {
      const ctx = audioContext;
      if (!ctx) return;
      if (runningRef.current) stop();

      optsRef.current = opts;
      t0Ref.current = ctx.currentTime + START_DELAY_SEC;
      beatIndexRef.current = 0;
      runningRef.current = true;

      // Schedule first batch immediately so beats start on time even before
      // the first interval tick fires.
      tick();
      intervalRef.current = setInterval(tick, LOOKAHEAD_MS);
    },
    [audioContext, stop, tick],
  );

  const setVolume = useCallback((v: number) => {
    volumeRef.current = Math.max(0, v);
  }, []);

  const isRunning = useCallback(() => runningRef.current, []);

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return { start, stop, setVolume, isRunning };
}
