import { useEffect, useRef, useState } from "react";
import { PitchDetector } from "pitchy";

const CLARITY_THRESHOLD = 0.8;
const RMS_THRESHOLD = 0.015;

interface UsePitchDetectionReturn {
  pitchHz: number | null;
  clarity: number;
}

/**
 * Real-time pitch detection using pitchy's YIN algorithm.
 * Reads from a shared AnalyserNode at ~60fps and returns the detected
 * fundamental frequency and clarity (confidence 0-1).
 */
export function usePitchDetection(
  analyserNode: AnalyserNode | null
): UsePitchDetectionReturn {
  const [pitchHz, setPitchHz] = useState<number | null>(null);
  const [clarity, setClarity] = useState(0);
  const rafRef = useRef<number | null>(null);
  const detectorRef = useRef<PitchDetector<Float32Array> | null>(null);

  useEffect(() => {
    if (!analyserNode) return;

    const bufferSize = analyserNode.fftSize;
    const inputBuffer = new Float32Array(bufferSize);
    detectorRef.current = PitchDetector.forFloat32Array(bufferSize);

    const update = () => {
      analyserNode.getFloatTimeDomainData(inputBuffer);

      // Check RMS - skip pitch detection if too quiet
      let sumSq = 0;
      for (let i = 0; i < inputBuffer.length; i++) {
        sumSq += inputBuffer[i] * inputBuffer[i];
      }
      const rms = Math.sqrt(sumSq / inputBuffer.length);

      if (rms < RMS_THRESHOLD) {
        setPitchHz(null);
        setClarity(0);
      } else {
        const detector = detectorRef.current!;
        const [pitch, clar] = detector.findPitch(
          inputBuffer,
          analyserNode.context.sampleRate
        );

        if (clar >= CLARITY_THRESHOLD && pitch > 0) {
          setPitchHz(pitch);
          setClarity(clar);
        } else {
          setPitchHz(null);
          setClarity(clar);
        }
      }

      rafRef.current = requestAnimationFrame(update);
    };

    rafRef.current = requestAnimationFrame(update);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      detectorRef.current = null;
    };
  }, [analyserNode]);

  return { pitchHz, clarity };
}
