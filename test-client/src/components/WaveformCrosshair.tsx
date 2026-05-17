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
          const xOffset = ((data[i] - 128) / 128) * maxAmplitude;
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
          const xOffset = ((data[i] - 128) / 128) * maxAmplitude;
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
