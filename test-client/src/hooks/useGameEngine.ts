import { useCallback, useEffect, useRef, useState } from "react";

const SOLFEGE_SCALE = ["do", "re", "mi", "fa", "sol", "la", "ti"] as const;
export type Syllable = (typeof SOLFEGE_SCALE)[number];

export interface GameNote {
  id: number;
  syllable: Syllable;
  /** Horizontal position as percentage of game area width (0–100). */
  x: number;
  /** Vertical position as percentage of game area height. */
  y: number;
  state: "sliding" | "hit" | "missed";
  /** Captured audio segment for this note's time in the hit zone. */
  audioSegment?: ArrayBuffer;
  /** Whether audio capture has been started for this note. */
  captureStarted?: boolean;
}

export interface Score {
  hits: number;
  total: number;
}

/** Crosshair position as % from the left edge. */
export const CROSSHAIR_X = 20;
/** Half-width of the hit zone around the crosshair (%). */
export const HIT_ZONE_HALF = 6;

const DEFAULT_SPEED = 30; // notes per minute
const MIN_SPEED = 10;
const MAX_SPEED = 120;

/** Map a syllable to a Y% position: do = bottom (85%), ti = top (15%). */
export function syllableY(syllable: Syllable): number {
  const idx = SOLFEGE_SCALE.indexOf(syllable);
  // 7 notes, evenly spaced between 15% (top) and 85% (bottom)
  return 85 - (idx / (SOLFEGE_SCALE.length - 1)) * 70;
}

/** Target frequencies for each syllable based on C3 reference (default). */
export const TARGET_FREQUENCIES: Record<Syllable, number> = {
  do: 130.81,
  re: 146.83,
  mi: 164.81,
  fa: 174.61,
  sol: 196.0,
  la: 220.0,
  ti: 246.94,
};

export interface UseGameEngineOptions {
  /** Called when a note enters the hit zone to begin audio capture. */
  startNoteCapture?: () => void;
  /** Called when a note exits the hit zone; returns captured audio. */
  stopNoteCapture?: () => ArrayBuffer | null;
  /** Dynamic target frequencies per syllable (overrides C3 defaults). */
  targetFrequencies?: Record<Syllable, number>;
  /** Initial speed in BPM (overrides DEFAULT_SPEED). */
  initialSpeed?: number;
  /** Combined latency offset in ms (audio + display). Shifts the hit-zone
   *  center so notes are evaluated for hits earlier, compensating for
   *  system + player latency. Negative values shift the other way. */
  latencyOffsetMs?: number;
}

export interface UseGameEngineReturn {
  notes: GameNote[];
  speed: number;
  setSpeed: (s: number) => void;
  score: Score;
  /** Call every frame with current volume. Returns hit syllable or null.
   *  @param hitZoneHalf Override the fixed hit-zone half-width (%) with a
   *                     displacement-derived value so notes must fall within
   *                     the waveform's actual swing. */
  checkHit: (isSounding: boolean, hitZoneHalf?: number) => {
    syllable: Syllable;
    noteId: number;
    targetFrequencyHz: number;
  } | null;
  startGame: () => void;
  stopGame: () => void;
  isRunning: boolean;
}

let nextNoteId = 1;

