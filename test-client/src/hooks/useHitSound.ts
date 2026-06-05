import { useCallback, useRef } from "react";

const DEFAULT_VOLUME = 0.3;

/**
 * Synthesized "pop/chime" sound that fires when a note is hit.
 * Produces a short, playful pitch-bent tone at the given frequency.
 *
 * When `monitorNode` is provided, the sound is connected to both
 * `ctx.destination` (audible) and the monitor node (AEC reference),
 * preventing the hit sound from triggering false pitch detections.
 */
export function useHitSound(
  audioContext: AudioContext | null,
  monitorNode: AudioNode | null = null,
): { playHitSound: (frequencyHz: number) => void; setHitSoundVolume: (v: number) => void } {
  const volumeRef = useRef(DEFAULT_VOLUME);
  const monitorRef = useRef<AudioNode | null>(monitorNode);
  monitorRef.current = monitorNode;

  const setHitSoundVolume = useCallback((v: number) => {
    volumeRef.current = Math.max(0, Math.min(1, v));
  }, []);

  const playHitSound = useCallback(
    (frequencyHz: number) => {
      if (!audioContext || audioContext.state !== "running") return;

      const now = audioContext.currentTime;
      const dur = 0.55; // total duration — longer tail
      const freq = frequencyHz * 4; // +2 octaves for a bright, playful register

      // Master gain — quick attack, sustain, then slow decay
      const masterGain = audioContext.createGain();
      masterGain.gain.setValueAtTime(0, now);
      masterGain.gain.linearRampToValueAtTime(volumeRef.current, now + 0.005);
      masterGain.gain.setValueAtTime(volumeRef.current, now + 0.15);
      masterGain.gain.exponentialRampToValueAtTime(0.001, now + dur);

      // Connect to destination + monitor (AEC reference)
      masterGain.connect(audioContext.destination);
      if (monitorRef.current) {
        masterGain.connect(monitorRef.current);
      }

      // --- Primary tone: triangle wave for warm, tonal character ---
      const osc1 = audioContext.createOscillator();
      osc1.type = "triangle";
      // Gentle downward swoop to settle on the note
      osc1.frequency.setValueAtTime(freq * 1.3, now);
      osc1.frequency.exponentialRampToValueAtTime(freq, now + 0.04);
      // Hold the note, then wobbly pitch-down slide
      osc1.frequency.setValueAtTime(freq, now + 0.18);
      osc1.frequency.exponentialRampToValueAtTime(freq * 0.5, now + 0.4);
      osc1.frequency.exponentialRampToValueAtTime(freq * 0.25, now + dur);
      const gain1 = audioContext.createGain();
      gain1.gain.setValueAtTime(1, now);
      osc1.connect(gain1);
      gain1.connect(masterGain);
      osc1.start(now);
      osc1.stop(now + dur);

      // --- Octave harmonic: sine for shimmer ---
      const osc2 = audioContext.createOscillator();
      osc2.type = "sine";
      osc2.frequency.setValueAtTime(freq * 2, now);
      // Follows the wobbly downward slide
      osc2.frequency.setValueAtTime(freq * 2, now + 0.18);
      osc2.frequency.exponentialRampToValueAtTime(freq * 1.0, now + 0.4);
      osc2.frequency.exponentialRampToValueAtTime(freq * 0.5, now + dur);
      const gain2 = audioContext.createGain();
      gain2.gain.setValueAtTime(0.3, now);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + dur);
      osc2.connect(gain2);
      gain2.connect(masterGain);
      osc2.start(now);
      osc2.stop(now + dur);

      // --- Wobble LFO: accelerating vibrato on the downward slide ---
      const lfo = audioContext.createOscillator();
      lfo.type = "sine";
      // Quiet during the clean tonal part, then speeds up for silly wobble
      lfo.frequency.setValueAtTime(4, now);
      lfo.frequency.setValueAtTime(4, now + 0.15);
      lfo.frequency.exponentialRampToValueAtTime(18, now + 0.35);
      lfo.frequency.exponentialRampToValueAtTime(25, now + dur);
      const lfoGain = audioContext.createGain();
      // Vibrato depth — zero during clean part, widens during the slide
      lfoGain.gain.setValueAtTime(0, now);
      lfoGain.gain.setValueAtTime(0, now + 0.15);
      lfoGain.gain.linearRampToValueAtTime(freq * 0.06, now + 0.3);
      lfoGain.gain.linearRampToValueAtTime(freq * 0.12, now + dur);
      lfo.connect(lfoGain);
      lfoGain.connect(osc1.frequency);
      lfoGain.connect(osc2.frequency);
      lfo.start(now);
      lfo.stop(now + dur);

      // --- Reverb send: deep hall to smooth the chimes ---
      // Procedurally-generated impulse response: 2.5s exponential decay
      // with high-frequency rolloff for a warm, diffuse hall sound.
      const reverbDur = 2.5;
      const reverbLen = Math.ceil(audioContext.sampleRate * reverbDur);
      const irBuffer = audioContext.createBuffer(2, reverbLen, audioContext.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = irBuffer.getChannelData(ch);
        for (let s = 0; s < reverbLen; s++) {
          // Exponential decay with slight randomness for diffusion
          const t = s / audioContext.sampleRate;
          data[s] = (Math.random() * 2 - 1) * Math.exp(-t * 2.8);
        }
      }
      const convolver = audioContext.createConvolver();
      convolver.buffer = irBuffer;
      // High-cut on reverb tail for warmth (remove harshness)
      const reverbLP = audioContext.createBiquadFilter();
      reverbLP.type = "lowpass";
      reverbLP.frequency.value = 2500;
      reverbLP.Q.value = 0.7;
      // Reverb send gain (wet level)
      const reverbSend = audioContext.createGain();
      reverbSend.gain.value = 0.55;

      convolver.connect(reverbLP);
      reverbLP.connect(reverbSend);
      reverbSend.connect(masterGain);

      // --- Wind-chime layer: sparkling raindrop cascade (1000ms) ---
      // Softer, rounder chimes routed through both dry and reverb paths.
      // Reduced upper partials and gentler attacks for less metallic edge.
      const chimeRatios = [
        1.00, 1.41, 1.73, 2.17, 2.57, 3.14, 3.71,
        4.13, 4.89, 5.19,
        1.19, 2.83, 3.41, 4.59, 5.47,
        1.58, 2.37, 3.93, 5.71,
        1.32, 2.05, 2.73, 3.58, 4.41,
      ];
      // Fisher-Yates shuffle for random pitch ordering each hit
      for (let i = chimeRatios.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [chimeRatios[i], chimeRatios[j]] = [chimeRatios[j], chimeRatios[i]];
      }
      const chimeCount = chimeRatios.length;
      const chimeTotalDur = 1.0; // total chime duration in seconds
      const chimeFadeStart = 0.75; // start fading at 750ms
      for (let i = 0; i < chimeCount; i++) {
        const chimeOsc = audioContext.createOscillator();
        chimeOsc.type = "sine";
        const chimeFreq = freq * chimeRatios[i];
        // Random detune ±20 cents for organic shimmer
        chimeOsc.detune.value = (Math.random() - 0.5) * 40;
        // Stagger onsets: scatter across 0–750ms window
        const onset = now + (i / chimeCount) * chimeFadeStart + Math.random() * 0.04;
        chimeOsc.frequency.setValueAtTime(chimeFreq, onset);

        const chimeEnv = audioContext.createGain();
        // Each chime rings until the total duration, fading from its onset
        const ringEnd = now + chimeTotalDur + Math.random() * 0.05;
        // Gain: scaled back, with softer attack for less harsh ping
        const fadeMultiplier = onset < now + chimeFadeStart
          ? 1.0
          : 1.0 - ((onset - (now + chimeFadeStart)) / (chimeTotalDur - chimeFadeStart));
        const peakGain = (0.25 + Math.random() * 0.15) * volumeRef.current * Math.max(0.2, fadeMultiplier);
        chimeEnv.gain.setValueAtTime(0, onset);
        // Softer attack (~8ms) instead of instant ping — rounder sound
        chimeEnv.gain.linearRampToValueAtTime(peakGain, onset + 0.008);
        // Hold then fade: sustain until 750ms mark, then decay to silence
        const sustainEnd = Math.max(onset + 0.015, now + chimeFadeStart);
        if (sustainEnd > onset + 0.01) {
          chimeEnv.gain.setValueAtTime(peakGain, sustainEnd);
        }
        chimeEnv.gain.exponentialRampToValueAtTime(0.001, ringEnd);

        chimeOsc.connect(chimeEnv);
        // Dry path (direct)
        chimeEnv.connect(masterGain);
        // Wet path (reverb)
        chimeEnv.connect(convolver);
        chimeOsc.start(onset);
        chimeOsc.stop(ringEnd);
      }

      // Cleanup: disconnect after reverb tail finishes
      setTimeout(() => {
        try { masterGain.disconnect(); } catch { /* already disconnected */ }
        try { convolver.disconnect(); } catch { /* already disconnected */ }
        try { reverbLP.disconnect(); } catch { /* already disconnected */ }
        try { reverbSend.disconnect(); } catch { /* already disconnected */ }
      }, 3600);
    },
    [audioContext],
  );

  return { playHitSound, setHitSoundVolume };
}
