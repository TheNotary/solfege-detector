import { useCallback, useEffect, useRef } from "react";
import "./GameView.css";
import NoteSprite from "../components/NoteSprite";
import { useGameEngine, CROSSHAIR_X, syllableY } from "../hooks/useGameEngine";
import { useVolumeDetection } from "../hooks/useVolumeDetection";
import { useAudioStream } from "../hooks/useAudioStream";
import { useWebSocket } from "../hooks/useWebSocket";
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

  const { startRecording, stopRecording, isRecording } = useAudioStream({
    onChunk,
    onVolume,
  });

  // Check for hits every frame when running
  useEffect(() => {
    if (!isRunning || !isRecording) return;
    const hit = checkHit(isSounding);
    if (hit) {
      sendNoteEvent(hit.syllable, true);
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
        sendNoteEvent(note.syllable, false);
        sentNoteIds.current.add(note.id);
      }
    }
  }, [notes, sendNoteEvent]);

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

      {/* Notes */}
      {notes.map((note) => (
        <NoteSprite key={note.id} note={note} containerRef={containerRef} />
      ))}

      {/* HUD */}
      <div className="game-hud">
        <div className="hud-left">
          <span
            className={`connection-badge ${isConnected ? "connected" : "disconnected"}`}
          >
            {isConnected ? "Connected" : "Disconnected"}
          </span>
          <button
            className={`game-btn ${isRunning ? "stop" : "start"}`}
            onClick={handleToggle}
          >
            {isRunning ? "Stop" : "Start"}
          </button>
        </div>
        <div className="hud-right">
          <span className="score-display">
            {score.hits} / {score.hits + score.total}
          </span>
        </div>
      </div>

      {/* Bottom controls */}
      <div className="game-controls">
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
