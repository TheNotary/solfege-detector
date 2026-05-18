/**
 * Schedules N short white-noise bursts that are routed to BOTH the audible
 * `ctx.destination` and the AEC `refMix` tap. Used as a deterministic
 * calibration probe so bulk-delay measurement doesn't depend on the user
 * having started the drone or enabled the metronome.
 *
 * Broadband noise (NOT a pure tone) is used because cross-correlation of a
 * pure tone with its echo is periodic with the tone's period — a 1500 Hz
 * tone repeats every ~29 samples at 44.1 kHz, so peaks appear at lag 0,
 * 14, 28, 42, ... and the algorithm can't tell which cycle holds the true
 * delay. Broadband noise has a delta-like autocorrelation, so the
 * cross-correlation has a single sharp peak at the true speaker→mic
 * round-trip delay.
 *
 * Returns the audio time at which the last burst finishes, so the caller
 * can schedule its capture window to overlap the probe + a comfortable
 * round-trip margin.
 */
export function emitCalibrationProbe(
  ctx: AudioContext,
  refMix: AudioNode,
  options: { volume?: number; offsetsSec?: number[]; burstMs?: number } = {},
): number {
  // Louder than a normal click: we want the speaker echo to clear the
  // mic noise floor (~ -45 dBFS on laptop mics) by a comfortable margin.
  // -6 dBFS at source + ~30 dB acoustic loss → ~-36 dBFS at mic, ~10 dB
  // above noise floor.
  const volume = options.volume ?? 0.5;
  // Four staggered bursts across the capture window so the cross-correlator
  // gets multiple independent chances. 80 ms spacing keeps each burst's
  // echo (~10-30 ms) well separated from the next burst.
  const offsetsSec = options.offsetsSec ?? [0.04, 0.12, 0.2, 0.28];
  // Burst length: long enough to contain meaningful broadband energy
  // (~10 ms = 441 samples @ 44.1 kHz → frequencies down to ~100 Hz are
  // represented), short enough that its own autocorrelation lobe (±burst
  // length) is narrow relative to the search range.
  const burstSec = (options.burstMs ?? 10) / 1000;

  // Generate one shared white-noise AudioBuffer; each burst gets its own
  // BufferSourceNode pointing at this buffer. Using the *same* buffer for
  // every burst means each burst correlates against the same reference
  // pattern — the cross-correlator effectively sees N identical pulses
  // and integrates them.
  const burstSamples = Math.max(1, Math.floor(burstSec * ctx.sampleRate));
  const noiseBuffer = ctx.createBuffer(1, burstSamples, ctx.sampleRate);
  const noiseData = noiseBuffer.getChannelData(0);
  for (let i = 0; i < burstSamples; i++) {
    // Uniform white noise in [-1, 1]; the per-burst gain envelope below
    // scales this down to the requested `volume`.
    noiseData[i] = Math.random() * 2 - 1;
  }

  const t0 = ctx.currentTime;
  let lastEnd = t0;
  for (const offset of offsetsSec) {
    const when = t0 + offset;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const gain = ctx.createGain();
    // Short attack/release so the burst isn't a hard click (which would
    // ring the speaker tweeters); the noise itself is broadband so we
    // don't need extra HF content from a hard edge.
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(volume, when + 0.001);
    gain.gain.setValueAtTime(volume, when + burstSec - 0.001);
    gain.gain.linearRampToValueAtTime(0, when + burstSec);
    src.connect(gain);
    gain.connect(ctx.destination);
    try {
      gain.connect(refMix);
    } catch {
      // ignore if refMix is from a foreign context (shouldn't happen)
    }
    src.start(when);
    const end = when + burstSec + 0.005;
    src.stop(end);
    if (end > lastEnd) lastEnd = end;
    src.onended = () => {
      try {
        src.disconnect();
        gain.disconnect();
      } catch {
        // already disconnected
      }
    };
  }
  return lastEnd;
}
