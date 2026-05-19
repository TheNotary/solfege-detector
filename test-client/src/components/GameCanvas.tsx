import { useEffect, useRef } from "react";
import type { GameNote } from "../hooks/useGameEngine";
import {
    type NotePoint,
    type OnsetMarker,
    type HitZoneOverlay,
    type ClickMaskWindow,
    pickPhaseLockSkip,
    applyClickMask,
    drawBackground,
    drawStaffLines,
    drawCrosshairZone,
    drawDebugHitZone,
    drawWaveform,
    drawOnsetFlash,
    drawPitchBar,
    drawNotes,
} from "../lib/canvasLayers";

interface ClickMaskView {
  getWindows: () => ReadonlyArray<ClickMaskWindow>;
}

export interface GameCanvasProps {
  notes: ReadonlyArray<GameNote>;
  analyserNode: AnalyserNode | null;
  pitchHz: number | null;
  displayPitchHz: number | null;
  pitchOpacity: number;
  isRecording: boolean;
  onsetMarkers: ReadonlyArray<OnsetMarker>;
  hitZoneGeometry: HitZoneOverlay | null;
  showHitzoneOffset: boolean;
  clickMask: ClickMaskView | null;
  audioContext: AudioContext | null;
  notePoints: NotePoint[];
  crosshairX: number;
}

