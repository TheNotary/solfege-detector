import { useCallback, useEffect, useRef, useState } from "react";

const FADE_DURATION = 0.5; // seconds
const DEFAULT_VOLUME = 0.15;
const DEFAULT_FREQ = 130.81; // C3

interface UseDroneReturn {
  startDrone: () => void;
  stopDrone: () => void;
  isDroning: boolean;
  setDroneVolume: (v: number) => void;
}

/**
 * Synthesized drone using Web Audio OscillatorNodes.
 * Produces a warm, spa-like tone with harmonics and subtle LFO vibrato.
 * The frequency defaults to C3 (130.81 Hz) but can be changed dynamically.
 */
export function useDrone(
  audioContext: AudioContext | null,
  frequency: number = DEFAULT_FREQ,
): UseDroneReturn {
  const [isDroning, setIsDroning] = useState(false);

  const masterGainRef = useRef<GainNode | null>(null);
  const oscillatorsRef = useRef<OscillatorNode[]>([]);
  const volumeRef = useRef(DEFAULT_VOLUME);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const freqRef = useRef(frequency);
  freqRef.current = frequency;

  const startDrone = useCallback(() => {
    if (!audioContext || isDroning) return;

    // Clear any pending stop timer
    if (stopTimerRef.current !== null) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }

    const freq = freqRef.current;
    const now = audioContext.currentTime;

    // Master gain node
    const masterGain = audioContext.createGain();
    masterGain.gain.setValueAtTime(0, now);
    masterGain.gain.linearRampToValueAtTime(volumeRef.current, now + FADE_DURATION);
    masterGain.connect(audioContext.destination);
    masterGainRef.current = masterGain;

    const oscillators: OscillatorNode[] = [];

    // Fundamental sine
    const fundamental = audioContext.createOscillator();
    fundamental.type = "sine";
    fundamental.frequency.setValueAtTime(freq, now);
    fundamental.connect(masterGain);
    oscillators.push(fundamental);

    // 2nd harmonic: -12dB (gain ~0.25)
    const harm2Gain = audioContext.createGain();
    harm2Gain.gain.setValueAtTime(0.25, now);
    harm2Gain.connect(masterGain);
    const harm2 = audioContext.createOscillator();
    harm2.type = "sine";
    harm2.frequency.setValueAtTime(freq * 2, now);
    harm2.connect(harm2Gain);
    oscillators.push(harm2);

    // 3rd harmonic: -18dB (gain ~0.125)
    const harm3Gain = audioContext.createGain();
    harm3Gain.gain.setValueAtTime(0.125, now);
    harm3Gain.connect(masterGain);
    const harm3 = audioContext.createOscillator();
    harm3.type = "sine";
    harm3.frequency.setValueAtTime(freq * 3, now);
    harm3.connect(harm3Gain);
    oscillators.push(harm3);

    // LFO for gentle vibrato on fundamental (±2 cents at 0.2 Hz)
    const lfo = audioContext.createOscillator();
    lfo.type = "sine";
    lfo.frequency.setValueAtTime(0.2, now);
    const lfoGain = audioContext.createGain();
    lfoGain.gain.setValueAtTime(2, now); // ±2 cents
    lfo.connect(lfoGain);
    lfoGain.connect(fundamental.detune);
    oscillators.push(lfo);

    // Start all oscillators
    for (const osc of oscillators) {
      osc.start(now);
    }

    oscillatorsRef.current = oscillators;
    setIsDroning(true);
  }, [audioContext, isDroning]);

  const stopDrone = useCallback(() => {
    if (!audioContext || !masterGainRef.current) return;

    const now = audioContext.currentTime;
    const masterGain = masterGainRef.current;

    // Fade out
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setValueAtTime(masterGain.gain.value, now);
    masterGain.gain.linearRampToValueAtTime(0, now + FADE_DURATION);

    // Stop and disconnect after fade
    stopTimerRef.current = setTimeout(() => {
      for (const osc of oscillatorsRef.current) {
        try {
          osc.stop();
          osc.disconnect();
        } catch {
          // Already stopped
        }
      }
      masterGain.disconnect();
      oscillatorsRef.current = [];
      masterGainRef.current = null;
      stopTimerRef.current = null;
    }, FADE_DURATION * 1000 + 50);

    setIsDroning(false);
  }, [audioContext]);

  const setDroneVolume = useCallback(
    (v: number) => {
      volumeRef.current = v;
      if (masterGainRef.current && audioContext) {
        const now = audioContext.currentTime;
        masterGainRef.current.gain.cancelScheduledValues(now);
        masterGainRef.current.gain.setValueAtTime(
          masterGainRef.current.gain.value,
          now
        );
        masterGainRef.current.gain.linearRampToValueAtTime(v, now + 0.05);
      }
    },
    [audioContext]
  );

  // Restart drone when frequency changes while playing
  const prevFreqRef = useRef(frequency);
  useEffect(() => {
    if (frequency !== prevFreqRef.current && isDroning && audioContext) {
      prevFreqRef.current = frequency;
      // Quick restart: stop current, start new at updated freq
      stopDrone();
      // Wait for fade-out to complete, then restart
      const timer = setTimeout(() => {
        startDrone();
      }, FADE_DURATION * 1000 + 100);
      return () => clearTimeout(timer);
    }
    prevFreqRef.current = frequency;
  }, [frequency, isDroning, audioContext, stopDrone, startDrone]);

  return { startDrone, stopDrone, isDroning, setDroneVolume };
}
