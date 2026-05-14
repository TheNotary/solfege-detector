import { useCallback, useEffect, useRef, useState } from "react";
import "./GameView.css";
import NoteSprite from "../components/NoteSprite";
import PitchBar from "../components/PitchBar";
import { useGameEngine, CROSSHAIR_X, syllableY, TARGET_FREQUENCIES } from "../hooks/useGameEngine";
import { useVolumeDetection } from "../hooks/useVolumeDetection";
import { useAudioStream } from "../hooks/useAudioStream";
import { useWebSocket } from "../hooks/useWebSocket";
import { useAudioQuality } from "../hooks/useAudioQuality";
import { usePitchDetection } from "../hooks/usePitchDetection";
import { useSmoothedPitch } from "../hooks/useSmoothedPitch";
import { useDrone } from "../hooks/useDrone";
import AppConfig from "../AppConfig";

const SOLFEGE_LABELS = ["do", "re", "mi", "fa", "sol", "la", "ti"] as const;

interface GameViewProps {
  isConnected?: boolean;
}

export default function GameView(_props: GameViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sentNoteIds = useRef<Set<number>>(new Set());

  const { send, sendNoteEvent, isConnected } = useWebSocket(AppConfig.SOCKET_URL);
  const { volume, isSounding, onVolume } = useVolumeDetection();
  const {
    notes,
    speed,
    setSpeed,
    score,
    checkHit,
    startGame,
    stopGame,
    isRunning,
  } = useGameEngine();

  const onChunk = useCallback(
    (chunk: ArrayBuffer) => {
      send(chunk);
    },
    [send]
  );

  const { startRecording, stopRecording, isRecording, analyserNode, audioContext } =
    useAudioStream({
      onChunk,
      onVolume,
    });

  const { isQualitySample } = useAudioQuality(analyserNode);
  const { pitchHz } = usePitchDetection(analyserNode);

  // Pitch indicator smoothing
  const [acceleration, setAcceleration] = useState(1.0);
  const { displayPitchHz, opacity: pitchOpacity } = useSmoothedPitch(
    pitchHz,
    acceleration
  );

  // Drone
  const { startDrone, stopDrone, isDroning, setDroneVolume } = useDrone(
    audioContext
  );
  const [droneVolume, setDroneVolumeState] = useState(0.15);

  // Check for hits every frame when running
  useEffect(() => {
    if (!isRunning || !isRecording) return;
    const hit = checkHit(isSounding && isQualitySample);
    if (hit) {
      sendNoteEvent(hit.syllable, true, {
        fft_pitch_hz: pitchHz,
        target_frequency_hz: hit.targetFrequencyHz,
      });
      sentNoteIds.current.add(hit.noteId);
    }
  });

  // Send note_event for notes that cross the crosshair without being hit
  useEffect(() => {
    for (const note of notes) {
      if (
        note.state === "missed" &&
        !sentNoteIds.current.has(note.id)
      ) {
        sendNoteEvent(note.syllable, false, {
          fft_pitch_hz: pitchHz,
          target_frequency_hz: TARGET_FREQUENCIES[note.syllable],
        });
        sentNoteIds.current.add(note.id);
      }
    }
  }, [notes, sendNoteEvent, pitchHz]);

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

  return (
    <div className="game-container" ref={containerRef}>
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

      {/* Crosshair */}
      <div className="crosshair" style={{ left: `${CROSSHAIR_X}%` }} />
      <div
        className="crosshair-zone"
        style={{
          left: `${CROSSHAIR_X - 6}%`,
          width: "12%",
        }}
      />

      {/* Pitch indicator bar */}
      <PitchBar displayPitchHz={displayPitchHz} opacity={pitchOpacity} />

      {/* Notes */}
      {notes.map((note) => (
        <NoteSprite key={note.id} note={note} containerRef={containerRef} />
      ))}

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
        </div>
        <div className="hud-right">
          <span
            className={`connection-badge ${isConnected ? "connected" : "disconnected"}`}
          >
            {isConnected ? "● Connected" : "● Disconnected"}
          </span>
        </div>
      </div>

      {/* Volume meter */}
      <div className="volume-meter">
        <div
          className="volume-meter-fill"
          style={{ height: `${Math.min(volume * 500, 100)}%` }}
        />
      </div>
    </div>
  );
}
