import { useCallback, useEffect, useRef, useState } from "react";
import AppConfig from "../AppConfig";
import { DetectionMessage, useWebSocket } from "../hooks/useWebSocket";
import { useAudioStream } from "../hooks/useAudioStream";

interface LogEntry {
  syllable: string;
  confidence: number;
  timestamp: Date;
}

export default function Home() {
  const [threshold, setThreshold] = useState(0.5);
  const [log, setLog] = useState<LogEntry[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const { send, sendConfig, lastMessage, isConnected } = useWebSocket(
    AppConfig.SOCKET_URL
  );

  const onChunk = useCallback(
    (chunk: ArrayBuffer) => {
      send(chunk);
    },
    [send]
  );

  const { startRecording, stopRecording, isRecording } = useAudioStream(onChunk);

  // Handle detection messages
  useEffect(() => {
    if (!lastMessage) return;
    const entry: LogEntry = {
      syllable: lastMessage.syllable,
      confidence: lastMessage.confidence,
      timestamp: new Date(),
    };
    console.log(
      `[detection] ${entry.syllable} (${(entry.confidence * 100).toFixed(1)}%)`
    );
    setLog((prev) => [entry, ...prev].slice(0, 200));
  }, [lastMessage]);

  // Send config when threshold changes
  useEffect(() => {
    sendConfig({ confidence_threshold: threshold });
  }, [threshold, sendConfig]);

  return (
    <div style={{ maxWidth: 600, margin: "0 auto", padding: "2rem" }}>
      <h1>Solfege Detector</h1>

      {/* Connection status */}
      <div style={{ marginBottom: "1rem" }}>
        <span
          style={{
            display: "inline-block",
            padding: "0.25rem 0.75rem",
            borderRadius: "1rem",
            fontSize: "0.85rem",
            fontWeight: 600,
            color: "#fff",
            backgroundColor: isConnected ? "#22c55e" : "#ef4444",
          }}
        >
          {isConnected ? "Connected" : "Disconnected"}
        </span>
      </div>

      {/* Controls */}
      <div style={{ marginBottom: "1.5rem" }}>
        <button
          onClick={isRecording ? stopRecording : startRecording}
          style={{
            padding: "0.75rem 2rem",
            fontSize: "1rem",
            borderRadius: "0.5rem",
            border: "none",
            cursor: "pointer",
            backgroundColor: isRecording ? "#ef4444" : "#3b82f6",
            color: "#fff",
            fontWeight: 600,
          }}
        >
          {isRecording ? "Stop" : "Start"}
        </button>
      </div>

      {/* Threshold slider */}
      <div style={{ marginBottom: "1.5rem" }}>
        <label style={{ display: "block", marginBottom: "0.5rem" }}>
          Confidence Threshold: {threshold.toFixed(2)}
        </label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={threshold}
          onChange={(e) => setThreshold(parseFloat(e.target.value))}
          style={{ width: "100%" }}
        />
      </div>

      {/* Detection log */}
      <h2>Detections</h2>
      <div
        ref={logRef}
        style={{
          maxHeight: 400,
          overflowY: "auto",
          border: "1px solid #333",
          borderRadius: "0.5rem",
          padding: "0.5rem",
        }}
      >
        {log.length === 0 && (
          <p style={{ color: "#888", textAlign: "center" }}>
            No detections yet. Press Start to begin.
          </p>
        )}
        {log.map((entry, i) => (
          <div
            key={i}
            style={{
              padding: "0.4rem 0.6rem",
              borderBottom: i < log.length - 1 ? "1px solid #222" : undefined,
              fontFamily: "monospace",
              fontSize: "0.9rem",
            }}
          >
            <strong style={{ textTransform: "uppercase" }}>
              {entry.syllable}
            </strong>{" "}
            <span style={{ color: "#888" }}>
              {(entry.confidence * 100).toFixed(1)}%
            </span>{" "}
            <span style={{ color: "#555", fontSize: "0.8rem" }}>
              {entry.timestamp.toLocaleTimeString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
