import { useCallback, useRef } from "react";

/** Detected onset event within a capture window. */
export interface OnsetEvent {
  /** Time in milliseconds relative to capture start. */
  timeMs: number;
  /** RMS energy at the onset. */
  rmsEnergy: number;
}

/** Minimum RMS derivative to qualify as an onset. */
const DEFAULT_ONSET_THRESHOLD = 0.03;
/** Minimum time between onsets in ms (debounce). */
const DEFAULT_MIN_ONSET_GAP_MS = 100;
/** RMS computation window in samples. */
const RMS_WINDOW_SAMPLES = 1024;

const TARGET_SAMPLE_RATE = 44_100;

/**
 * Energy-envelope onset detector for audio capture windows.
 *
 * Detects onsets by monitoring RMS energy derivatives (spikes).
 * Used to trim per-note audio captures when multiple syllables bleed into one window.
 */
export function useOnsetDetection(options?: {
  onsetThreshold?: number;
  minOnsetGapMs?: number;
  onOnset?: (onset: OnsetEvent) => void;
}) {
  const threshold = options?.onsetThreshold ?? DEFAULT_ONSET_THRESHOLD;
  const minGapMs = options?.minOnsetGapMs ?? DEFAULT_MIN_ONSET_GAP_MS;
  const onOnsetRef = useRef(options?.onOnset);
  onOnsetRef.current = options?.onOnset;

  const onsetsRef = useRef<OnsetEvent[]>([]);
  const prevRmsRef = useRef(0);
  const lastOnsetMsRef = useRef(-Infinity);
  const captureStartTimeRef = useRef(0);

  /** Reset state at the start of a new note capture. */
  const resetOnsets = useCallback(() => {
    onsetsRef.current = [];
    prevRmsRef.current = 0;
    lastOnsetMsRef.current = -Infinity;
    captureStartTimeRef.current = performance.now();
  }, []);

  /**
   * Feed a chunk of Float32 audio samples to the onset detector.
   * Call this from the onaudioprocess callback during active capture.
   */
  const feedSamples = useCallback(
    (samples: Float32Array) => {
      const now = performance.now();
      const timeMs = now - captureStartTimeRef.current;

      // Compute RMS of this chunk
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        sum += samples[i] * samples[i];
      }
      const rms = Math.sqrt(sum / samples.length);

      // Detect onset: significant positive RMS derivative
      const derivative = rms - prevRmsRef.current;
      prevRmsRef.current = rms;

      if (
        derivative > threshold &&
        timeMs - lastOnsetMsRef.current > minGapMs
      ) {
        const onset: OnsetEvent = { timeMs, rmsEnergy: rms };
        onsetsRef.current.push(onset);
        lastOnsetMsRef.current = timeMs;
        onOnsetRef.current?.(onset);
      }
    },
    [threshold, minGapMs]
  );

  /** Get all detected onsets in the current capture window. */
  const getOnsets = useCallback((): OnsetEvent[] => {
    return [...onsetsRef.current];
  }, []);

  /**
   * Trim an audio buffer to keep only the segment around the onset nearest
   * to the target time (typically the crosshair center moment).
   *
   * @param audioBuffer - Int16 PCM ArrayBuffer from stopNoteCapture
   * @param targetTimeMs - The ideal onset time relative to capture start
   * @param windowMs - How much audio to keep around the onset (default 500ms)
   * @returns Trimmed Int16 PCM ArrayBuffer, or the original if 0-1 onsets
   */
  const trimToNearestOnset = useCallback(
    (
      audioBuffer: ArrayBuffer,
      targetTimeMs: number,
      windowMs: number = 500
    ): ArrayBuffer => {
      const onsets = onsetsRef.current;
      if (onsets.length <= 1) {
        // No trimming needed — 0 or 1 onset means single syllable
        return audioBuffer;
      }

      // Find the onset closest to targetTimeMs
      let closest = onsets[0];
      let minDist = Math.abs(onsets[0].timeMs - targetTimeMs);
      for (let i = 1; i < onsets.length; i++) {
        const dist = Math.abs(onsets[i].timeMs - targetTimeMs);
        if (dist < minDist) {
          minDist = dist;
          closest = onsets[i];
        }
      }

      // Calculate sample range to keep
      const totalDurationMs =
        (audioBuffer.byteLength / 2) / TARGET_SAMPLE_RATE * 1000;
      const captureDurationMs = totalDurationMs;

      // onset time as fraction of capture → sample position
      const onsetFraction = closest.timeMs / captureDurationMs;
      const totalSamples = audioBuffer.byteLength / 2; // Int16 = 2 bytes per sample
      const onsetSample = Math.floor(onsetFraction * totalSamples);

      const halfWindowSamples = Math.floor(
        (windowMs / 2 / 1000) * TARGET_SAMPLE_RATE
      );
      const startSample = Math.max(0, onsetSample - halfWindowSamples);
      const endSample = Math.min(totalSamples, onsetSample + halfWindowSamples);

      // Extract the trimmed range
      const int16View = new Int16Array(audioBuffer);
      const trimmed = int16View.slice(startSample, endSample);
      return trimmed.buffer;
    },
    []
  );

  return {
    resetOnsets,
    feedSamples,
    getOnsets,
    trimToNearestOnset,
  };
}
