import { useNavigate } from "react-router-dom";
import { useGameSettings } from "../hooks/useGameSettings";
import "./MainMenu.css";

export default function MainMenu() {
  const navigate = useNavigate();
  const { settings } = useGameSettings();

  const hasCalibration =
    settings.audioLatencyMs !== 0 || settings.displayLatencyMs !== 0;

  return (
    <div className="main-menu">
      <h1>Solfege Detector</h1>

      <button className="menu-btn" onClick={() => navigate("/play")}>
        Play Game
      </button>

      <button className="menu-btn" onClick={() => navigate("/calibrate")}>
        Calibrate Latency
      </button>
      <div className={`calibration-status ${hasCalibration ? "calibrated" : ""}`}>
        {hasCalibration
          ? `Audio: ${settings.audioLatencyMs}ms · Display: ${settings.displayLatencyMs}ms`
          : "Not calibrated"}
      </div>

      <button className="menu-btn" onClick={() => navigate("/config")}>
        Configurations
      </button>
    </div>
  );
}
