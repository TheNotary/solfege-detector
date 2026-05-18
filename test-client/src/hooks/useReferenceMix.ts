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

    // Keep-alive: without at least one upstream connection, the Web Audio
    // engine treats this GainNode as "silent" and downstream
    // AudioWorkletNodes receive an empty `inputs[1] = []` channel array —
    // i.e. their reference input is effectively unwired until the first
    // drone/metronome connect() lands, and may go dark again between
    // metronome ticks. A ConstantSourceNode with offset=0 produces an
    // unbroken stream of zeros, ensuring the channel is always allocated
    // and audible signal mixes in cleanly the moment a producer connects.
    const keepAlive = audioContext.createConstantSource();
    keepAlive.offset.value = 0;
    keepAlive.connect(node);
    keepAlive.start();

    setRefMix(node);

    return () => {
      try {
        keepAlive.stop();
      } catch {
        // already stopped
      }
      try {
        keepAlive.disconnect();
      } catch {
        // already disconnected
      }
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
