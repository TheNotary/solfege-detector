import { useCallback, useEffect, useRef, useState } from "react";
import { useClickTrack } from "../hooks/useClickTrack";
import { useGameSettings } from "../hooks/useGameSettings";
import "./AudioCalibration.css";

interface AudioCalibrationProps {
  onSkip: () => void;
}

type Phase = "idle" | "countdown" | "running" | "done";

const TOTAL_CLICKS = 10;
const INTERVAL_MS = 600; // 100 BPM
const ONSET_RMS_THRESHOLD = 0.06;
const COUNTDOWN_SECONDS = 3;

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function isOutlier(value: number, med: number, values: number[]): boolean {
  if (values.length < 3) return false;
  const diffs = values.map((v) => Math.abs(v - med));
  const madRaw = median(diffs);
  const stdEstimate = madRaw * 1.4826; // MAD → σ estimate
  return Math.abs(value - med) > 2 * stdEstimate;
}

export default function AudioCalibration({ onSkip }: AudioCalibrationProps) {
  const { updateSetting } = useGameSettings();
  const [phase, setPhase] = useState<Phase>("idle");
  const [countdownValue, setCountdownValue] = useState(COUNTDOWN_SECONDS);
  const [clickIndex, setClickIndex] = useState(0);
  const [flashing, setFlashing] = useState(false);
  const [deltas, setDeltas] = useState<number[]>([]);

  // Audio capture refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  // Per-click tracking
  const clickTimeRef = useRef<number | null>(null);
  const awaitingOnsetRef = useRef(false);
  const prevRmsRef = useRef(0);

  // RAF-polled onset detection (~16ms resolution)
  const pollOnset = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;

    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);

    // Compute RMS
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);

    // Detect onset: RMS crosses threshold while we're waiting
    if (
      awaitingOnsetRef.current &&
      rms > ONSET_RMS_THRESHOLD &&
      prevRmsRef.current < ONSET_RMS_THRESHOLD
    ) {
      const onsetTime = performance.now();
      const clickTime = clickTimeRef.current;
      if (clickTime !== null) {
        const deltaMs = Math.round(onsetTime - clickTime);
        setDeltas((prev) => [...prev, deltaMs]);
        awaitingOnsetRef.current = false;
      }
    }

    prevRmsRef.current = rms;
    rafRef.current = requestAnimationFrame(pollOnset);
  }, []);

  // Start/stop microphone
  const startMic = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 44100,
      },
    });
    streamRef.current = stream;

    const ctx = new AudioContext({ sampleRate: 44100 });
    audioCtxRef.current = ctx;

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    analyserRef.current = analyser;

    // Start RAF polling
    rafRef.current = requestAnimationFrame(pollOnset);
  }, [pollOnset]);

  const stopMic = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    analyserRef.current = null;
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  // Click track callbacks
  const onClickFired = useCallback((_audioTime: number, index: number) => {
    clickTimeRef.current = performance.now();
    awaitingOnsetRef.current = true;
    setClickIndex(index + 1);

    // Visual flash
    setFlashing(true);
    setTimeout(() => setFlashing(false), 100);
  }, []);

  const onAllClicksDone = useCallback(() => {
    setPhase("done");
    stopMic();
  }, [stopMic]);

  const { start: startClicks, stop: stopClicks } = useClickTrack(
    onClickFired,
    onAllClicksDone,
  );

  // Countdown logic
  useEffect(() => {
    if (phase !== "countdown") return;

    if (countdownValue <= 0) {
      setPhase("running");
      startClicks({ intervalMs: INTERVAL_MS, totalClicks: TOTAL_CLICKS });
      return;
    }

    const timer = setTimeout(() => setCountdownValue((v) => v - 1), 1000);
    return () => clearTimeout(timer);
  }, [phase, countdownValue, startClicks]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopClicks();
      stopMic();
    };
  }, [stopClicks, stopMic]);

  const handleStart = useCallback(async () => {
    setDeltas([]);
    setClickIndex(0);
    setCountdownValue(COUNTDOWN_SECONDS);
    prevRmsRef.current = 0;
    awaitingOnsetRef.current = false;
    clickTimeRef.current = null;
    await startMic();
    setPhase("countdown");
  }, [startMic]);

  const handleRetry = useCallback(async () => {
    stopClicks();
    stopMic();
    await handleStart();
  }, [stopClicks, stopMic, handleStart]);

  const med = median(deltas);

  const handleSave = useCallback(() => {
    updateSetting("audioLatencyMs", Math.round(med));
    onSkip();
  }, [med, updateSetting, onSkip]);

  return (
    <div className="audio-calibration">
      <h3>Audio Input Latency</h3>
      <p className="instructions">
        {phase === "idle" &&
          'Press Start, then say "pop" in sync with each click you hear.'}
        {phase === "countdown" && "Get ready..."}
        {phase === "running" &&
          `Say "pop" with each click (${clickIndex}/${TOTAL_CLICKS})`}
        {phase === "done" && "Calibration complete!"}
      </p>

      {/* Click / countdown indicator */}
      <div
        className={`click-indicator ${flashing ? "flash" : ""} ${phase === "countdown" ? "countdown" : ""}`}
      >
        {phase === "countdown"
          ? countdownValue
          : phase === "running"
            ? clickIndex
            : phase === "done"
              ? "✓"
              : "♪"}
      </div>

      {/* Round results */}
      {deltas.length > 0 && (
        <div className="round-list">
          {deltas.map((d, i) => (
            <div
              key={i}
              className={`round-row ${isOutlier(d, med, deltas) ? "outlier" : ""}`}
            >
              <span>Round {i + 1}</span>
              <span>{d} ms</span>
            </div>
          ))}
        </div>
      )}

      {phase === "done" && (
        <div className="result-summary">
          Median latency: {Math.round(med)} ms
        </div>
      )}

      {/* Actions */}
      <div className="calibration-actions">
        {phase === "idle" && (
          <>
            <button className="cal-start-btn" onClick={handleStart}>
              Start
            </button>
            <button className="cal-skip-btn" onClick={onSkip}>
              Skip →
            </button>
          </>
        )}
        {phase === "done" && (
          <>
            <button className="cal-save-btn" onClick={handleSave}>
              Save ({Math.round(med)} ms)
            </button>
            <button className="cal-retry-btn" onClick={handleRetry}>
              Retry
            </button>
            <button className="cal-skip-btn" onClick={onSkip}>
              Skip →
            </button>
          </>
        )}
      </div>
    </div>
  );
}
