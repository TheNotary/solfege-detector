import { useEffect, useRef, useState } from "react";

/**
 * Owns a single `GainNode` on the shared `AudioContext` into which the drone
 * and metronome route a *copy* of their output. This gives downstream consumers
 * (e.g. an AEC `AudioWorkletNode`) sample-accurate access to the reference
 * signal that the speakers are also playing.
 *
 * The returned node is NOT connected to `ctx.destination`; it is a pure tap.
 * It stays connected only via the hooks that opt into the monitor (`useDrone`,
 * `useMetronome`).
 *
 * Returns `null` until the `AudioContext` is available.
 */
export function useReferenceMix(
  audioContext: AudioContext | null,
): GainNode | null {
  const [refMix, setRefMix] = useState<GainNode | null>(null);
  const refMixRef = useRef<GainNode | null>(null);

  useEffect(() => {
    if (!audioContext) {
      setRefMix(null);
      return;
    }

    const node = audioContext.createGain();
    node.gain.value = 1;
    refMixRef.current = node;
    setRefMix(node);

    return () => {
      try {
        node.disconnect();
      } catch {
        // already disconnected
      }
      if (refMixRef.current === node) {
        refMixRef.current = null;
      }
      setRefMix(null);
    };
  }, [audioContext]);

  return refMix;
}