export default function GameCanvas({
    notes,
    analyserNode,
    pitchHz,
    displayPitchHz,
    pitchOpacity,
    isRecording,
    onsetMarkers,
    hitZoneGeometry,
    showHitzoneOffset,
    clickMask,
    audioContext,
    notePoints,
    crosshairX,
}: GameCanvasProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const rafRef = useRef<number>(0);

    // Mirror props into refs so the RAF closure always reads current values
    // without needing to be torn down and rebuilt on every render.
    const notesRef = useRef(notes);
    notesRef.current = notes;
    const analyserNodeRef = useRef(analyserNode);
    analyserNodeRef.current = analyserNode;
    const pitchHzRef = useRef(pitchHz);
    pitchHzRef.current = pitchHz;
    const displayPitchHzRef = useRef(displayPitchHz);
    displayPitchHzRef.current = displayPitchHz;
    const pitchOpacityRef = useRef(pitchOpacity);
    pitchOpacityRef.current = pitchOpacity;
    const isRecordingRef = useRef(isRecording);
    isRecordingRef.current = isRecording;
    const onsetMarkersRef = useRef(onsetMarkers);
    onsetMarkersRef.current = onsetMarkers;
    const hitZoneGeometryRef = useRef(hitZoneGeometry);
    hitZoneGeometryRef.current = hitZoneGeometry;
    const showHitzoneOffsetRef = useRef(showHitzoneOffset);
    showHitzoneOffsetRef.current = showHitzoneOffset;
    const clickMaskRef = useRef(clickMask);
    clickMaskRef.current = clickMask;
    const audioContextRef = useRef(audioContext);
    audioContextRef.current = audioContext;
    const notePointsRef = useRef(notePoints);
    notePointsRef.current = notePoints;
    const crosshairXRef = useRef(crosshairX);
    crosshairXRef.current = crosshairX;

    // Waveform data buffer — allocated once when analyser becomes available.
    const dataArrayRef = useRef<Uint8Array | null>(null);
    // Cached waveform snapshot for non-waveform-draw frames (phase-lock skip).
    const cachedWaveformRef = useRef<Uint8Array | null>(null);

    // Phase-lock state for waveform sub-layer
    const rafDtEmaRef = useRef<number>(1000 / 60);
    const lastRafTimeRef = useRef<number>(0);
    const rafCountRef = useRef<number>(0);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const resize = () => {
            const dpr = window.devicePixelRatio || 1;
            const parent = canvas.parentElement;
            const pw = parent ? parent.clientWidth : window.innerWidth;
            const ph = parent ? parent.clientHeight : window.innerHeight;
            canvas.style.width = `${pw}px`;
            canvas.style.height = `${ph}px`;
            canvas.width = pw * dpr;
            canvas.height = ph * dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        };

        const parent = canvas.parentElement;
        const observer = new ResizeObserver(resize);
        if (parent) observer.observe(parent);
        window.addEventListener("resize", resize);
        resize();

        const draw = () => {
            // Measure RAF cadence for phase-lock
            const now = performance.now();
            if (lastRafTimeRef.current > 0) {
                const dt = now - lastRafTimeRef.current;
                if (dt > 0 && dt < 100) {
                    rafDtEmaRef.current = 0.9 * rafDtEmaRef.current + 0.1 * dt;
                }
            }
            lastRafTimeRef.current = now;

            const dpr = window.devicePixelRatio || 1;
            const w = canvas.width / dpr;
            const h = canvas.height / dpr;

            // Determine if this frame should redraw the waveform
            const skip = pickPhaseLockSkip(pitchHzRef.current, rafDtEmaRef.current);
            const count = rafCountRef.current++;
            const isWaveformFrame = count % skip === 0;

            // Fetch fresh waveform data on waveform frames
            const analyser = analyserNodeRef.current;
            if (isWaveformFrame && analyser && isRecordingRef.current) {
                if (!dataArrayRef.current || dataArrayRef.current.length !== analyser.frequencyBinCount) {
                    dataArrayRef.current = new Uint8Array(analyser.frequencyBinCount);
                }
                analyser.getByteTimeDomainData(dataArrayRef.current);

                // Apply click mask
                const maskCtx = audioContextRef.current;
                const maskSrc = clickMaskRef.current;
                if (maskCtx && maskSrc) {
                    const windows = maskSrc.getWindows();
                    if (windows.length > 0) {
                        applyClickMask(
                            dataArrayRef.current,
                            windows,
                            maskCtx.currentTime,
                            maskCtx.sampleRate,
                        );
                    }
                }

                // Cache the waveform data for non-waveform frames
                if (!cachedWaveformRef.current || cachedWaveformRef.current.length !== dataArrayRef.current.length) {
                    cachedWaveformRef.current = new Uint8Array(dataArrayRef.current.length);
                }
                cachedWaveformRef.current.set(dataArrayRef.current);
            }

            // Use cached data when skipping waveform redraws
            const waveformData = isWaveformFrame
                ? dataArrayRef.current
                : cachedWaveformRef.current;

            const xPct = crosshairXRef.current;
            const pts = notePointsRef.current;
            const hzGeo = hitZoneGeometryRef.current;

            // Clear and draw all layers back-to-front
            ctx.clearRect(0, 0, w, h);

            // 1. Background
            drawBackground(ctx, w, h);

            // 2. Staff lines + labels
            drawStaffLines(ctx, w, h, pts);

            // 3. Crosshair zone
            const halfPct = hzGeo ? hzGeo.halfPct : 6;
            drawCrosshairZone(ctx, w, h, xPct, halfPct);

            // 4. Debug hit zone (conditional)
            if (showHitzoneOffsetRef.current && hzGeo) {
                drawDebugHitZone(ctx, w, h, hzGeo);
            }

            // 5. Waveform
            drawWaveform(ctx, w, h, waveformData, xPct, isRecordingRef.current);

            // 6. Onset flash
            drawOnsetFlash(ctx, w, h, onsetMarkersRef.current, xPct);

            // 7. Pitch bar
            drawPitchBar(ctx, w, h, displayPitchHzRef.current, pitchOpacityRef.current, pts, xPct);

            // 8. Notes
            drawNotes(ctx, w, h, notesRef.current);

            rafRef.current = requestAnimationFrame(draw);
        };

        rafRef.current = requestAnimationFrame(draw);

        return () => {
            cancelAnimationFrame(rafRef.current);
            observer.disconnect();
            window.removeEventListener("resize", resize);
        };
    }, []);

    return (
        <canvas
            ref={canvasRef}
            style={{
                position: "absolute",
                top: 0,
                left: 0,
                zIndex: 1,
                pointerEvents: "none",
            }}
        />
    );
}
