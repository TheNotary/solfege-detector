import { useEffect, useRef } from "react";
import "./WaveformCrosshair.css";

/**
 * Subset of the `useClickMask` return shape this component actually needs.
 * Kept inline to avoid pulling the hook's full type surface and so the
 * component can be exercised in isolation by tests / Storybook.
 */
interface ClickMaskView {
  getWindows: () => ReadonlyArray<{
    readonly startAudioTime: number;
    readonly endAudioTime: number;
  }>;
}

interface WaveformCrosshairProps {
  analyserNode: AnalyserNode | null;
  x: number;
  isRecording: boolean;
  /**
   * Optional predicted click-arrival windows. When supplied alongside
   * `audioContext`, samples whose mic-arrival time falls inside any
   * active window are flattened to the centerline so the user sees the
   * trace dip through centre instead of a click spike. No-op when either
   * prop is absent (e.g. mask toggle off).
   */
  clickMask?: ClickMaskView | null;
  audioContext?: AudioContext | null;
}

const CANVAS_WIDTH = 160;
/** Max horizontal displacement in CSS pixels (used by hit-zone logic). */
export const WAVEFORM_MAX_AMPLITUDE_PX = CANVAS_WIDTH * 0.45;
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
  clickMask,
  audioContext,
}: WaveformCrosshairProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  const dataArrayRef = useRef<Uint8Array | null>(null);
  // Mirror the live props inside the long-running RAF closure so we don't
  // have to rebind the entire draw loop (and reallocate buffers) on every
  // render. The effect only re-runs when `analyserNode` / `isRecording`
  // flip.
  const clickMaskRef = useRef<ClickMaskView | null | undefined>(clickMask);
  clickMaskRef.current = clickMask;
  const audioContextRef = useRef<AudioContext | null | undefined>(audioContext);
  audioContextRef.current = audioContext;

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

        // Click-mask overlay (Option A from plan): flatten any sample
        // whose mic-arrival time falls inside an active mask window.
        // Sample index i corresponds to mic time
        //   t_i = ctx.currentTime - (len - 1 - i) / sampleRate
        // (the buffer's last entry is "now"). Both the windows array and
        // the samples are time-ordered, so we sweep with two pointers
        // instead of paying an `isMaskedAt` call per sample. Writes 128
        // (the centerline byte for `getByteTimeDomainData`) so the trace
        // dips through centre instead of showing the click spike.
        const maskCtx = audioContextRef.current;
        const maskSrc = clickMaskRef.current;
        if (maskCtx && maskSrc) {
          const windows = maskSrc.getWindows();
          if (windows.length > 0) {
            const sampleRate = maskCtx.sampleRate;
            const now = maskCtx.currentTime;
            const baseTime = now - (len - 1) / sampleRate;
            let wi = 0;
            // Advance past any window that ended before the buffer starts.
            while (wi < windows.length && windows[wi].endAudioTime < baseTime) {
              wi++;
            }
            for (let i = 0; i < len && wi < windows.length; i++) {
              const t = baseTime + i / sampleRate;
              // Skip windows fully before this sample's time.
              while (wi < windows.length && windows[wi].endAudioTime < t) {
                wi++;
              }
              if (wi >= windows.length) break;
              if (t >= windows[wi].startAudioTime) {
                data[i] = 128;
              }
            }
          }
        }

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
