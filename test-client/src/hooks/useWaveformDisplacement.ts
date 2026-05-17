import { useEffect, useRef, useState } from "react";

/** How many milliseconds of history to average over. */
const WINDOW_MS = 50;

/** Noise gate threshold (must match WaveformCrosshair). */
const NOISE_GATE_THRESHOLD = 0.015;

/** Compressor parameters (must match WaveformCrosshair). */
const COMP_KNEE = 0.15;
const COMP_RATIO = 4;

function compress(v: number): number {
  const sign = v < 0 ? -1 : 1;
  const abs = Math.abs(v);
  if (abs <= COMP_KNEE) {
    const gain = 1 + (1 - COMP_KNEE) / (COMP_KNEE * COMP_RATIO);
    return sign * Math.min(abs * gain, 1);
  }
  const compressed = COMP_KNEE + (abs - COMP_KNEE) / COMP_RATIO;
  const kneeOut = COMP_KNEE + (1 - COMP_KNEE) / COMP_RATIO;
  return sign * Math.min(compressed / kneeOut, 1);
}

/**
 * Tracks the waveform's average absolute displacement (0–1, normalised)
 * over the last {@link WINDOW_MS} milliseconds, using the same compressor
 * and noise-gate as {@link WaveformCrosshair}.
 *
 * Returns 0 when the gate is closed (ambient noise only).
 */
export function useWaveformDisplacement(
  analyserNode: AnalyserNode | null,
  isRecording: boolean,
): number {
  const [displacement, setDisplacement] = useState(0);
  const bufferRef = useRef<Uint8Array | null>(null);
  const historyRef = useRef<{ t: number; avg: number }[]>([]);

  useEffect(() => {
    if (!analyserNode || !isRecording) {
      setDisplacement(0);
      return;
    }

    if (!bufferRef.current) {
      bufferRef.current = new Uint8Array(analyserNode.frequencyBinCount);
    }

    let raf = 0;

    const update = () => {
      const data = bufferRef.current!;
      analyserNode.getByteTimeDomainData(data);
      const len = data.length;

      // RMS for noise gate
      let sumSq = 0;
      for (let i = 0; i < len; i++) {
        const s = (data[i] - 128) / 128;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / len);

      let frameAvg = 0;
      if (rms >= NOISE_GATE_THRESHOLD) {
        // Mean absolute compressed displacement (0–1)
        let absSum = 0;
        for (let i = 0; i < len; i++) {
          const linear = (data[i] - 128) / 128;
          absSum += Math.abs(compress(linear));
        }
        frameAvg = absSum / len;
      }

      const now = performance.now();
      const history = historyRef.current;
      history.push({ t: now, avg: frameAvg });

      // Trim entries older than WINDOW_MS
      while (history.length > 0 && now - history[0].t > WINDOW_MS) {
        history.shift();
      }

      // Average over the window
      let sum = 0;
      for (let i = 0; i < history.length; i++) {
        sum += history[i].avg;
      }
      setDisplacement(history.length > 0 ? sum / history.length : 0);

      raf = requestAnimationFrame(update);
    };

    raf = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(raf);
      historyRef.current = [];
    };
  }, [analyserNode, isRecording]);

  return displacement;
}
