import { useCallback, useEffect, useRef, useState } from "react";
import { useAudioStream } from "../hooks/useAudioStream";
import { useReferenceMix } from "../hooks/useReferenceMix";
import { useGameSettings } from "../hooks/useGameSettings";
import { emitCalibrationProbe } from "../lib/calibrationProbe";

type Status =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "probing" }
  | { kind: "ok"; delayMs: number; confidence: number; peakCorrelation: number }
  | { kind: "rejected"; reason: string; peakCorrelation: number }
  | { kind: "error"; message: string };

/**
 * Self-contained latency calibration widget for the config page. Spins up
 * its own audio chain (mic + reference tap + AEC worklet), plays a short
 * white-noise probe through the speakers, cross-correlates the mic capture
 * against the reference signal, and persists the measured speaker→mic
 * round-trip into `settings.audioLatencyMs`.
 *
 * Audio resources are only acquired when the user clicks the button, and
 * torn down again as soon as calibration finishes — leaving the config
 * page in its original silent state.
 */
export default function LatencyCalibrator() {
  const { settings, updateSetting } = useGameSettings();
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Empty `onChunk` keeps useAudioStream from sending raw mic data over the
  // websocket while the user is just calibrating from the config page.
  const onChunkNoop = useCallback(() => {}, []);

  // We need both an `AudioContext` (created by `useAudioStream` after
  // `startRecording()`) AND a `GainNode` from `useReferenceMix` that lives
  // on that same context, before the AEC worklet effect inside
  // `useAudioStream` will wire itself up. The two hooks have a circular
  // data dependency, so we break the cycle via a state mirror of the
  // context. First render: ctxForMix=null → refMix=null →
  // `useAudioStream` runs with referenceNode=null and no AEC. The click
  // calls startRecording → ctx materialises → the effect below copies it
  // into ctxForMix → next render: refMix is built → next render:
  // `useAudioStream` sees a real referenceNode and the AEC effect finally
  // runs.
  const [ctxForMix, setCtxForMix] = useState<AudioContext | null>(null);
  const refMix = useReferenceMix(ctxForMix);

  const {
    startRecording,
    stopRecording,
    audioContext,
    filteredAnalyserNode,
    calibrateBulkDelay,
  } = useAudioStream({
    onChunk: onChunkNoop,
    aecEnabled: true,
    referenceNode: refMix,
    audioInputLatencyMs: settings.audioLatencyMs,
  });

  useEffect(() => {
    setCtxForMix(audioContext);
  }, [audioContext]);

  // When calibration is "running", as soon as the worklet is wired up
  // (filteredAnalyserNode appears) emit the probe and capture.
  const inFlightRef = useRef(false);
  useEffect(() => {
    if (!active) return;
    if (!filteredAnalyserNode || !audioContext || !refMix) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    const ctx = audioContext;
    const mix = refMix;

    // Allow the worklet ~200 ms to settle (it needs at least one frame of
    // reference data through the keep-alive ConstantSource before it will
    // emit anything meaningful) before we start playing the probe.
    const timer = setTimeout(async () => {
      try {
        setStatus({ kind: "probing" });
        emitCalibrationProbe(ctx, mix);
        const result = await calibrateBulkDelay({
          windowSamples: 16384,
          maxLagSamples: 4410,
          minConfidence: 3,
          minPeakCorrelation: 0.25,
        });
        if (!result) {
          setStatus({
            kind: "error",
            message: "Calibration timed out — is the mic muted?",
          });
          return;
        }
        if (result.applied) {
          updateSetting(
            "audioLatencyMs",
            Math.round(result.delayMs * 10) / 10,
          );
          setStatus({
            kind: "ok",
            delayMs: result.delayMs,
            confidence: result.confidence,
            peakCorrelation: result.peakCorrelation,
          });
        } else {
          const reason =
            result.refRmsDb < -120
              ? "speakers appear silent (reference channel had no signal)"
              : result.peakCorrelation < 0
                ? "mic and reference look phase-inverted"
                : `correlation too weak (|peak|=${Math.abs(result.peakCorrelation).toFixed(2)})`;
          setStatus({
            kind: "rejected",
            reason,
            peakCorrelation: result.peakCorrelation,
          });
        }
      } catch (err) {
        setStatus({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // Tear down regardless of outcome; the user can re-click to retry.
        stopRecording();
        setActive(false);
        inFlightRef.current = false;
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [
    active,
    filteredAnalyserNode,
    audioContext,
    refMix,
    calibrateBulkDelay,
    stopRecording,
    updateSetting,
  ]);

  const handleClick = useCallback(async () => {
    if (active) return;
    setStatus({ kind: "starting" });
    setActive(true);
    try {
      await startRecording();
    } catch (err) {
      setStatus({
        kind: "error",
        message:
          err instanceof Error
            ? err.message
            : "Failed to start microphone capture.",
      });
      setActive(false);
    }
  }, [active, startRecording]);

  // Defensive cleanup if the component unmounts mid-calibration.
  useEffect(() => {
    return () => {
      if (active) stopRecording();
    };
  }, [active, stopRecording]);

  const busy =
    status.kind === "starting" || status.kind === "probing" || active;

  return (
    <div className="latency-calibrator">
      <button
        type="button"
        className="save-btn"
        onClick={handleClick}
        disabled={busy}
        style={{ marginRight: "0.75rem" }}
      >
        {busy ? "Calibrating…" : "Calibrate audio latency"}
      </button>
      <span className="field-value">
        {settings.audioLatencyMs.toFixed(1)} ms saved
      </span>
      <StatusLine status={status} />
    </div>
  );
}

function StatusLine({ status }: { status: Status }) {
  switch (status.kind) {
    case "idle":
      return null;
    case "starting":
      return (
        <small className="field-help">
          Acquiring mic + spinning up audio worklet…
        </small>
      );
    case "probing":
      return (
        <small className="field-help">
          Playing a short noise burst — listen for two soft hisses.
        </small>
      );
    case "ok":
      return (
        <small className="field-help">
          Measured {status.delayMs.toFixed(1)} ms (confidence{" "}
          {status.confidence.toFixed(1)}, peak{" "}
          {status.peakCorrelation.toFixed(2)}). Saved.
        </small>
      );
    case "rejected":
      return (
        <small className="field-help" style={{ color: "#b34" }}>
          Rejected: {status.reason}. Existing value kept.
        </small>
      );
    case "error":
      return (
        <small className="field-help" style={{ color: "#b34" }}>
          Error: {status.message}
        </small>
      );
  }
}
