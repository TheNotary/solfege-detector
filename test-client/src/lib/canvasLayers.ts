/**
 * Pure Canvas 2D draw functions for each visual layer of the game view.
 * These are called back-to-front by the unified GameCanvas RAF loop.
 */
import type { GameNote, Syllable } from "../hooks/useGameEngine";

// ─── Shared constants ────────────────────────────────────────────────────────

const TOP_PERCENT = 15;
const BOTTOM_PERCENT = 85;
const CANVAS_WAVEFORM_WIDTH = 160;

/** Max horizontal displacement in CSS pixels (used by hit-zone logic). */
export const WAVEFORM_MAX_AMPLITUDE_PX = CANVAS_WAVEFORM_WIDTH * 0.45;

const CYAN = "rgba(0, 200, 255, 1)";
const CYAN_GLOW = "rgba(0, 200, 255, 0.4)";

const MAX_WAVEFORM_FPS = 120;
const MIN_WAVEFORM_FPS = 10;

const COMP_KNEE = 0.15;
const COMP_RATIO = 4;
const NOISE_GATE_THRESHOLD = 0.015;

const SOLFEGE_ORDER: readonly Syllable[] = [
    "do", "re", "mi", "fa", "sol", "la", "ti",
];

// ─── Shared types ────────────────────────────────────────────────────────────

export interface NotePoint {
  freq: number;
  y: number;
}

export interface OnsetMarker {
  id: number;
  createdAt: number;
}

export interface HitZoneOverlay {
  centerPct: number;
  halfPct: number;
  offsetPct: number;
}

export interface ClickMaskWindow {
  readonly startAudioTime: number;
  readonly endAudioTime: number;
}

// ─── Shared utility functions ────────────────────────────────────────────────

/**
 * Build a NOTE_POINTS array from dynamic scale frequencies.
 * Maps each syllable to its evenly-spaced Y% (do=85%, ti=15%).
 */
export function buildNotePoints(
    scaleFrequencies: Record<Syllable, number>,
): NotePoint[] {
    return SOLFEGE_ORDER.map((s, i) => ({
        freq: scaleFrequencies[s],
        y: BOTTOM_PERCENT - (i / (SOLFEGE_ORDER.length - 1)) * (BOTTOM_PERCENT - TOP_PERCENT),
    }));
}

/** Map a frequency (Hz) to a Y% using piecewise linear interpolation
 *  through the solfege note positions, matching the evenly-spaced staff lines. */
export function freqToY(hz: number, notePoints: NotePoint[]): number {
    if (notePoints.length === 0) return 50;
    if (hz <= notePoints[0].freq) return notePoints[0].y;
    if (hz >= notePoints[notePoints.length - 1].freq)
        return notePoints[notePoints.length - 1].y;
    for (let i = 0; i < notePoints.length - 1; i++) {
        const lo = notePoints[i];
        const hi = notePoints[i + 1];
        if (hz <= hi.freq) {
            const t = (hz - lo.freq) / (hi.freq - lo.freq);
            return lo.y + t * (hi.y - lo.y);
        }
    }
    return notePoints[notePoints.length - 1].y;
}

/**
 * Pick how many RAF ticks to wait between waveform draws so the
 * time-domain buffer is phase-aligned frame-to-frame and the waveform
 * appears visually frozen while a steady note is held.
 */
export function pickPhaseLockSkip(
    pitchHz: number | null,
    rafDtMs: number,
    maxFps: number = MAX_WAVEFORM_FPS,
    minFps: number = MIN_WAVEFORM_FPS,
): number {
    if (!Number.isFinite(rafDtMs) || rafDtMs <= 0) return 1;
    const kMin = Math.max(1, Math.ceil(1000 / maxFps / rafDtMs));
    const kMax = Math.max(kMin, Math.floor(1000 / minFps / rafDtMs));
    if (pitchHz === null || !Number.isFinite(pitchHz) || pitchHz <= 0) {
        return kMin;
    }
    const periodMs = 1000 / pitchHz;
    let bestK = kMin;
    let bestDist = Infinity;
    for (let k = kMin; k <= kMax; k++) {
        const cycles = (k * rafDtMs) / periodMs;
        const dist = Math.abs(cycles - Math.round(cycles));
        if (dist < bestDist) {
            bestDist = dist;
            bestK = k;
        }
    }
    return bestK;
}

/**
 * Soft-knee compressor: boosts quiet signals while clamping loud ones.
 * Input `v` is a linear amplitude in [-1, 1]. Output is compressed into
 * the same range, preserving sign.
 */
