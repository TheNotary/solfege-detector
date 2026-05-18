/**
 * Bulk speaker -> mic delay calibration via normalized cross-correlation.
 *
 * The AEC's adaptive filter only has ~5–10 ms of "wiggle room" inside its
 * 256-tap FIR window. A laptop's real speaker -> mic round trip is typically
 * 10–30 ms, which means an uncalibrated `audioLatencyMs = 0` setting leaves
 * the bulk delay completely outside the filter's reach for transient
 * signals (metronome clicks). A sustained drone still gets canceled because
 * the FIR can encode any phase shift; transients can't.
 *
 * This module reduces the problem to: given paired mic + reference sample
 * arrays of equal length, what integer sample lag d (>= 0) maximizes the
 * normalized cross-correlation
 *
 *     C(d) = sum_i mic[i] * ref[i - d]
 *            / sqrt( sum_i mic[i]^2 * sum_i ref[i - d]^2 )
 *
 * over a candidate range [minSamples, maxSamples]? That lag is the bulk
 * delay; feed it into `aec.setDelayMs` and clicks will start canceling.
 *
 * The output also reports a `confidence` ratio (peak / median over the
 * candidate range). Callers should reject results below ~3 because they
 * usually indicate the reference channel was silent or the mic only saw
 * unrelated noise during the calibration window.
 */

export interface MeasureBulkDelayOptions {
  /** Minimum candidate lag in samples (inclusive). Default 0. */
  minSamples?: number;
  /** Maximum candidate lag in samples (inclusive). Default 4410 (~100 ms @ 44.1 kHz). */
  maxSamples?: number;
}

export interface MeasureBulkDelayResult {
  /** Best-fit bulk delay in samples (mic relative to reference). */
  delaySamples: number;
  /** Normalized cross-correlation at the chosen lag (in [-1, 1]). */
  peakCorrelation: number;
  /**
   * Ratio of the peak correlation magnitude to the median correlation
   * magnitude across the candidate range. A larger number means the peak
   * stood out clearly above the noise floor of unrelated lags.
   *
   * As a rule of thumb, accept >= 3, reject < 2.
   */
  confidence: number;
}

/**
 * Measure the bulk delay between paired mic + reference signals via a
 * normalized cross-correlation scan.
 *
 * Pre-conditions:
 * - `mic.length === ref.length` and both are at least
 *   `(maxSamples - minSamples) + 64` samples long. (We need enough overlap
 *   at the largest candidate lag to compute a meaningful correlation.)
 * - The signals should overlap: i.e. the reference plays through the
 *   speakers and the mic captures the leakage during the window.
 *
 * The cost is O(N * (maxSamples - minSamples + 1)) — a few million FLOPs
 * for the default range and a ~2000-sample window. Fine for an interactive
 * one-shot warmup; do not call from `process()`.
 */
export function measureBulkDelaySamples(
  mic: Float32Array,
  ref: Float32Array,
  options: MeasureBulkDelayOptions = {},
): MeasureBulkDelayResult {
  if (mic.length !== ref.length) {
    throw new Error(
      `measureBulkDelaySamples: mic.length (${mic.length}) must equal ref.length (${ref.length})`,
    );
  }
  const minD = Math.max(0, Math.floor(options.minSamples ?? 0));
  const maxD = Math.floor(options.maxSamples ?? 4410);
  if (maxD < minD) {
    throw new Error(
      `measureBulkDelaySamples: maxSamples (${maxD}) must be >= minSamples (${minD})`,
    );
  }
  const N = mic.length;
  if (N <= maxD + 8) {
    throw new Error(
      `measureBulkDelaySamples: window too short (${N} samples) for maxSamples=${maxD}; ` +
        `need at least ${maxD + 9} samples`,
    );
  }

  // Pre-compute mic energy over the overlap range used for every lag (i in
  // [maxD, N-1]), so the mic energy term doesn't depend on d.
  let micEnergy = 0;
  for (let i = maxD; i < N; i++) micEnergy += mic[i] * mic[i];
  if (micEnergy <= 0) {
    return { delaySamples: minD, peakCorrelation: 0, confidence: 0 };
  }

  const candidateCount = maxD - minD + 1;
  const corrs = new Float32Array(candidateCount);
  let bestD = minD;
  let bestAbs = -1;
  let bestSigned = 0;

  for (let d = minD; d <= maxD; d++) {
    let dot = 0;
    let refEnergy = 0;
    for (let i = maxD; i < N; i++) {
      const r = ref[i - d];
      dot += mic[i] * r;
      refEnergy += r * r;
    }
    const denom = Math.sqrt(micEnergy * refEnergy);
    const c = denom > 1e-20 ? dot / denom : 0;
    corrs[d - minD] = c;
    const a = Math.abs(c);
    if (a > bestAbs) {
      bestAbs = a;
      bestD = d;
      bestSigned = c;
    }
  }

  // Confidence = peak / median of absolute correlations.
  const sortedAbs = new Float32Array(candidateCount);
  for (let i = 0; i < candidateCount; i++) sortedAbs[i] = Math.abs(corrs[i]);
  sortedAbs.sort();
  const median = sortedAbs[Math.floor(candidateCount / 2)];
  let confidence: number;
  if (bestAbs <= 1e-12) {
    // No correlation anywhere → degenerate case (e.g. silent reference).
    confidence = 0;
  } else if (median > 1e-12) {
    confidence = bestAbs / median;
  } else {
    // Peak exists but the rest of the search range is essentially zero —
    // an extremely sharp pick, but cap it so callers can compare against
    // a finite threshold.
    confidence = 1000;
  }

  return {
    delaySamples: bestD,
    peakCorrelation: bestSigned,
    confidence,
  };
}

/** Convenience: convert a delay-in-samples result to milliseconds. */
export function samplesToMs(samples: number, sampleRate: number): number {
  return (samples / sampleRate) * 1000;
}
