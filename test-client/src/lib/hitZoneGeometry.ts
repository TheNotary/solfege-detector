/** Crosshair position as % from the left edge. */
export const CROSSHAIR_X = 20;
/** Half-width of the hit zone around the crosshair (%). */
export const HIT_ZONE_HALF = 6;

export interface HitZoneGeometryInput {
  /** Notes per minute. */
  bpm: number;
  /** Microphone input latency in ms. */
  audioLatencyMs: number;
  /** Monitor/display latency in ms. */
  displayLatencyMs: number;
  /** Container width in pixels (used to compute halfPct from crosshairHalfPx).
   *  When omitted, halfPct defaults to HIT_ZONE_HALF. */
  containerWidthPx?: number;
  /** Half-width of the crosshair visual element in pixels (default 80). */
  crosshairHalfPx?: number;
}

export interface HitZoneGeometry {
  /** The effective center of the hit zone (%), shifted right by latency. */
  effectiveCenter: number;
  /** Half-width of the hit zone in %. */
  halfPct: number;
  /** The latency-induced offset in percentage points (0 when no latency). */
  offsetPct: number;
  /** The unshifted crosshair position (always CROSSHAIR_X). */
  crosshairX: number;
}

/**
 * Pure function that computes hit-zone geometry from game parameters.
 *
 * Encapsulates the math shared between the debug overlay in GameView and
 * the hit-detection logic in useGameEngine so there is a single source of
 * truth that can be unit-tested independently.
 */
export function computeHitZoneGeometry(input: HitZoneGeometryInput): HitZoneGeometry {
  const { bpm, audioLatencyMs, displayLatencyMs, containerWidthPx, crosshairHalfPx = 80 } = input;

  const spawnInterval = 60 / bpm;
  const travelTime = spawnInterval * 3; // seconds to cross 110% width
  const pctPerMs = 110 / (travelTime * 1000);

  const latencyMs = audioLatencyMs + displayLatencyMs;
  const offsetPct = latencyMs * pctPerMs;
  // Notes slide right→left.  Positive latency means sound/perception arrives
  // AFTER the note crossed the visual crosshair, so the note has moved
  // further LEFT by the time we evaluate the hit — shift effective center
  // LEFT to compensate.
  const effectiveCenter = CROSSHAIR_X - offsetPct;

  let halfPct: number;
  if (containerWidthPx != null && containerWidthPx > 0) {
    // Derive half-width directly from the visual crosshair pixel width so
    // the debug hit-zone is geometrically identical to the on-screen
    // .crosshair-zone box at every viewport width.  The HIT_ZONE_HALF cap
    // used to live here as a safety net but produced a visible width
    // mismatch on narrow viewports — see #109.
    halfPct = (crosshairHalfPx / containerWidthPx) * 100;
  } else {
    halfPct = HIT_ZONE_HALF;
  }

  return { effectiveCenter, halfPct, offsetPct, crosshairX: CROSSHAIR_X };
}