export function compress(v: number): number {
    const sign = v < 0 ? -1 : 1;
    const abs = Math.abs(v);
    if (abs <= COMP_KNEE) {
        const gain = 1 + (1 - COMP_KNEE) / (COMP_KNEE * COMP_RATIO);
        return sign * Math.min(abs * gain, 1);
    }
    const compressed = COMP_KNEE + (abs - COMP_KNEE) / COMP_RATIO;
    const kneeOut = COMP_KNEE + (1 - COMP_KNEE) / COMP_RATIO;
    return sign * Math.min(compressed / kneeOut, 1);
}

// ─── Layer draw functions ────────────────────────────────────────────────────

/** Layer 1: Solid dark background fill. */
export function drawBackground(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.fillStyle = "#0a0a1a";
    ctx.fillRect(0, 0, w, h);
}

/** Layer 2: Horizontal staff lines + solfege text labels. */
export function drawStaffLines(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    notePoints: NotePoint[],
): void {
    ctx.save();

    // Staff lines
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    for (const pt of notePoints) {
        const y = (pt.y / 100) * h;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
    }

    // Solfege labels
    ctx.font = "600 0.75rem monospace";
    ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
    ctx.textBaseline = "middle";
    for (let i = 0; i < SOLFEGE_ORDER.length; i++) {
        const label = SOLFEGE_ORDER[i];
        const y = (notePoints[i].y / 100) * h;
        ctx.fillText(label, 12, y);
    }

    ctx.restore();
}

/** Layer 3: Cyan semi-transparent crosshair zone rect. */
export function drawCrosshairZone(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    crosshairXPct: number,
    halfPct: number,
): void {
    const left = ((crosshairXPct - halfPct) / 100) * w;
    const width = ((halfPct * 2) / 100) * w;

    ctx.save();
    // Fill
    ctx.fillStyle = "rgba(0, 200, 255, 0.04)";
    ctx.fillRect(left, 0, width, h);
    // Border lines
    ctx.strokeStyle = "rgba(0, 200, 255, 0.1)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, 0);
    ctx.lineTo(left, h);
    ctx.moveTo(left + width, 0);
    ctx.lineTo(left + width, h);
    ctx.stroke();
    ctx.restore();
}

/** Layer 4: Debug hit zone overlay (yellow dashed rect + purple offset + center line). */
export function drawDebugHitZone(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    geometry: HitZoneOverlay,
): void {
    const left = ((geometry.centerPct - geometry.halfPct) / 100) * w;
    const width = ((geometry.halfPct * 2) / 100) * w;

    ctx.save();

    // Yellow fill
    ctx.fillStyle = "rgba(255, 255, 0, 0.07)";
    ctx.fillRect(left, 0, width, h);

    // Dashed yellow border
    ctx.strokeStyle = "rgba(255, 255, 0, 0.5)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(left, 0, width, h);
    ctx.setLineDash([]);

    // Purple latency offset band
    if (geometry.offsetPct > 0) {
        const offsetWidth = Math.min(1, geometry.offsetPct / (geometry.halfPct * 2)) * width;
        ctx.fillStyle = "rgba(80, 0, 120, 0.25)";
        ctx.fillRect(left, 0, offsetWidth, h);
        // Right edge of offset band
        ctx.strokeStyle = "rgba(120, 0, 180, 0.5)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(left + offsetWidth, 0);
        ctx.lineTo(left + offsetWidth, h);
        ctx.stroke();
    }

    // Center line
    const cx = left + width / 2;
    ctx.strokeStyle = "rgba(255, 255, 0, 0.6)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();

    ctx.restore();
}

/** Layer 5: Real-time waveform trace (dual-pass: glow + core line). */
export function drawWaveform(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    data: Uint8Array | null,
    crosshairXPct: number,
    isRecording: boolean,
): void {
    const waveformWidth = CANVAS_WAVEFORM_WIDTH;
    const cx = (crosshairXPct / 100) * w;
    const maxAmplitude = waveformWidth * 0.45;

    if (!data || !isRecording) {
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
        return;
    }

    const len = data.length;

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
}

/** Layer 6: Onset flash (radial gradient fading over 500ms). */
export function drawOnsetFlash(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    markers: ReadonlyArray<OnsetMarker>,
    crosshairXPct: number,
): void {
    if (markers.length === 0) return;

    const now = performance.now();
    const FLASH_DURATION_MS = 500;
    const cx = (crosshairXPct / 100) * w;
    const radiusX = w * 0.06;

    ctx.save();
    for (const marker of markers) {
        const elapsed = now - marker.createdAt;
        if (elapsed >= FLASH_DURATION_MS) continue;
        const opacity = 1 - elapsed / FLASH_DURATION_MS;

        // Use an elliptical gradient that spans the full height by scaling
        // the Y axis. The gradient is circular in transformed space, but
        // stretches vertically to cover the entire canvas height.
        const flashWidth = radiusX * 4;
        const left = cx - flashWidth / 2;
        ctx.save();
        ctx.translate(cx, h / 2);
        ctx.scale(1, h / flashWidth);
        const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, flashWidth / 2);
        gradient.addColorStop(0, `rgba(255, 200, 50, ${0.35 * opacity})`);
        gradient.addColorStop(0.4, `rgba(255, 140, 0, ${0.15 * opacity})`);
        gradient.addColorStop(0.7, `rgba(255, 140, 0, 0)`);
        gradient.addColorStop(1, `rgba(255, 140, 0, 0)`);
        ctx.fillStyle = gradient;
        ctx.fillRect(-flashWidth / 2, -flashWidth / 2, flashWidth, flashWidth);
        ctx.restore();
    }
    ctx.restore();
}

