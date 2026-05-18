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
import { useClickMask } from "../hooks/useClickMask";
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

/**
 * Hot-path helper used by the four display-side callbacks (raw + filtered
 * volume, raw + filtered onset feed). Bails the consumer if the toggle is
 * on, an `AudioContext` is available, and `AudioContext.currentTime` falls
 * inside any predicted click-leakage window. Returns `false` (i.e. "not
 * masked, forward the sample") if anything is missing so we never silently
 * drop data when the mask isn't wired up yet.
 */
function isClickMaskedNow(
  audioContextRef: React.MutableRefObject<AudioContext | null>,
  clickMaskEnabledRef: React.MutableRefObject<boolean>,
  clickMask: { isMaskedAt: (audioTime: number) => boolean },
): boolean {
  if (!clickMaskEnabledRef.current) return false;
  const ctx = audioContextRef.current;
  if (!ctx) return false;
  return clickMask.isMaskedAt(ctx.currentTime);
}

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

  // Predicted mic-arrival windows for each scheduled metronome click. The
  // four display-side callbacks below consult this to drop click leakage
  // before it can trip hit/onset detection.
  //
  // Delay source priority (per click):
  //   1. Live AEC-measured delay (`aecStats.delaySamples`) when AEC is
  //      running. This is the actual speaker→mic round-trip in samples
  //      and tracks the hardware in real time.
  //   2. Persisted/calibrated `audioLatencyMs` setting. Filled in by the
  //      auto-calibrator the first time AEC runs and persisted across
  //      sessions, so masking works when AEC is later toggled off.
  // Both sources can be 0 if neither has run; the mask just lands on the
  // click's play time, which the user will see as a too-narrow dip.
  const audioLatencyMsRef = useRef(settings.audioLatencyMs);
  audioLatencyMsRef.current = settings.audioLatencyMs;
  const aecDelayMsRef = useRef(0);
  const clickMask = useClickMask({
    getDelayMs: () => {
      const aec = aecDelayMsRef.current;
      if (aec > 0) return aec;
      return audioLatencyMsRef.current;
    },
  });
  // Live mirrors consumed by the hot callbacks below so they don't need to
  // be reconstructed (and the AEC `filteredActiveRef` ordering preserved)
  // on every settings change.
  const clickMaskEnabledRef = useRef(settings.clickMaskEnabled);
  clickMaskEnabledRef.current = settings.clickMaskEnabled;
  const audioContextRef = useRef<AudioContext | null>(null);

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
  // Mirror the same node into a ref so the calibration effect (which lives
  // higher up in the file than `useReferenceMix`) can emit probe ticks
  // straight into the reference channel without re-firing on every
  // referenceMix identity change.
  const referenceMixRef = useRef<AudioNode | null>(null);

  // Dedup raw vs. filtered display-side callbacks without referencing the
  // hook's own destructured result (which would be a TDZ access). As soon as
  // the first filtered frame arrives we flip `filteredActiveRef` and ignore
  // subsequent raw events for the same consumers; an effect below resets the
  // flag when the AEC tears down so raw events resume.
  const filteredActiveRef = useRef(false);

  const onVolumeRaw = useCallback(
    (rms: number) => {
      if (filteredActiveRef.current) return;
      if (isClickMaskedNow(audioContextRef, clickMaskEnabledRef, clickMask)) return;
      onVolume(rms);
    },
    [onVolume, clickMask],
  );
  const onVolumeFilteredCb = useCallback(
    (rms: number) => {
      filteredActiveRef.current = true;
      if (isClickMaskedNow(audioContextRef, clickMaskEnabledRef, clickMask)) return;
      onVolume(rms);
    },
    [onVolume, clickMask],
  );
  const feedSamplesRaw = useCallback(
    (samples: Float32Array) => {
      if (filteredActiveRef.current) return;
      if (isClickMaskedNow(audioContextRef, clickMaskEnabledRef, clickMask)) return;
      feedSamples(samples);
    },
    [feedSamples, clickMask],
  );
  const feedSamplesFiltered = useCallback(
    (samples: Float32Array) => {
      filteredActiveRef.current = true;
      if (isClickMaskedNow(audioContextRef, clickMaskEnabledRef, clickMask)) return;
      feedSamples(samples);
    },
    [feedSamples, clickMask],
  );

  const { startRecording, stopRecording, isRecording, analyserNode, filteredAnalyserNode, aecStats, audioContext, startNoteCapture: startNoteCaptureRaw, stopNoteCapture } =
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

  // Mirror the live `audioContext` into a ref so the hot click-mask check
  // in the four display-side callbacks doesn't have to be re-bound (and
  // doesn't disturb the AEC `filteredActiveRef` ordering) every time the
  // context (re)appears.
  useEffect(() => {
    audioContextRef.current = audioContext;
  }, [audioContext]);

  // Drop any in-flight mask windows the moment the toggle flips off, so a
  // straggler "almost expired" window doesn't continue suppressing samples
  // after the user disables click masking.
  useEffect(() => {
    if (!settings.clickMaskEnabled) {
      clickMask.clear();
    }
  }, [settings.clickMaskEnabled, clickMask]);

  // Track the live AEC-measured speaker→mic round-trip in ms so the click
  // mask centres its windows on the actual mic-arrival time rather than
  // the (often-stale) persisted `audioLatencyMs` setting. Only mirrored
  // while AEC is running and we have a sample rate to convert with; the
  // mask's `getDelayMs` falls back to `audioLatencyMs` when this is 0.
  useEffect(() => {
    const sr = audioContext?.sampleRate ?? 0;
    if (aecStats && sr > 0 && aecStats.delaySamples > 0) {
      aecDelayMsRef.current = (aecStats.delaySamples / sr) * 1000;
    } else {
      aecDelayMsRef.current = 0;
    }
  }, [aecStats, audioContext]);


  // When the debug flag is on, surface AEC stats updates — but only when
  // something interesting is happening. Without filtering this fires
  // ~10/sec and floods the console with "delay=0 ref=-200 reduction=0.0 dB"
  // lines that contain no actionable information.
  //
  // We log a line when:
  //   - the reference channel is active (refEnergyDb > -100), AND
  //   - the displayed line differs from the last one logged (delay changed,
  //     or reduction changed by more than 0.5 dB, or mic/ref by more than
  //     3 dB), OR
  //   - more than 5 s have elapsed since the last log (heartbeat).
  //
  // Empirical baselines (measured 2026-05-17 after bd #134 broadband-probe
  // calibration shipped, on a laptop with built-in speakers + USB mic at
  // ~1 ft, calibrated delay ≈ 37 ms / 1654 samples):
  //   - Drone (sustained sine) playing:        reduction ≈ 18–25 dB ✓ working
  //   - Metronome clicks (transient) playing:  reduction ≈ 0–3 dB   ✗ not canceling
  //   - No reference signal:                   reduction = 0 dB     (expected)
  // The click-cancellation gap is a separate problem from bulk-delay
  // calibration: transients are too short for the NLMS FIR (mu=0.2,
  // 256 taps) to adapt during the click itself, and the steady-state FIR
  // learned from drone audio doesn't generalize to the speaker's impulse
  // response for a wideband click. Likely fixes for a future issue:
  // longer FIR, frequency-domain block adaptation, or a separate
  // pre-trained impulse-response convolver fed from known click samples.
  //
  // The `regime` annotation appended to each log line names which of these
  // baselines the current numbers fall into, so a future debug session can
  // scan the log for the regime that's misbehaving without needing to
  // re-derive the thresholds from scratch.
  const lastAecLogRef = useRef<{
    line: string;
    delaySamples: number;
    reductionDb: number;
    micEnergyDb: number;
    refEnergyDb: number;
    at: number;
  } | null>(null);
  useEffect(() => {
    if (!settings.logAecDetails) {
      lastAecLogRef.current = null;
      return;
    }
    if (!aecStats) return;
    if (aecStats.refEnergyDb < -100) return; // reference silent — nothing to say
    const reductionDb = aecStats.micEnergyDb - aecStats.residualDb;
    const now = performance.now();
    const last = lastAecLogRef.current;
    const changed =
      !last ||
      last.delaySamples !== aecStats.delaySamples ||
      Math.abs(last.reductionDb - reductionDb) > 0.5 ||
      Math.abs(last.micEnergyDb - aecStats.micEnergyDb) > 3 ||
      Math.abs(last.refEnergyDb - aecStats.refEnergyDb) > 3 ||
      now - last.at > 5000;
    if (!changed) return;
    // Tag the line with the regime so future grep'ing the log can find
    // "drone canceling well" vs "click not canceling" frames at a glance.
    // Thresholds chosen from the empirical baselines in the comment above.
    let regime: string;
    if (reductionDb >= 15) {
      regime = "drone-class ✓"; // sustained tone, FIR has converged
    } else if (reductionDb >= 5) {
      regime = "partial";
    } else if (reductionDb <= -3) {
      regime = "divergent ✗"; // FIR is adding noise — usually stale delay
    } else {
      // Near-zero reduction with active reference. Most often: transient
      // click that the FIR can't catch in time.
      regime = "transient/uncanceled";
    }
    const line =
      `[AEC debug] delay=${aecStats.delaySamples} samples taps=${aecStats.taps} ` +
      `mic=${aecStats.micEnergyDb.toFixed(1)} ref=${aecStats.refEnergyDb.toFixed(1)} ` +
      `residual=${aecStats.residualDb.toFixed(1)} reduction=${reductionDb.toFixed(1)} dB ` +
      `[${regime}]`;
    console.log(line);
    lastAecLogRef.current = {
      line,
      delaySamples: aecStats.delaySamples,
      reductionDb,
      micEnergyDb: aecStats.micEnergyDb,
      refEnergyDb: aecStats.refEnergyDb,
      at: now,
    };
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
    referenceMixRef.current = referenceMix;
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
      clickMask.clear();
      sentNoteIds.current.clear();
    } else {
      startGame();
      startRecording();
      if (metronomeEnabled) {
        metronome.start({
          getBpm: () => bpmRef.current,
          getOffsetSec: () => metronomeOffsetMsRef.current / 1000,
          onClickScheduled: (audioTime) => {
            if (clickMaskEnabledRef.current) clickMask.recordClick(audioTime);
          },
        });
      }
    }
  }, [isRunning, startGame, stopGame, startRecording, stopRecording, metronome, metronomeEnabled, clickMask]);

  // Start/stop the metronome live when the toggle flips during a running game.
  useEffect(() => {
    if (!isRunning) return;
    if (metronomeEnabled && !metronome.isRunning()) {
      metronome.start({
        getBpm: () => bpmRef.current,
        getOffsetSec: () => metronomeOffsetMsRef.current / 1000,
        onClickScheduled: (audioTime) => {
          if (clickMaskEnabledRef.current) clickMask.recordClick(audioTime);
        },
      });
    } else if (!metronomeEnabled && metronome.isRunning()) {
      metronome.stop();
      clickMask.clear();
    }
  }, [isRunning, metronomeEnabled, metronome, clickMask]);

  // Esc key → stop everything and return to main menu
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isRunning) {
          stopGame();
          stopRecording();
          metronome.stop();
          clickMask.clear();
          sentNoteIds.current.clear();
        }
        if (isDroning) stopDrone();
        navigate("/");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isRunning, isDroning, stopGame, stopRecording, stopDrone, navigate, metronome, clickMask]);

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
      <WaveformCrosshair
        analyserNode={displayAnalyserNode}
        x={CROSSHAIR_X}
        isRecording={isRecording}
        clickMask={settings.clickMaskEnabled ? clickMask : null}
        audioContext={audioContext}
      />
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
