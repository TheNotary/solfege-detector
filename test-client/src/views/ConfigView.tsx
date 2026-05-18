import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useGameSettings, type GameSettings } from "../hooks/useGameSettings";
import LatencyCalibrator from "../components/LatencyCalibrator";
import "./ConfigView.css";

export default function ConfigView() {
  const navigate = useNavigate();
  const { settings, updateSettings } = useGameSettings();

  // Local draft state — not persisted until Save
  const [draft, setDraft] = useState<GameSettings>({ ...settings });

  const set = <K extends keyof GameSettings>(key: K, value: GameSettings[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const handleSave = () => {
    updateSettings(draft);
    navigate("/");
  };

  const handleCancel = () => {
    navigate("/");
  };

  return (
    <div className="config-view">
      <h2>Configurations</h2>

      <div className="config-form">
        {/* Speed */}
        <div className="config-field">
          <label>Speed</label>
          <div className="field-row">
            <input
              type="range"
              min={10}
              max={120}
              step={5}
              value={draft.speed}
              onChange={(e) => set("speed", parseInt(e.target.value, 10))}
            />
            <span className="field-value">{draft.speed} BPM</span>
          </div>
        </div>

        {/* Responsiveness */}
        <div className="config-field">
          <label>Responsiveness</label>
          <div className="field-row">
            <input
              type="range"
              min={0.1}
              max={5.0}
              step={0.1}
              value={draft.acceleration}
              onChange={(e) => set("acceleration", parseFloat(e.target.value))}
            />
            <span className="field-value">{draft.acceleration.toFixed(1)}</span>
          </div>
        </div>

        {/* Root Note */}
        <div className="config-field">
          <label>Root Note</label>
          <input
            type="text"
            value={draft.rootNote}
            onChange={(e) => set("rootNote", e.target.value)}
          />
        </div>

        {/* Drone Volume */}
        <div className="config-field">
          <label>Drone Volume</label>
          <div className="field-row">
            <input
              type="range"
              min={0}
              max={0.3}
              step={0.01}
              value={draft.droneVolume}
              onChange={(e) => set("droneVolume", parseFloat(e.target.value))}
            />
            <span className="field-value">
              {(draft.droneVolume * 100).toFixed(0)}%
            </span>
          </div>
        </div>

        {/* Debug */}
        <div className="config-field">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.showDebug}
              onChange={(e) => set("showDebug", e.target.checked)}
            />
            Show Debug HUD
          </label>
        </div>

        {/* Hitzone offset overlay */}
        <div className="config-field">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.showHitzoneOffset}
              onChange={(e) => set("showHitzoneOffset", e.target.checked)}
            />
            Show hitzone offset
          </label>
        </div>

        {/* Feedback cancellation toggle */}
        <div className="config-field">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.feedbackCancellation}
              onChange={(e) => set("feedbackCancellation", e.target.checked)}
            />
            Cancel drone/metronome bleed from waveform
          </label>
          <small className="field-help">
            Only affects the on-screen waveform and hit-zone visual feedback.
            The audio captured for training is always recorded raw.
          </small>
        </div>

        {/* Vocal-range bandpass toggle */}
        <div className="config-field">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.vocalBandpassEnabled}
              onChange={(e) => set("vocalBandpassEnabled", e.target.checked)}
            />
            Vocal-range filter (80–1100 Hz)
          </label>
          <small className="field-help">
            Blocks thunder/rumble &amp; high-frequency noise from triggering
            confetti, onset flashes, or jiggling the waveform. Affects
            display only; training audio sent to the backend stays raw.
          </small>
        </div>

        {/* Click-mask toggle */}
        <div className="config-field">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.clickMaskEnabled}
              onChange={(e) => set("clickMaskEnabled", e.target.checked)}
            />
            Mask metronome clicks from hit detection
          </label>
          <small className="field-help">
            Suppresses hits caused by metronome clicks bleeding into the
            mic. Uses the calibrated audio latency to predict when each
            click reaches the mic and briefly blanks the volume gate,
            onset detector, and waveform during that window. Audio sent
            to the backend is unaffected.
          </small>
        </div>

        {/* Audio latency calibration */}
        <div className="config-field">
          <label>Audio Latency</label>
          <LatencyCalibrator />
          <small className="field-help">
            Measures the round-trip from your speakers back into the mic.
            Plays two short white-noise bursts (~0.3 s total) and saves
            the result. Used by the click-mask above and by Feedback
            Cancellation to align its echo cancellation. Re-run when you
            change audio devices.
          </small>
        </div>

        {/* AEC debug logging toggle */}
        <div className="config-field">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.logAecDetails}
              onChange={(e) => set("logAecDetails", e.target.checked)}
            />
            Log AEC Cancelation Details
          </label>
          <small className="field-help">
            Prints calibration result, applied delay, and per-update mic vs.
            residual energy (reduction in dB) to the browser console. Use
            this to diagnose why clicks aren&apos;t cancelling.
          </small>
        </div>

        {/* Actions */}
        <div className="config-actions">
          <button className="save-btn" onClick={handleSave}>
            Save
          </button>
          <button className="cancel-btn" onClick={handleCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
