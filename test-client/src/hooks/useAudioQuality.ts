import { useEffect, useRef, useState } from "react";

const RMS_THRESHOLD = 0.015;
const SPECTRAL_FLATNESS_THRESHOLD = 0.5;

interface UseAudioQualityReturn {
  isQualitySample: boolean;
  rms: number;
  spectralFlatness: number;
}

/**
 * Computes audio quality metrics (RMS energy and spectral flatness)
 * from a shared AnalyserNode to determine if the current audio
 * contains a quality tonal signal vs silence/noise/clicks.
 */
export function useAudioQuality(
  analyserNode: AnalyserNode | null
): UseAudioQualityReturn {
  const [rms, setRms] = useState(0);
  const [spectralFlatness, setSpectralFlatness] = useState(1);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!analyserNode) return;

    const timeDomainBuffer = new Float32Array(analyserNode.fftSize);
    const frequencyBuffer = new Float32Array(analyserNode.frequencyBinCount);

    const update = () => {
      analyserNode.getFloatTimeDomainData(timeDomainBuffer);
      analyserNode.getFloatFrequencyData(frequencyBuffer);

      // Compute RMS energy
      let sumSq = 0;
      for (let i = 0; i < timeDomainBuffer.length; i++) {
        sumSq += timeDomainBuffer[i] * timeDomainBuffer[i];
      }
      const currentRms = Math.sqrt(sumSq / timeDomainBuffer.length);

      // Compute spectral flatness (geometric mean / arithmetic mean of magnitudes)
      // frequencyBuffer is in dB, convert to linear magnitudes
      let logSum = 0;
      let linearSum = 0;
      let binCount = 0;
      for (let i = 0; i < frequencyBuffer.length; i++) {
        // Convert dB to linear magnitude, clamp minimum
        const linear = Math.max(1e-10, Math.pow(10, frequencyBuffer[i] / 20));
        logSum += Math.log(linear);
        linearSum += linear;
        binCount++;
      }

      let currentFlatness = 1;
      if (binCount > 0 && linearSum > 0) {
        const geometricMean = Math.exp(logSum / binCount);
        const arithmeticMean = linearSum / binCount;
        currentFlatness = geometricMean / arithmeticMean;
      }

      setRms(currentRms);
      setSpectralFlatness(currentFlatness);

      rafRef.current = requestAnimationFrame(update);
    };

    rafRef.current = requestAnimationFrame(update);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [analyserNode]);

  const isQualitySample =
    rms >= RMS_THRESHOLD && spectralFlatness < SPECTRAL_FLATNESS_THRESHOLD;

  return { isQualitySample, rms, spectralFlatness };
}
