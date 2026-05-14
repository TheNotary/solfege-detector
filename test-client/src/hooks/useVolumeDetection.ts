import { useCallback, useRef, useState } from "react";

const VOLUME_THRESHOLD = 0.02;

interface UseVolumeDetectionReturn {
  volume: number;
  isSounding: boolean;
  onVolume: (rms: number) => void;
}

export function useVolumeDetection(): UseVolumeDetectionReturn {
  const [volume, setVolume] = useState(0);
  const [isSounding, setIsSounding] = useState(false);
  const rafRef = useRef<number | null>(null);
  const latestRef = useRef(0);

  const onVolume = useCallback((rms: number) => {
    latestRef.current = rms;
    // Throttle state updates to animation frames to avoid excessive re-renders
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const v = latestRef.current;
        setVolume(v);
        setIsSounding(v > VOLUME_THRESHOLD);
      });
    }
  }, []);

  return { volume, isSounding, onVolume };
}
