import "./PitchBar.css";
import type { Syllable } from "../hooks/useGameEngine";

const TOP_PERCENT = 15;
const BOTTOM_PERCENT = 85;

export interface NotePoint {
  freq: number;
  y: number;
}

const SOLFEGE_ORDER: readonly Syllable[] = [
  "do", "re", "mi", "fa", "sol", "la", "ti",
];

/**
 * Build a NOTE_POINTS array from dynamic scale frequencies.
 * Maps each syllable to its evenly-spaced Y% (do=85%, ti=15%).
 */
export function buildNotePoints(
  scaleFrequencies: Record<Syllable, number>,
): NotePoint[] {
  return SOLFEGE_ORDER.map((s, i) => ({
    freq: scaleFrequencies[s],
    y: BOTTOM_PERCENT - (i / (SOLFEGE_ORDER.length - 1)) * (BOTTOM_PERCENT - TOP_PERCENT),
  }));
}

/** Map a frequency (Hz) to a Y% using piecewise linear interpolation
 *  through the solfege note positions, matching the evenly-spaced staff lines. */
export function freqToY(hz: number, notePoints: NotePoint[]): number {
  if (notePoints.length === 0) return 50;
  if (hz <= notePoints[0].freq) return notePoints[0].y;
  if (hz >= notePoints[notePoints.length - 1].freq)
    return notePoints[notePoints.length - 1].y;
  for (let i = 0; i < notePoints.length - 1; i++) {
    const lo = notePoints[i];
    const hi = notePoints[i + 1];
    if (hz <= hi.freq) {
      const t = (hz - lo.freq) / (hi.freq - lo.freq);
      return lo.y + t * (hi.y - lo.y);
    }
  }
  return notePoints[notePoints.length - 1].y;
}

interface PitchBarProps {
  displayPitchHz: number | null;
  opacity: number;
  notePoints: NotePoint[];
  /** Horizontal position in percent of the parent container's width.
   *  The bar is centered on this column via a CSS translate(-50%, -50%),
   *  so it visually sits inside the waveform/crosshair stack. */
  x: number;
}

/**
 * Glowing fiery pitch indicator bar that shows detected pitch
 * position aligned to the staff note rows.
 */
export default function PitchBar({ displayPitchHz, opacity, notePoints, x }: PitchBarProps) {
  if (displayPitchHz === null || opacity <= 0.01) {
    return null;
  }

  const topPercent = freqToY(displayPitchHz, notePoints);
  const clampedTop = Math.max(TOP_PERCENT, Math.min(BOTTOM_PERCENT, topPercent));

  return (
    <div
      className="pitch-bar"
      style={{
        left: `${x}%`,
        top: `${clampedTop}%`,
        opacity,
      }}
    />
  );
}
