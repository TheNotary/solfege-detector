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
import { useMetronome } from "../hooks/useMetronome";
import { useReferenceMix } from "../hooks/useReferenceMix";
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
  const { settings, updateSetting } = useGameSettings();

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

  // Forward-declared slot for the reference-mix tap. We can't pass `referenceMix`
  // (built by `useReferenceMix` below) directly into `useAudioStream`, because
  // `useReferenceMix` itself needs the `AudioContext` that `useAudioStream`
  // creates. We bridge with a state slot: a small effect below syncs the real
  // node into this slot once both halves of the graph exist, which triggers
  // the AEC effect inside `useAudioStream` to wire up the worklet.
  const [referenceNode, setReferenceNode] = useState<AudioNode | null>(null);

  // Dedup raw vs. filtered display-side callbacks without referencing the
  // hook's own destructured result (which would be a TDZ access). As soon as
  // the first filtered frame arrives we flip `filteredActiveRef` and ignore
  // subsequent raw events for the same consumers; an effect below resets the
  // flag when the AEC tears down so raw events resume.
  const filteredActiveRef = useRef(false);

  const onVolumeRaw = useCallback(
    (rms: number) => {
      if (filteredActiveRef.current) return;
      onVolume(rms);
    },
    [onVolume],
  );
  const onVolumeFilteredCb = useCallback(
    (rms: number) => {
      filteredActiveRef.current = true;
      onVolume(rms);
    },
    [onVolume],
  );
  const feedSamplesRaw = useCallback(
    (samples: Float32Array) => {
      if (filteredActiveRef.current) return;
      feedSamples(samples);
    },
    [feedSamples],
  );
  const feedSamplesFiltered = useCallback(
    (samples: Float32Array) => {
      filteredActiveRef.current = true;
      feedSamples(samples);
    },
    [feedSamples],
  );

  const { startRecording, stopRecording, isRecording, analyserNode, filteredAnalyserNode, aecStats, audioContext, startNoteCapture: startNoteCaptureRaw, stopNoteCapture, calibrateBulkDelay } =
    useAudioStream({
      onChunk,
      // Display-side consumers prefer the cleaned (AEC) signal when the
      // worklet is running. When it isn't (e.g. before the reference mix is
      // wired up, or AEC disabled), we fall back to the raw mic so the
      // confetti gate and onset detector still work. The raw vs. filtered
      // routing is done via `filteredActiveRef` inside the callbacks above
      // -- referencing `filteredAnalyserNode` directly here would be a TDZ
      // access since it's destructured from this same call.
      onVolume: onVolumeRaw,
      onVolumeFiltered: onVolumeFilteredCb,
      onCaptureChunk: feedSamplesRaw,
      onCaptureChunkFiltered: feedSamplesFiltered,
      trimCapture,
      referenceNode,
      aecEnabled: settings.feedbackCancellation,
      audioInputLatencyMs: settings.audioLatencyMs,
    });

  // Reset the raw/filtered dedup flag whenever the AEC tears down so the raw
  // callbacks resume driving display-side consumers.
  useEffect(() => {
    if (filteredAnalyserNode === null) {
      filteredActiveRef.current = false;
    }
  }, [filteredAnalyserNode]);

  // Auto-calibrate the AEC bulk delay once the worklet is wired up and a
  // probe signal (metronome and/or drone) is available. Without this the
  // user's `audioLatencyMs` setting (default 0) leaves the actual
  // speaker→mic delay completely outside the FIR's reach for transients,
  // so the drone cancels but clicks don't. See bd #127 / #128.
  //
  // The measurement is one-shot per recording session: it fires ~700 ms
  // after the AEC comes online (enough time for several metronome clicks
  // and the drone fade-in), captures ~190 ms of paired (mic, ref), runs a
  // cross-correlation in JS, and — if the peak is confident — pushes the
  // measured delay straight to the worklet via `setLatency`. The persisted
  // `audioLatencyMs` setting is also updated so subsequent sessions skip
  // the warmup hiccup.
  const calibrationDoneRef = useRef(false);
  useEffect(() => {
    if (!filteredAnalyserNode || !isRecording) {
      calibrationDoneRef.current = false;
      return;
    }
    if (calibrationDoneRef.current) return;
    calibrationDoneRef.current = true;

    const timer = setTimeout(async () => {
      try {
        const result = await calibrateBulkDelay({
          windowSamples: 8192, // ~186 ms @ 44.1 kHz
          maxLagSamples: 4410, // ~100 ms search range
          minConfidence: 1.5,
        });
        if (!result) {
          console.warn("[GameView] AEC bulk-delay calibration timed out or returned no data");
          return;
        }
        // Always log the headline result so the user can see at a glance
        // whether calibration ran and what it concluded.
        console.log(
          `[GameView] AEC bulk-delay calibration: delay=${result.delayMs.toFixed(1)} ms ` +
            `(${result.delaySamples} samples @ ${result.sampleRate} Hz) ` +
            `confidence=${result.confidence.toFixed(1)} ` +
            `peak=${result.peakCorrelation.toFixed(3)} ` +
            `applied=${result.applied}`,
        );
        if (settings.logAecDetails) {
          // Extra capture-time diagnostics: if `refRmsDb` is at the
          // silence floor (~ -200) the reference signal isn't reaching
          // the worklet at all and no amount of FIR adaptation will help.
          console.log(
            `[AEC debug] capture window: ${result.windowSamples} samples, ` +
              `micRms=${result.micRmsDb.toFixed(1)} dBFS, ` +
              `refRms=${result.refRmsDb.toFixed(1)} dBFS`,
          );
        }
        if (result.applied) {
          // Persist so future sessions start with a sensible value (also
          // exposed in the Config view for manual override).
          updateSetting("audioLatencyMs", Math.round(result.delayMs * 10) / 10);
        }
      } catch (err) {
        console.error("[GameView] AEC bulk-delay calibration threw:", err);
      }
    }, 700);
    return () => clearTimeout(timer);
  }, [filteredAnalyserNode, isRecording, calibrateBulkDelay, updateSetting, settings.logAecDetails]);

  // When the debug flag is on, surface every AEC stats update (~10/sec).
  // The worklet reports the *currently applied* bulk delay along with the
  // mic/ref/residual energies; the reduction is the difference between mic
  // and residual. If reduction stays near 0 dB while refEnergyDb is high,
  // the FIR can hear the reference but the alignment is still wrong.
  useEffect(() => {
    if (!settings.logAecDetails || !aecStats) return;
    const reductionDb = aecStats.micEnergyDb - aecStats.residualDb;
    console.log(
      `[AEC debug] delay=${aecStats.delaySamples} samples taps=${aecStats.taps} ` +
        `mic=${aecStats.micEnergyDb.toFixed(1)} ref=${aecStats.refEnergyDb.toFixed(1)} ` +
        `residual=${aecStats.residualDb.toFixed(1)} reduction=${reductionDb.toFixed(1)} dB`,
    );
  }, [aecStats, settings.logAecDetails]);

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
  // Hitzone offset overlay toggle (independent of the general debug HUD)
  const [showHitzoneOffset, setShowHitzoneOffset] = useState(() => settings.showHitzoneOffset);

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
  const referenceMix = useReferenceMix(audioContext);
  // Bridge the reference-mix tap up to `useAudioStream` (declared earlier).
  useEffect(() => {
    setReferenceNode(referenceMix);
  }, [referenceMix]);
  const { startDrone, stopDrone, isDroning, setDroneVolume } = useDrone(
    audioContext,
    rootFrequencyHz,
    referenceMix,
  );
  const [droneVolume, setDroneVolumeState] = useState(() => settings.droneVolume);

  // Metronome — clicks aligned to the game's beat clock so the player knows
  // exactly when each sliding note will hit the crosshair.
  const metronome = useMetronome(audioContext, referenceMix);
  const [metronomeEnabled, setMetronomeEnabled] = useState(() => settings.metronomeEnabled);
  const [metronomeVolume, setMetronomeVolumeState] = useState(() => settings.metronomeVolume);
  const [metronomeOffsetMs, setMetronomeOffsetMs] = useState(() => settings.metronomeOffsetMs);
  // Live refs so the metronome's scheduler reads the latest values every beat.
  const bpmRef = useRef(speed);
  bpmRef.current = speed;
  const metronomeOffsetMsRef = useRef(metronomeOffsetMs);
  metronomeOffsetMsRef.current = metronomeOffsetMs;

  // Keep volume in sync.
  useEffect(() => {
    metronome.setVolume(metronomeVolume);
  }, [metronome, metronomeVolume]);

  // Waveform displacement (kept for visual reference / future use)
  // Display-side waveform/hit-zone visuals read from the cleaned analyser
  // when AEC is active; otherwise from the raw analyser (pre-drone or AEC off).
  // The `debugUseRaw` flag (debug HUD only) forces the raw analyser for an
  // A/B comparison without rebuilding the audio graph.
  const [debugUseRaw, setDebugUseRaw] = useState(false);
  const displayAnalyserNode = debugUseRaw
    ? analyserNode
    : (filteredAnalyserNode ?? analyserNode);
  const waveformDisplacement = useWaveformDisplacement(displayAnalyserNode, isRecording);
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
    // Bail out of setState when the computed geometry is unchanged; otherwise
    // this effect (deliberately without a dependency array so it re-runs on
    // every render-driven update) would feed back into itself and trip
    // React's "Maximum update depth exceeded" guard at mount.
    setHitZoneGeometry((prev) => {
      if (
        prev &&
        prev.centerPct === effectiveCenter &&
        prev.halfPct === effectiveHalf &&
        prev.offsetPct === offsetPct
      ) {
        return prev;
      }
      return { centerPct: effectiveCenter, halfPct: effectiveHalf, offsetPct };
    });

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
      metronome.stop();
      sentNoteIds.current.clear();
    } else {
      startGame();
      startRecording();
      if (metronomeEnabled) {
        metronome.start({
          getBpm: () => bpmRef.current,
          getOffsetSec: () => metronomeOffsetMsRef.current / 1000,
        });
      }
    }
  }, [isRunning, startGame, stopGame, startRecording, stopRecording, metronome, metronomeEnabled]);

  // Start/stop the metronome live when the toggle flips during a running game.
  useEffect(() => {
    if (!isRunning) return;
    if (metronomeEnabled && !metronome.isRunning()) {
      metronome.start({
        getBpm: () => bpmRef.current,
        getOffsetSec: () => metronomeOffsetMsRef.current / 1000,
      });
    } else if (!metronomeEnabled && metronome.isRunning()) {
      metronome.stop();
    }
  }, [isRunning, metronomeEnabled, metronome]);

  // Esc key → stop everything and return to main menu
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isRunning) {
          stopGame();
          stopRecording();
          metronome.stop();
          sentNoteIds.current.clear();
        }
        if (isDroning) stopDrone();
        navigate("/");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isRunning, isDroning, stopGame, stopRecording, stopDrone, navigate, metronome]);

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
          <div className="metronome-control">
            <button
              className={`game-btn drone ${metronomeEnabled ? "active" : ""}`}
              onClick={() => {
                const next = !metronomeEnabled;
                setMetronomeEnabled(next);
                updateSetting("metronomeEnabled", next);
              }}
            >
              {metronomeEnabled ? "🥁 Beat" : "🔇 Beat"}
            </button>
            <input
              type="range"
              min={0}
              max={0.6}
              step={0.01}
              value={metronomeVolume}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setMetronomeVolumeState(v);
                updateSetting("metronomeVolume", v);
              }}
            />
            <span className="metronome-offset-label">
              Offset: {metronomeOffsetMs > 0 ? "+" : ""}
              {metronomeOffsetMs} ms
            </span>
            <input
              type="range"
              min={-200}
              max={200}
              step={5}
              value={metronomeOffsetMs}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                setMetronomeOffsetMs(v);
                updateSetting("metronomeOffsetMs", v);
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
          <label className="debug-toggle">
            <input
              type="checkbox"
              checked={showHitzoneOffset}
              onChange={(e) => setShowHitzoneOffset(e.target.checked)}
            />
            Hitzone
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
      <WaveformCrosshair analyserNode={displayAnalyserNode} x={CROSSHAIR_X} isRecording={isRecording} />
      <div
        className="crosshair-zone"
        style={{
          left: `${CROSSHAIR_X}%`,
          width: hitZoneGeometry ? `${hitZoneGeometry.halfPct * 2}%` : "160px",
          transform: "translateX(-50%)",
        }}
      />

      {/* Debug: actual hit zone overlay */}
      {showHitzoneOffset && debugHitZone && (
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
          <span className="debug-pitch">
            AEC: {aecStats
              ? `res ${aecStats.residualDb.toFixed(1)} dB · mic ${aecStats.micEnergyDb.toFixed(1)} dB · ref ${aecStats.refEnergyDb.toFixed(1)} dB · d=${aecStats.delaySamples} · N=${aecStats.taps}`
              : (filteredAnalyserNode ? "…" : "off")}
          </span>
          <label className="debug-toggle">
            <input
              type="checkbox"
              checked={debugUseRaw}
              onChange={(e) => setDebugUseRaw(e.target.checked)}
              disabled={!filteredAnalyserNode}
            />
            A/B: use raw analyser
          </label>
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
