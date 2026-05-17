import { useCallback, useEffect, useRef, useState } from "react";
import { CROSSHAIR_X } from "../hooks/useGameEngine";
import { useGameSettings } from "../hooks/useGameSettings";
import "./DisplayCalibration.css";

interface DisplayCalibrationProps {
  onSkip: () => void;
}

type Phase = "idle" | "running" | "feedback" | "done";

const TOTAL_ROUNDS = 10;
const TRAVEL_TIME_MS = 3000; // note takes 3s to cross full width
const PAUSE_BETWEEN_MS = 1200; // pause between rounds

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
  const stdEstimate = madRaw * 1.4826;
  return Math.abs(value - med) > 2 * stdEstimate;
}

export default function DisplayCalibration({
  onSkip,
}: DisplayCalibrationProps) {
  const { updateSetting } = useGameSettings();
  const [phase, setPhase] = useState<Phase>("idle");
  const [deltas, setDeltas] = useState<number[]>([]);
  const [round, setRound] = useState(0);
  const [noteX, setNoteX] = useState(100); // percentage from left
  const [ghostX, setGhostX] = useState<number | null>(null);

  // Animation refs
  const rafRef = useRef<number | null>(null);
  const spawnTimeRef = useRef(0);
  const crossTimeRef = useRef(0); // exact time note crosses crosshair
  const pressedRef = useRef(false);
  const roundRef = useRef(0);

  // Animate one note across the screen
  const animateNote = useCallback(() => {
    const elapsed = performance.now() - spawnTimeRef.current;
    const progress = elapsed / TRAVEL_TIME_MS; // 0 → 1
    const x = 100 - progress * 100; // right → left

    if (x < -5) {
      // Note exited screen without spacebar press — count as missed
      if (!pressedRef.current) {
        setPhase("feedback");
        setGhostX(null);
        // Auto-advance after brief pause
        setTimeout(() => {
          if (roundRef.current >= TOTAL_ROUNDS) {
            setPhase("done");
          } else {
            startRound();
          }
        }, PAUSE_BETWEEN_MS);
      }
      return;
    }

    setNoteX(x);
    rafRef.current = requestAnimationFrame(animateNote);
  }, []);

  const startRound = useCallback(() => {
    pressedRef.current = false;
    setGhostX(null);
    setNoteX(100);
    spawnTimeRef.current = performance.now();
    // The note crosses CROSSHAIR_X% when progress = (100 - CROSSHAIR_X) / 100
    crossTimeRef.current =
      spawnTimeRef.current + ((100 - CROSSHAIR_X) / 100) * TRAVEL_TIME_MS;
    setPhase("running");
    rafRef.current = requestAnimationFrame(animateNote);
  }, [animateNote]);

  // Spacebar handler
  useEffect(() => {
    if (phase !== "running") return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || pressedRef.current) return;
      e.preventDefault();
      pressedRef.current = true;

      const pressTime = performance.now();
      const deltaMs = Math.round(pressTime - crossTimeRef.current);
      setDeltas((prev) => [...prev, deltaMs]);

      // Show ghost at press position
      const elapsed = pressTime - spawnTimeRef.current;
      const pressX = 100 - (elapsed / TRAVEL_TIME_MS) * 100;
      setGhostX(pressX);

      // Stop animation
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }

      // Show feedback, then advance
      setPhase("feedback");
      const nextRound = roundRef.current + 1;
      roundRef.current = nextRound;
      setRound(nextRound);

      setTimeout(() => {
        if (nextRound >= TOTAL_ROUNDS) {
          setPhase("done");
        } else {
          startRound();
        }
      }, PAUSE_BETWEEN_MS);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phase, startRound]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const handleStart = useCallback(() => {
    setDeltas([]);
    setRound(0);
    roundRef.current = 0;
    startRound();
  }, [startRound]);

  const handleRetry = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    handleStart();
  }, [handleStart]);

  const med = median(deltas);

  const handleSave = useCallback(() => {
    updateSetting("displayLatencyMs", Math.round(med));
    onSkip();
  }, [med, updateSetting, onSkip]);

  const crosshairZoneWidth = 8; // % width of visual zone

  return (
    <div className="display-calibration">
      <h3>Display Latency</h3>
      <p className="instructions">
        {phase === "idle" &&
          "Press Start, then hit Spacebar when the note reaches the crosshair."}
        {(phase === "running" || phase === "feedback") &&
          `Round ${round + (phase === "running" ? 1 : 0)}/${TOTAL_ROUNDS} — press Spacebar!`}
        {phase === "done" && "Calibration complete!"}
      </p>

      {/* Sliding area */}
      <div className="slide-area">
        <div className="slide-staff-line" />
        <div
          className="slide-crosshair"
          style={{ left: `${CROSSHAIR_X}%` }}
        />
        <div
          className="slide-crosshair-zone"
          style={{
            left: `${CROSSHAIR_X - crosshairZoneWidth / 2}%`,
            width: `${crosshairZoneWidth}%`,
          }}
        />

        {/* Note */}
        {(phase === "running" || phase === "feedback") && (
          <div className="slide-note" style={{ left: `${noteX}%` }}>
            ♩
          </div>
        )}

        {/* Ghost at crosshair (ground truth position) */}
        {phase === "feedback" && ghostX !== null && (
          <div
            className="slide-note ghost"
            style={{ left: `${CROSSHAIR_X}%` }}
          >
            ♩
          </div>
        )}

        {(phase === "running" || phase === "feedback") && (
          <div className="press-hint">
            ⎵ Spacebar
          </div>
        )}
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
              <span>{d > 0 ? `+${d}` : d} ms</span>
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
              Done →
            </button>
          </>
        )}
      </div>
    </div>
  );
}
