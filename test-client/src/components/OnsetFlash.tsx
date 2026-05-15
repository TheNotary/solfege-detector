import { useEffect, useRef, useState } from "react";
import "./OnsetFlash.css";

interface OnsetMarker {
  id: number;
  createdAt: number;
}

const FLASH_DURATION_MS = 500;

interface OnsetFlashProps {
  /** Number of onsets detected so far in current capture. Triggers a flash on increase. */
  onsetCount: number;
  /** Whether the game is running (only show when active). */
  active: boolean;
}

/**
 * Renders a brief flash indicator on the crosshair whenever a new onset is detected.
 * Each flash fades out over 500ms.
 */
export default function OnsetFlash({ onsetCount, active }: OnsetFlashProps) {
  const [markers, setMarkers] = useState<OnsetMarker[]>([]);
  const prevCountRef = useRef(0);
  const nextIdRef = useRef(0);

  useEffect(() => {
    if (!active) {
      prevCountRef.current = 0;
      setMarkers([]);
      return;
    }

    if (onsetCount > prevCountRef.current) {
      const now = performance.now();
      const newMarker: OnsetMarker = {
        id: nextIdRef.current++,
        createdAt: now,
      };
      setMarkers((prev) => [...prev, newMarker]);

      // Schedule removal after fade
      setTimeout(() => {
        setMarkers((prev) => prev.filter((m) => m.id !== newMarker.id));
      }, FLASH_DURATION_MS);
    }
    prevCountRef.current = onsetCount;
  }, [onsetCount, active]);

  if (!active || markers.length === 0) return null;

  return (
    <>
      {markers.map((m) => (
        <div key={m.id} className="onset-flash" />
      ))}
    </>
  );
}
