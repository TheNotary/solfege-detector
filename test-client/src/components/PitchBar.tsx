import "./PitchBar.css";

const C3_FREQ = 130.81;
const B3_FREQ = 246.94;
const TOP_PERCENT = 15;
const BOTTOM_PERCENT = 85;

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

  // Map pitch frequency to Y position (same scale as staff lines)
  // C3 (130.81) -> 85% (bottom, do row), B3 (246.94) -> 15% (top, ti row)
  const normalized = (displayPitchHz - C3_FREQ) / (B3_FREQ - C3_FREQ);
  const topPercent = BOTTOM_PERCENT - normalized * (BOTTOM_PERCENT - TOP_PERCENT);
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
