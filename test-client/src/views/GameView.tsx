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
import { useOnsetDetection } from "../hooks/useOnsetDetection";
import OnsetFlash from "../components/OnsetFlash";
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
  } = useGameEngine({ startNoteCapture, stopNoteCapture });

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
      // Stop capture NOW to grab the audio accumulated so far.
      // The note is still in the hit zone — stopNoteCapture hasn't been
      // called by the game loop yet (that happens at zone exit).
      // Setting audioSegment here prevents the game loop from calling
      // stopNoteCapture again (it checks !note.audioSegment).
      const segment = stopNoteCapture?.() ?? null;
      const hitNote = notes.find((n) => n.id === hit.noteId);
      if (hitNote && segment) {
        hitNote.audioSegment = segment;
      }
      sendNoteEvent(
        hit.syllable,
        true,
        {
          fft_pitch_hz: pitchHz,
          target_frequency_hz: hit.targetFrequencyHz,
        },
        segment
      );
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
        sendNoteEvent(
          note.syllable,
          false,
          {
            fft_pitch_hz: pitchHz,
            target_frequency_hz: TARGET_FREQUENCIES[note.syllable],
          },
          note.audioSegment ?? null
        );
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

      {/* Onset flash indicator */}
      <OnsetFlash onsetCount={onsetCount} active={isRunning} />

      {/* Notes */}
      {notes.map((note) => (
        <NoteSprite key={note.id} note={note} containerRef={containerRef} />
      ))}

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
