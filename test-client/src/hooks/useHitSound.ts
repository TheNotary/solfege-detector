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

      // Cleanup: disconnect after sound finishes to free resources
      setTimeout(() => {
        try { masterGain.disconnect(); } catch { /* already disconnected */ }
      }, 650);
    },
    [audioContext],
  );

  return { playHitSound, setHitSoundVolume };
}
