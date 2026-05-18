/**
 * Vocal-range bandpass primitive used by the display-side audio paths
 * (waveform, onset detector, volume / hit-zone). Sub-bass rumble (e.g. a
 * passing thunderstorm) and high-frequency noise would otherwise trip
 * onset detection and confetti even though no syllable was sung; filtering
 * to roughly the human singing range suppresses that.
 *
 * The backend training audio (the raw PCM streamed over the WebSocket and
 * the per-note capture written under `recorded_notes/`) is intentionally
 * NOT filtered with this primitive — the acoustic model is trained on the
 * full spectrum.
 *
 * Implementation: four cascaded RBJ-cookbook biquads — two highpass stages
 * at {@link VOCAL_LOWCUT_HZ} and two lowpass stages at
 * {@link VOCAL_HIGHCUT_HZ}, each with Q = {@link VOCAL_BANDPASS_Q}. Two
 * stages per band gives a 4th-order rolloff (~24 dB/octave) so that sub-bass
 * thunder energy near 20–40 Hz is reliably suppressed; a single 2nd-order
 * stage only attenuates 40 Hz by ~12 dB, which empirically isn't enough.
 * Cascaded HP+LP rather than a single `bandpass` because the
 * Q-parameterization of bandpass doesn't cleanly express the corners we
 * want.
 */

/** Lower corner (-3 dB) of the vocal-range bandpass, in Hz. */
export const VOCAL_LOWCUT_HZ = 80;
/** Upper corner (-3 dB) of the vocal-range bandpass, in Hz. */
export const VOCAL_HIGHCUT_HZ = 1100;
/** Butterworth-equivalent Q for both biquads (≈ 0.707 → maximally flat). */
export const VOCAL_BANDPASS_Q = Math.SQRT1_2;

/** Direct-Form II Transpose biquad state: two delay registers. */
interface BiquadState {
  /** Coefficients normalized so a0 = 1. */
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  /** Delay registers. */
  z1: number;
  z2: number;
}

function makeHighpass(sampleRate: number, cutoffHz: number, q: number): BiquadState {
  // RBJ cookbook HPF
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cosw0) / 2) / a0,
    b1: (-(1 + cosw0)) / a0,
    b2: ((1 + cosw0) / 2) / a0,
    a1: (-2 * cosw0) / a0,
    a2: (1 - alpha) / a0,
    z1: 0,
    z2: 0,
  };
}

function makeLowpass(sampleRate: number, cutoffHz: number, q: number): BiquadState {
  // RBJ cookbook LPF
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cosw0) / 2) / a0,
    b1: (1 - cosw0) / a0,
    b2: ((1 - cosw0) / 2) / a0,
    a1: (-2 * cosw0) / a0,
    a2: (1 - alpha) / a0,
    z1: 0,
    z2: 0,
  };
}

/**
 * Process a single sample through a biquad in Direct-Form II Transpose,
 * updating the state's delay registers in place. Inlined into the hot loop
 * for speed.
 */
function processOne(s: BiquadState, x: number): number {
  const y = s.b0 * x + s.z1;
  s.z1 = s.b1 * x - s.a1 * y + s.z2;
  s.z2 = s.b2 * x - s.a2 * y;
  return y;
}

/**
 * Build a stateful vocal-range bandpass filter. The returned function
 * processes a {@link Float32Array} of samples and returns a fresh
 * {@link Float32Array} of the same length. Per-stage delay registers are
 * preserved across calls so streaming many short frames produces the same
 * output as filtering one long buffer.
 *
 * The input is never mutated.
 */
export function createVocalBandpassFilter(
  sampleRate: number,
): (samples: Float32Array) => Float32Array {
  const hp1 = makeHighpass(sampleRate, VOCAL_LOWCUT_HZ, VOCAL_BANDPASS_Q);
  const hp2 = makeHighpass(sampleRate, VOCAL_LOWCUT_HZ, VOCAL_BANDPASS_Q);
  const lp1 = makeLowpass(sampleRate, VOCAL_HIGHCUT_HZ, VOCAL_BANDPASS_Q);
  const lp2 = makeLowpass(sampleRate, VOCAL_HIGHCUT_HZ, VOCAL_BANDPASS_Q);
  return (samples: Float32Array): Float32Array => {
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      out[i] = processOne(lp2, processOne(lp1, processOne(hp2, processOne(hp1, samples[i]))));
    }
    return out;
  };
}

/** Handle returned by {@link connectVocalBandpassNodes}. */
export interface VocalBandpassNodes {
  /** The cascaded biquad stages, in graph order (hp, hp, lp, lp). */
  stages: readonly BiquadFilterNode[];
  /**
   * Disconnect every edge owned by the chain (source→first stage,
   * stage→stage, last stage→destination). Safe to call multiple times;
   * subsequent calls are no-ops.
   */
  disconnect: () => void;
}

/**
 * Build a Web Audio bandpass chain matching {@link createVocalBandpassFilter}
 * (two highpass + two lowpass biquads) and splice it between `source` and
 * `destination`. Returns a handle that tears the chain down without
 * disturbing the caller's nodes.
 *
 * The caller is responsible for ensuring no other edges into `destination`
 * are live at the same time — this helper does not disconnect existing
 * connections.
 */
export function connectVocalBandpassNodes(
  ctx: AudioContext,
  source: AudioNode,
  destination: AudioNode,
): VocalBandpassNodes {
  const mk = (type: BiquadFilterType, freq: number): BiquadFilterNode => {
    const n = ctx.createBiquadFilter();
    n.type = type;
    n.frequency.value = freq;
    n.Q.value = VOCAL_BANDPASS_Q;
    return n;
  };
  const stages: BiquadFilterNode[] = [
    mk("highpass", VOCAL_LOWCUT_HZ),
    mk("highpass", VOCAL_LOWCUT_HZ),
    mk("lowpass", VOCAL_HIGHCUT_HZ),
    mk("lowpass", VOCAL_HIGHCUT_HZ),
  ];

  source.connect(stages[0]);
  for (let i = 0; i < stages.length - 1; i++) {
    stages[i].connect(stages[i + 1]);
  }
  stages[stages.length - 1].connect(destination);

  let disconnected = false;
  return {
    stages,
    disconnect: () => {
      if (disconnected) return;
      disconnected = true;
      try { source.disconnect(stages[0]); } catch { /* ignore */ }
      for (let i = 0; i < stages.length - 1; i++) {
        try { stages[i].disconnect(stages[i + 1]); } catch { /* ignore */ }
      }
      try { stages[stages.length - 1].disconnect(destination); } catch { /* ignore */ }
    },
  };
}