/** Layer 7: Fiery pitch bar indicator. */
export function drawPitchBar(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    displayPitchHz: number | null,
    opacity: number,
    notePoints: NotePoint[],
    crosshairXPct: number,
): void {
    if (displayPitchHz === null || opacity <= 0.01) return;

    const topPercent = freqToY(displayPitchHz, notePoints);
    const clampedTop = Math.max(TOP_PERCENT, Math.min(BOTTOM_PERCENT, topPercent));

    const barWidth = 10;
    const barHeight = 30;
    const cx = (crosshairXPct / 100) * w;
    const cy = (clampedTop / 100) * h;
    const x = cx - barWidth / 2;
    const y = cy - barHeight / 2;

    ctx.save();
    ctx.globalAlpha = opacity;

    // Gradient fill (red → orange → gold from bottom to top)
    const gradient = ctx.createLinearGradient(x, y + barHeight, x, y);
    gradient.addColorStop(0, "#ff4500");
    gradient.addColorStop(0.5, "#ff8c00");
    gradient.addColorStop(1, "#ffd700");

    // Glow
    ctx.shadowColor = "#ff8c00";
    ctx.shadowBlur = 16;

    // Draw rounded rect
    const radius = 5;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + barWidth - radius, y);
    ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + radius);
    ctx.lineTo(x + barWidth, y + barHeight - radius);
    ctx.quadraticCurveTo(x + barWidth, y + barHeight, x + barWidth - radius, y + barHeight);
    ctx.lineTo(x + radius, y + barHeight);
    ctx.quadraticCurveTo(x, y + barHeight, x, y + barHeight - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.restore();
}

/** Layer 8: Scrolling note glyphs. */
export function drawNotes(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    notes: ReadonlyArray<GameNote>,
): void {
    if (notes.length === 0) return;

    ctx.save();
    ctx.font = "2rem serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (const note of notes) {
        const x = (note.x / 100) * w;
        const y = (note.y / 100) * h;

        if (note.state === "hit") {
            ctx.globalAlpha = 0; // faded out (hit notes disappear)
            // Hit notes are invisible — confetti fires via canvas-confetti library
        } else if (note.state === "missed") {
            ctx.globalAlpha = 0.2;
            ctx.fillStyle = "#fff";
            ctx.shadowColor = "transparent";
            ctx.shadowBlur = 0;
            ctx.fillText("♩", x, y);
        } else {
            // Sliding
            ctx.globalAlpha = 1;
            ctx.fillStyle = "#fff";
            ctx.shadowColor = "rgba(100, 180, 255, 0.4)";
            ctx.shadowBlur = 20;
            ctx.fillText("♩", x, y);
            // Second pass for brighter core glow
            ctx.shadowColor = "rgba(255, 255, 255, 0.4)";
            ctx.shadowBlur = 8;
            ctx.fillText("♩", x, y);
        }
    }

    ctx.restore();
}

// ─── Click-mask application (mutates data buffer in-place) ───────────────────

/**
 * Flatten any waveform samples whose mic-arrival time falls inside an
 * active click-mask window. Mutates `data` in place (sets masked samples
 * to 128, the centerline for getByteTimeDomainData).
 */
export function applyClickMask(
    data: Uint8Array,
    windows: ReadonlyArray<ClickMaskWindow>,
    audioCurrentTime: number,
    sampleRate: number,
): void {
    if (windows.length === 0) return;

    const len = data.length;
    const baseTime = audioCurrentTime - (len - 1) / sampleRate;
    let wi = 0;

    // Advance past windows that ended before the buffer starts.
    while (wi < windows.length && windows[wi].endAudioTime < baseTime) {
        wi++;
    }

    for (let i = 0; i < len && wi < windows.length; i++) {
        const t = baseTime + i / sampleRate;
        while (wi < windows.length && windows[wi].endAudioTime < t) {
            wi++;
        }
        if (wi >= windows.length) break;
        if (t >= windows[wi].startAudioTime) {
            data[i] = 128;
        }
    }
}