export function useGameEngine(options?: UseGameEngineOptions): UseGameEngineReturn {
  const initSpeed = options?.initialSpeed ?? DEFAULT_SPEED;
  const latencyOffsetMs = options?.latencyOffsetMs ?? 0;
  const [notes, setNotes] = useState<GameNote[]>([]);
  const [speed, setSpeedState] = useState(initSpeed);
  const [score, setScore] = useState<Score>({ hits: 0, total: 0 });
  const [isRunning, setIsRunning] = useState(false);

  const notesRef = useRef<GameNote[]>([]);
  const speedRef = useRef(initSpeed);
  const latencyOffsetMsRef = useRef(latencyOffsetMs);
  latencyOffsetMsRef.current = latencyOffsetMs;
  const scoreRef = useRef<Score>({ hits: 0, total: 0 });
  const rafRef = useRef<number | null>(null);
  const lastSpawnRef = useRef(0);
  const sequenceIdxRef = useRef(0);
  const lastFrameTimeRef = useRef(0);
  const isRunningRef = useRef(false);

  // Keep capture callbacks in refs so the game loop always sees latest
  const startNoteCaptureRef = useRef(options?.startNoteCapture);
  startNoteCaptureRef.current = options?.startNoteCapture;
  const stopNoteCaptureRef = useRef(options?.stopNoteCapture);
  stopNoteCaptureRef.current = options?.stopNoteCapture;
  const targetFreqRef = useRef(options?.targetFrequencies ?? TARGET_FREQUENCIES);
  targetFreqRef.current = options?.targetFrequencies ?? TARGET_FREQUENCIES;

  const setSpeed = useCallback((s: number) => {
    const clamped = Math.max(MIN_SPEED, Math.min(MAX_SPEED, s));
    speedRef.current = clamped;
    setSpeedState(clamped);
  }, []);

  const checkHit = useCallback(
    (isSounding: boolean, hitZoneHalf: number = HIT_ZONE_HALF): { syllable: Syllable; noteId: number; targetFrequencyHz: number } | null => {
      if (!isSounding) return null;

      // Compute effective crosshair center shifted by latency offset.
      // Convert latencyOffsetMs → percentage shift based on current speed.
      const bpm = speedRef.current;
      const spawnInterval = 60 / bpm;
      const travelTime = spawnInterval * 3; // seconds to cross 110% width
      const pctPerMs = 110 / (travelTime * 1000);
      const offsetPct = latencyOffsetMsRef.current * pctPerMs;
      // Shift center to the right so notes are evaluated earlier (before
      // they visually reach the crosshair), compensating for latency.
      const effectiveCenter = CROSSHAIR_X + offsetPct;

      const current = notesRef.current;
      for (let i = 0; i < current.length; i++) {
        const note = current[i];
        if (
          note.state === "sliding" &&
          Math.abs(note.x - effectiveCenter) <= hitZoneHalf
        ) {
          note.state = "hit";
          scoreRef.current = {
            hits: scoreRef.current.hits + 1,
            total: scoreRef.current.total,
          };
          setScore({ ...scoreRef.current });
          return {
            syllable: note.syllable,
            noteId: note.id,
            targetFrequencyHz: targetFreqRef.current[note.syllable],
          };
        }
      }
      return null;
    },
    []
  );

  const stopGame = useCallback(() => {
    isRunningRef.current = false;
    setIsRunning(false);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    notesRef.current = [];
    setNotes([]);
  }, []);

  const startGame = useCallback(() => {
    notesRef.current = [];
    scoreRef.current = { hits: 0, total: 0 };
    sequenceIdxRef.current = 0;
    lastSpawnRef.current = 0;
    lastFrameTimeRef.current = 0;
    nextNoteId = 1;

    setNotes([]);
    setScore({ hits: 0, total: 0 });
    isRunningRef.current = true;
    setIsRunning(true);

    const loop = (timestamp: number) => {
      if (!isRunningRef.current) return;

      if (lastFrameTimeRef.current === 0) {
        lastFrameTimeRef.current = timestamp;
        lastSpawnRef.current = timestamp;
      }

      const dt = (timestamp - lastFrameTimeRef.current) / 1000; // seconds
      lastFrameTimeRef.current = timestamp;

      const bpm = speedRef.current;
      const spawnInterval = 60 / bpm; // seconds per note

      // Speed: notes travel from x=105 (offscreen right) to x=-5 (offscreen left).
      // Time to cross = the time for ~2 notes to be on screen simultaneously.
      // At 30 BPM (1 note/2s), a note should take ~4s to cross the full width.
      // px/s = 110 / (spawnInterval * 2)
      const travelTime = spawnInterval * 3;
      const pxPerSec = 110 / travelTime;

      // Effective crosshair center shifted by latency calibration offset
      const pctPerMs = pxPerSec / 1000;
      const loopOffsetPct = latencyOffsetMsRef.current * pctPerMs;
      const effectiveCenter = CROSSHAIR_X + loopOffsetPct;

      // Spawn new notes
      if (timestamp - lastSpawnRef.current >= spawnInterval * 1000) {
        const syllable = SOLFEGE_SCALE[sequenceIdxRef.current % SOLFEGE_SCALE.length];
        sequenceIdxRef.current++;
        const note: GameNote = {
          id: nextNoteId++,
          syllable,
          x: 105,
          y: syllableY(syllable),
          state: "sliding",
        };
        notesRef.current.push(note);
        lastSpawnRef.current = timestamp;
      }

      // Move notes
      const current = notesRef.current;
      for (let i = current.length - 1; i >= 0; i--) {
        const note = current[i];
        if (note.state === "hit") {
          const prevX = note.x;
          note.x -= pxPerSec * dt;

          // Stop audio capture when hit note exits the left side of the hit zone
          const hitZoneLeft = effectiveCenter - HIT_ZONE_HALF;
          if (note.captureStarted && !note.audioSegment && prevX >= hitZoneLeft && note.x < hitZoneLeft) {
            const segment = stopNoteCaptureRef.current?.() ?? null;
            if (segment) {
              note.audioSegment = segment;
            }
          }

          // Keep hit notes briefly for confetti, then remove
          if (note.x < -10) {
            // Safety: stop capture if it somehow wasn't stopped yet
            if (note.captureStarted && !note.audioSegment) {
              stopNoteCaptureRef.current?.();
            }
            current.splice(i, 1);
          }
          continue;
        }

        const prevX = note.x;
        note.x -= pxPerSec * dt;

        // Hit zone entry: note just crossed into the zone from the right
        const hitZoneRight = effectiveCenter + HIT_ZONE_HALF;
        const hitZoneLeft = effectiveCenter - HIT_ZONE_HALF;
        if (!note.captureStarted && prevX > hitZoneRight && note.x <= hitZoneRight) {
          note.captureStarted = true;
          startNoteCaptureRef.current?.();
        }

        // Hit zone exit: note just crossed out of the zone to the left
        if (note.captureStarted && !note.audioSegment && prevX >= hitZoneLeft && note.x < hitZoneLeft) {
          const segment = stopNoteCaptureRef.current?.() ?? null;
          if (segment) {
            note.audioSegment = segment;
          }
        }

        if (note.x < -5) {
          if (note.state === "sliding") {
            // Ensure capture is stopped if note exits without hitting left boundary check above
            if (note.captureStarted && !note.audioSegment) {
              const segment = stopNoteCaptureRef.current?.() ?? null;
              if (segment) {
                note.audioSegment = segment;
              }
            }
            note.state = "missed";
            scoreRef.current = {
              hits: scoreRef.current.hits,
              total: scoreRef.current.total + 1,
            };
            setScore({ ...scoreRef.current });
          }
          current.splice(i, 1);
        }
      }

      // Count notes that crossed the crosshair as total (for scoring)
      // (already handled above when missed)

      setNotes([...current]);
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  return {
    notes,
    speed,
    setSpeed,
    score,
    checkHit,
    startGame,
    stopGame,
    isRunning,
  };
}
