import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./GameView.css";
import NoteSprite from "../components/NoteSprite";
import PitchBar from "../components/PitchBar";
import { freqToY, buildNotePoints } from "../components/PitchBar";
import { useGameEngine, CROSSHAIR_X, HIT_ZONE_HALF, syllableY } from "../hooks/useGameEngine";
import { computeHitZoneGeometry } from "../lib/hitZoneGeometry";
import { useWaveformDisplacement } from "../hooks/useWaveformDisplacement";
import { useVolumeDetection } from "../hooks/useVolumeDetection";
import { useAudioStream } from "../hooks/useAudioStream";
import { useWebSocket } from "../hooks/useWebSocket";
import { useAudioQuality } from "../hooks/useAudioQuality";
import { usePitchDetection } from "../hooks/usePitchDetection";
import { useSmoothedPitch } from "../hooks/useSmoothedPitch";
import { useDrone } from "../hooks/useDrone";
import { useOnsetDetection } from "../hooks/useOnsetDetection";
import OnsetFlash from "../components/OnsetFlash";
import WaveformCrosshair from "../components/WaveformCrosshair";
import AppConfig from "../AppConfig";
import { parseNoteName, foldToOctave, computeScaleFrequencies } from "../utils/noteUtils";
import { useGameSettings } from "../hooks/useGameSettings";

const SOLFEGE_LABELS = ["do", "re", "mi", "fa", "sol", "la", "ti"] as const;

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
function hzToNoteName(hz: number): string {
  const semitone = Math.round(12 * Math.log2(hz / 440));
  const noteIndex = ((semitone % 12) + 12) % 12;
  const octave = Math.floor((semitone + 9) / 12) + 4;
  return `${NOTE_NAMES[(noteIndex + 9) % 12]}${octave}`;
}

interface GameViewProps {
  isConnected?: boolean;
}

const DEFAULT_ROOT_HZ = 130.81; // C3

