import { useState } from "react";
import { useNavigate } from "react-router-dom";
import AudioCalibration from "../components/AudioCalibration";
import DisplayCalibration from "../components/DisplayCalibration";
import "./CalibrateView.css";

type Phase = "audio" | "display";

export default function CalibrateView() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("audio");

  return (
    <div className="calibrate-view">
      <div className="calibrate-header">
        <h2>Calibrate Latency</h2>

        <div className="calibrate-tabs">
          <button
            className={`calibrate-tab ${phase === "audio" ? "active" : ""}`}
            onClick={() => setPhase("audio")}
          >
            Audio Latency
          </button>
          <button
            className={`calibrate-tab ${phase === "display" ? "active" : ""}`}
            onClick={() => setPhase("display")}
          >
            Display Latency
          </button>
        </div>

        <button className="back-btn" onClick={() => navigate("/")}>
          ← Menu
        </button>
      </div>

      <div className="calibrate-body">
        {phase === "audio" ? (
          <AudioCalibration onSkip={() => setPhase("display")} />
        ) : (
          <DisplayCalibration onSkip={() => navigate("/")} />
        )}
      </div>
    </div>
  );
}
