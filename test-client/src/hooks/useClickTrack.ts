import { useCallback, useRef } from "react";

export interface ClickTrackConfig {
  intervalMs?: number;
  totalClicks?: number;
  frequencyHz?: number;
  durationMs?: number;
}

const DEFAULTS = {
  intervalMs: 600,
  totalClicks: 10,
  frequencyHz: 1000,
  durationMs: 20,
};

/**
 * Web Audio click synthesizer for latency calibration.
 *
 * Each click is a short sine burst (default 1000 Hz, 20ms) with a fast
 * gain envelope (1ms attack, 19ms release) for a percussive pop sound.
 *
 * `onClick` fires with the precise AudioContext.currentTime of each click.
 * `onComplete` fires after all clicks have played.
 */
export function useClickTrack(
  onClick: (audioTime: number, index: number) => void,
  onComplete?: () => void,
) {
  const ctxRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<number | null>(null);
  const indexRef = useRef(0);
  const runningRef = useRef(false);

  const stop = useCallback(() => {
    runningRef.current = false;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (ctxRef.current) {
      ctxRef.current.close().catch(() => {});
      ctxRef.current = null;
    }
    indexRef.current = 0;
  }, []);

  const start = useCallback(
    (config?: ClickTrackConfig) => {
      stop();

      const {
        intervalMs = DEFAULTS.intervalMs,
        totalClicks = DEFAULTS.totalClicks,
        frequencyHz = DEFAULTS.frequencyHz,
        durationMs = DEFAULTS.durationMs,
      } = config ?? {};

      const ctx = new AudioContext({ sampleRate: 44100 });
      ctxRef.current = ctx;
      runningRef.current = true;
      indexRef.current = 0;

      const scheduleClick = () => {
        if (!runningRef.current || !ctxRef.current) return;
        const i = indexRef.current;
        if (i >= totalClicks) {
          runningRef.current = false;
          onComplete?.();
          return;
        }

        const now = ctx.currentTime;
        const attackEnd = now + 0.001;
        const releaseEnd = now + durationMs / 1000;

        // Oscillator
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = frequencyHz;

        // Gain envelope
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.6, attackEnd);
        gain.gain.linearRampToValueAtTime(0, releaseEnd);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(releaseEnd + 0.01);

        onClick(now, i);
        indexRef.current = i + 1;

        timerRef.current = window.setTimeout(scheduleClick, intervalMs);
      };

      // Start first click immediately
      scheduleClick();
    },
    [onClick, onComplete, stop],
  );

  return { start, stop, isRunning: () => runningRef.current } as const;
}