export default function GameView(_props: GameViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sentNoteIds = useRef<Set<number>>(new Set());
  const { settings } = useGameSettings();

  // Root note configuration — initialised from saved settings
  const [rootNote, setRootNote] = useState(() => settings.rootNote);
  const [rootFrequencyHz, setRootFrequencyHz] = useState(() => {
    const parsed = parseNoteName(settings.rootNote);
    return parsed ? parsed.frequency : DEFAULT_ROOT_HZ;
  });
  const scaleFrequencies = useMemo(
    () => computeScaleFrequencies(rootFrequencyHz),
    [rootFrequencyHz],
  );
  const notePoints = useMemo(
    () => buildNotePoints(scaleFrequencies),
    [scaleFrequencies],
  );

  const handleRootNoteChange = useCallback((value: string) => {
    setRootNote(value);
    const parsed = parseNoteName(value);
    if (parsed) {
      setRootFrequencyHz(parsed.frequency);
    }
  }, []);

  const { send, sendNoteEvent, isConnected } = useWebSocket(AppConfig.SOCKET_URL);
  const { volume, isSounding, onVolume } = useVolumeDetection();

  const [onsetCount, setOnsetCount] = useState(0);
  const onOnset = useCallback(() => {
    setOnsetCount((c) => c + 1);
  }, []);
  const { resetOnsets: resetOnsetsRaw, feedSamples, trimToNearestOnset } = useOnsetDetection({ onOnset });

  const onChunk = useCallback(
    (chunk: ArrayBuffer) => {
      send(chunk);
    },
    [send]
  );

  // Trim capture to the onset nearest the midpoint of the capture window
  const trimCapture = useCallback(
    (audioBuffer: ArrayBuffer): ArrayBuffer => {
      const durationMs = (audioBuffer.byteLength / 2) / 44_100 * 1000;
      return trimToNearestOnset(audioBuffer, durationMs / 2);
    },
    [trimToNearestOnset]
  );

  const { startRecording, stopRecording, isRecording, analyserNode, audioContext, startNoteCapture: startNoteCaptureRaw, stopNoteCapture } =
    useAudioStream({
      onChunk,
      onVolume,
      onCaptureChunk: feedSamples,
      trimCapture,
    });

  // Wrap startNoteCapture to also reset onset detector
  const startNoteCapture = useCallback(() => {
    resetOnsetsRaw();
    setOnsetCount(0);
    startNoteCaptureRaw();
  }, [resetOnsetsRaw, startNoteCaptureRaw]);

  const {
    notes,
    speed,
    setSpeed,
    score,
    checkHit,
    startGame,
    stopGame,
    isRunning,
  } = useGameEngine({
    startNoteCapture,
    stopNoteCapture,
    targetFrequencies: scaleFrequencies,
    initialSpeed: settings.speed,
    latencyOffsetMs: settings.audioLatencyMs + settings.displayLatencyMs,
  });

  const { isQualitySample } = useAudioQuality(analyserNode);
  const { pitchHz } = usePitchDetection(analyserNode);

  // Fold detected pitch into the root octave so the bar aligns regardless of
  // which octave the singer is actually using.
  const foldedPitchHz = pitchHz !== null ? foldToOctave(pitchHz, rootFrequencyHz) : null;

  // Pitch indicator smoothing
  const [acceleration, setAcceleration] = useState(() => settings.acceleration);
  const { displayPitchHz, opacity: pitchOpacity } = useSmoothedPitch(
    foldedPitchHz,
    acceleration,
    rootFrequencyHz,
  );

  // Debug HUD toggle
  const [showDebug, setShowDebug] = useState(() => settings.showDebug);

  // 100ms sliding-window pitch average
  const pitchBufferRef = useRef<Array<{ hz: number; t: number }>>([]);
  const [avgPitchHz, setAvgPitchHz] = useState<number | null>(null);
  useEffect(() => {
    const now = performance.now();
    if (pitchHz !== null) {
      pitchBufferRef.current.push({ hz: pitchHz, t: now });
    }
    // Prune entries older than 100ms
    const cutoff = now - 100;
    pitchBufferRef.current = pitchBufferRef.current.filter((e) => e.t >= cutoff);
    const buf = pitchBufferRef.current;
    if (buf.length > 0) {
      const sum = buf.reduce((acc, e) => acc + e.hz, 0);
      setAvgPitchHz(sum / buf.length);
    } else {
      setAvgPitchHz(null);
    }
  }, [pitchHz]);

  // Drone — plays at the configured root frequency
  const { startDrone, stopDrone, isDroning, setDroneVolume } = useDrone(
    audioContext,
    rootFrequencyHz,
  );
  const [droneVolume, setDroneVolumeState] = useState(() => settings.droneVolume);

  // Waveform displacement (kept for visual reference / future use)
  const waveformDisplacement = useWaveformDisplacement(analyserNode, isRecording);
  void waveformDisplacement; // used by WaveformCrosshair visually

  // Hit-zone geometry (centerPct, halfPct, offsetPct).  Computed every
  // frame so the cyan visual crosshair-zone and the yellow debug zone
  // share the same source of truth — see #109.
  const [hitZoneGeometry, setHitZoneGeometry] = useState<{ centerPct: number; halfPct: number; offsetPct: number } | null>(null);
  // The debug overlay is only shown while the game is running and the
  // user has enabled the toggle.
  const debugHitZone = isRunning && isRecording ? hitZoneGeometry : null;

  // Check for hits every frame when running.
  useEffect(() => {
    const containerWidth = containerRef.current?.clientWidth ?? 1;
    const { effectiveCenter, halfPct: effectiveHalf, offsetPct } = computeHitZoneGeometry({
      bpm: speed,
      audioLatencyMs: settings.audioLatencyMs,
      displayLatencyMs: settings.displayLatencyMs,
      containerWidthPx: containerWidth,
      crosshairHalfPx: 80,
    });
    setHitZoneGeometry({ centerPct: effectiveCenter, halfPct: effectiveHalf, offsetPct });

    if (!isRunning || !isRecording) return;

    const hit = checkHit(isSounding && isQualitySample, effectiveHalf);
    if (hit) {
      // Mark as hit but DON'T send note_event yet — wait for zone exit
      // so we have the full audio capture.  sentNoteIds is NOT updated
      // here; the zone-exit handler will send the event.
    }
  });

  // Send note_event for notes that have exited the hit zone (audio captured).
  // Both hits and misses are sent here to ensure we always have the full
  // per-note audio segment attached.
  useEffect(() => {
    for (const note of notes) {
      if (sentNoteIds.current.has(note.id)) continue;
      if (note.state === "sliding") continue; // still in play

      // Wait for audio capture to complete before sending.
      // For hits, audioSegment is set when the note exits the hit zone.
      // For misses, it's set at zone exit or screen exit.
      // Only send without audio if capture was never started.
      if (note.captureStarted && !note.audioSegment) continue;

      const isHit = note.state === "hit";
      sendNoteEvent(
        note.syllable,
        isHit,
        {
          fft_pitch_hz: pitchHz,
          target_frequency_hz: scaleFrequencies[note.syllable],
        },
        note.audioSegment ?? null
      );
      sentNoteIds.current.add(note.id);
    }
  }, [notes, sendNoteEvent, pitchHz, scaleFrequencies]);

  const navigate = useNavigate();

  const handleToggle = useCallback(() => {
    if (isRunning) {
      stopGame();
      stopRecording();
      sentNoteIds.current.clear();
    } else {
      startGame();
      startRecording();
    }
  }, [isRunning, startGame, stopGame, startRecording, stopRecording]);

  // Esc key → stop everything and return to main menu
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isRunning) {
          stopGame();
          stopRecording();
          sentNoteIds.current.clear();
        }
        if (isDroning) stopDrone();
        navigate("/");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isRunning, isDroning, stopGame, stopRecording, stopDrone, navigate]);

  return (
    <div className="game-container" ref={containerRef}>
      {/* HUD */}
      <div className="game-hud">

        <div className="hud-left">
          <button
            className={`game-btn ${isRunning ? "stop" : "start"}`}
            onClick={handleToggle}
          >
            {isRunning ? "Stop" : "Start"}
          </button>
          <span className="score-display">
            {score.hits} / {score.hits + score.total}
          </span>
        </div>
        <div className="hud-center">
          <div className="speed-control">
            <span>Speed: {speed} BPM</span>
            <input
              type="range"
              min={10}
              max={120}
              step={5}
              value={speed}
              onChange={(e) => setSpeed(parseInt(e.target.value, 10))}
            />
          </div>
          <div className="speed-control">
            <span>Responsiveness: {acceleration.toFixed(1)}</span>
            <input
              type="range"
              min={0.1}
              max={5.0}
              step={0.1}
              value={acceleration}
              onChange={(e) => setAcceleration(parseFloat(e.target.value))}
            />
          </div>
          <div className="root-note-control">
            <label>Root:</label>
            <input
              type="text"
              className="root-note-input"
              value={rootNote}
              onChange={(e) => handleRootNoteChange(e.target.value)}
            />
          </div>
          <div className="drone-control">
            <button
              className={`game-btn drone ${isDroning ? "active" : ""}`}
              onClick={() => (isDroning ? stopDrone() : startDrone())}
            >
              {isDroning ? "🔊 Drone" : "🔇 Drone"}
            </button>
            <input
              type="range"
              min={0}
              max={0.3}
              step={0.01}
              value={droneVolume}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setDroneVolumeState(v);
                setDroneVolume(v);
              }}
            />
          </div>
          <label className="debug-toggle">
            <input
              type="checkbox"
              checked={showDebug}
              onChange={(e) => setShowDebug(e.target.checked)}
            />
            Debug
          </label>
        </div>
        <div className="hud-right">
          <span
            className={`connection-badge ${isConnected ? "connected" : "disconnected"}`}
          >
            {isConnected ? "● Connected" : "● Disconnected"}
          </span>
        </div>
      </div>

      {/* Staff lines and labels */}
      {SOLFEGE_LABELS.map((s) => {
        const y = syllableY(s);
        return (
          <div key={s}>
            <div className="staff-line" style={{ top: `${y}%` }} />
            <div className="staff-label" style={{ top: `${y}%` }}>
              {s}
            </div>
          </div>
        );
      })}

      {/* Crosshair.  Width is derived from the same helper that powers the
          debug overlay so the cyan box and the yellow debug box are
          geometrically identical by construction (see #109). */}
      <WaveformCrosshair analyserNode={analyserNode} x={CROSSHAIR_X} isRecording={isRecording} />
      <div
        className="crosshair-zone"
        style={{
          left: `${CROSSHAIR_X}%`,
          width: hitZoneGeometry ? `${hitZoneGeometry.halfPct * 2}%` : "160px",
          transform: "translateX(-50%)",
        }}
      />

      {/* Debug: actual hit zone overlay */}
      {showDebug && debugHitZone && (
        <div
          className="debug-hit-zone"
          style={{
            left: `${debugHitZone.centerPct - debugHitZone.halfPct}%`,
            width: `${debugHitZone.halfPct * 2}%`,
          }}
        >
          {debugHitZone.offsetPct > 0 && (
            <div
              className="debug-latency-offset"
              style={{
                left: "0%",
                width: `${Math.min(1, debugHitZone.offsetPct / (debugHitZone.halfPct * 2)) * 100}%`,
              }}
            />
          )}
          <div className="debug-hit-zone-center" style={{ left: "50%" }} />
        </div>
      )}

      {/* Pitch indicator bar */}
      <PitchBar displayPitchHz={displayPitchHz} opacity={pitchOpacity} notePoints={notePoints} />

      {/* Onset flash indicator */}
      <OnsetFlash onsetCount={onsetCount} active={isRunning} />

      {/* Notes */}
      {notes.map((note) => (
        <NoteSprite key={note.id} note={note} containerRef={containerRef} />
      ))}

      {/* Debug HUD */}
      {showDebug && (
        <div className="debug-hud">
          <span className="debug-note">
            Note: {avgPitchHz !== null ? hzToNoteName(avgPitchHz) : "—"}
          </span>
          <span className="debug-pitch">
            Pitch: {avgPitchHz !== null ? `${avgPitchHz.toFixed(1)} Hz` : "—"}
          </span>
          <span className="debug-pitch">
            Bar Y: {displayPitchHz !== null ? `${freqToY(displayPitchHz, notePoints).toFixed(1)}%` : "—"}
          </span>
          <div className="volume-meter">
            <div
              className="volume-meter-fill"
              style={{ height: `${Math.min(volume * 500, 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
