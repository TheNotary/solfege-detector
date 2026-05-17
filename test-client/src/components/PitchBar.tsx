import "./PitchBar.css";

const TOP_PERCENT = 15;
const BOTTOM_PERCENT = 85;

/**
 * Piecewise-linear lookup: each note's target frequency paired with
 * its evenly-spaced Y% from syllableY() (do=85%, ti=15%, 11.667% apart).
 * Sorted ascending by frequency.
 */
const NOTE_POINTS: { freq: number; y: number }[] = [
  { freq: 130.81, y: 85 },          // do
  { freq: 146.83, y: 73.333333 },   // re
  { freq: 164.81, y: 61.666667 },   // mi
  { freq: 174.61, y: 50 },          // fa
  { freq: 196.0,  y: 38.333333 },   // sol
  { freq: 220.0,  y: 26.666667 },   // la
  { freq: 246.94, y: 15 },          // ti
];

/** Map a frequency (Hz) to a Y% using piecewise linear interpolation
 *  through the solfege note positions, matching the evenly-spaced staff lines. */
export function freqToY(hz: number): number {
  if (hz <= NOTE_POINTS[0].freq) return NOTE_POINTS[0].y;
  if (hz >= NOTE_POINTS[NOTE_POINTS.length - 1].freq)
    return NOTE_POINTS[NOTE_POINTS.length - 1].y;
  for (let i = 0; i < NOTE_POINTS.length - 1; i++) {
    const lo = NOTE_POINTS[i];
    const hi = NOTE_POINTS[i + 1];
    if (hz <= hi.freq) {
      const t = (hz - lo.freq) / (hi.freq - lo.freq);
      return lo.y + t * (hi.y - lo.y);
    }
  }
  return NOTE_POINTS[NOTE_POINTS.length - 1].y;
}

interface PitchBarProps {
  displayPitchHz: number | null;
  opacity: number;
}

/**
 * Glowing fiery pitch indicator bar that shows detected pitch
 * position aligned to the staff note rows.
 */
export default function PitchBar({ displayPitchHz, opacity }: PitchBarProps) {
  if (displayPitchHz === null || opacity <= 0.01) {
    return null;
  }

  const topPercent = freqToY(displayPitchHz);
  const clampedTop = Math.max(TOP_PERCENT, Math.min(BOTTOM_PERCENT, topPercent));

  return (
    <div
      className="pitch-bar"
      style={{
        top: `${clampedTop}%`,
        opacity,
      }}
    />
  );
}
