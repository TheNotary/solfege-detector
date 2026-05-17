import { useEffect, useRef } from "react";
import "./WaveformCrosshair.css";

interface WaveformCrosshairProps {
  analyserNode: AnalyserNode | null;
  x: number;
  isRecording: boolean;
}

const CANVAS_WIDTH = 80;
const CYAN = "rgba(0, 200, 255, 1)";
const CYAN_GLOW = "rgba(0, 200, 255, 0.4)";

/**
 * Soft-knee compressor: boosts quiet signals while clamping loud ones.
 * Input `v` is a linear amplitude in [-1, 1].  Output is compressed into
 * the same range, preserving sign.
 *
 * `knee` (0-1) controls the crossover point; `ratio` is the compression
 * ratio above the knee (e.g. 4 means 4:1 compression).
 */
const COMP_KNEE = 0.15; // signals below 15% amplitude get boosted
const COMP_RATIO = 4;
const NOISE_GATE_THRESHOLD = 0.015; // RMS below this → flat line
function compress(v: number): number {
  const sign = v < 0 ? -1 : 1;
  const abs = Math.abs(v);
  if (abs <= COMP_KNEE) {
    // Below knee: linear gain that maps knee → knee*ratio factor
    // We boost so that COMP_KNEE maps to COMP_KNEE + (1-COMP_KNEE)/COMP_RATIO
    const gain = 1 + (1 - COMP_KNEE) / (COMP_KNEE * COMP_RATIO);
    return sign * Math.min(abs * gain, 1);
  }
  // Above knee: compressed (ratio:1)
  const compressed = COMP_KNEE + (abs - COMP_KNEE) / COMP_RATIO;
  // Normalize so full-scale (1.0) → 1.0
  const kneeOut = COMP_KNEE + (1 - COMP_KNEE) / COMP_RATIO;
  return sign * Math.min(compressed / kneeOut, 1);
}

export default function WaveformCrosshair({
  analyserNode,
  x,
  isRecording,
}: WaveformCrosshairProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  const dataArrayRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Resize canvas to fill the parent container's full height with HiDPI scaling.
    // Canvas elements don't stretch via top/bottom: 0 like divs, so we
    // explicitly sync the height from the parent and window resize events.
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const parent = canvas.parentElement;
      const h = parent ? parent.clientHeight : window.innerHeight;
      canvas.style.height = `${h}px`;
      canvas.width = CANVAS_WIDTH * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    // Observe the parent container so we catch layout changes (not the
    // canvas itself, which won't resize on its own).
    const parent = canvas.parentElement;
    const observer = new ResizeObserver(resize);
    if (parent) observer.observe(parent);
    window.addEventListener("resize", resize);
    resize();

    // Allocate data buffer when analyser becomes available
    if (analyserNode && !dataArrayRef.current) {
      dataArrayRef.current = new Uint8Array(analyserNode.frequencyBinCount);
    }

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = CANVAS_WIDTH;
      const h = canvas.height / dpr;
      const cx = w / 2;

      ctx.clearRect(0, 0, w, h);

      const hasSignal = analyserNode && isRecording && dataArrayRef.current;

      if (hasSignal) {
        // Ensure buffer is allocated
        if (!dataArrayRef.current) {
          dataArrayRef.current = new Uint8Array(analyserNode.frequencyBinCount);
        }
        const data = dataArrayRef.current;
        analyserNode.getByteTimeDomainData(data);

        const len = data.length;
        const maxAmplitude = w * 0.45; // max horizontal displacement

        // Noise gate: compute RMS and suppress when below threshold
        let sumSq = 0;
        for (let i = 0; i < len; i++) {
          const s = (data[i] - 128) / 128;
          sumSq += s * s;
        }
        const rms = Math.sqrt(sumSq / len);
        const gateOpen = rms >= NOISE_GATE_THRESHOLD;

        // --- Glow pass ---
        ctx.save();
        ctx.strokeStyle = CYAN_GLOW;
        ctx.lineWidth = 6;
        ctx.shadowColor = CYAN_GLOW;
        ctx.shadowBlur = 16;
        ctx.beginPath();
        for (let i = 0; i < len; i++) {
          const yFrac = i / (len - 1);
          const y = yFrac * h;
          const linear = (data[i] - 128) / 128;
          const xOffset = gateOpen ? compress(linear) * maxAmplitude : 0;
          if (i === 0) {
            ctx.moveTo(cx + xOffset, y);
          } else {
            ctx.lineTo(cx + xOffset, y);
          }
        }
        ctx.stroke();
        ctx.restore();

        // --- Core line pass ---
        ctx.save();
        ctx.strokeStyle = CYAN;
        ctx.lineWidth = 1.5;
        ctx.shadowColor = CYAN;
        ctx.shadowBlur = 4;
        ctx.beginPath();
        for (let i = 0; i < len; i++) {
          const yFrac = i / (len - 1);
          const y = yFrac * h;
          const linear = (data[i] - 128) / 128;
          const xOffset = gateOpen ? compress(linear) * maxAmplitude : 0;
          if (i === 0) {
            ctx.moveTo(cx + xOffset, y);
          } else {
            ctx.lineTo(cx + xOffset, y);
          }
        }
        ctx.stroke();
        ctx.restore();
      } else {
        // Fallback: static vertical center line
        ctx.save();
        ctx.strokeStyle = CYAN;
        ctx.lineWidth = 2;
        ctx.shadowColor = CYAN_GLOW;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, h);
        ctx.stroke();
        ctx.restore();
      }

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafRef.current);
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [analyserNode, isRecording]);

  return (
    <canvas
      ref={canvasRef}
      className="waveform-crosshair"
      style={{
        left: `${x}%`,
        width: `${CANVAS_WIDTH}px`,
        transform: "translateX(-50%)",
      }}
    />
  );
}
