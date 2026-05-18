import { useCallback, useEffect, useRef, useState } from "react";
import {
  measureBulkDelaySamples,
  samplesToMs,
  type MeasureBulkDelayPeak,
} from "../lib/delayCalibration";
import {
  connectVocalBandpassNodes,
  createVocalBandpassFilter,
} from "../lib/vocalBandpass";

const TARGET_SAMPLE_RATE = 44_100;
const CHUNK_INTERVAL_MS = 250;
const AEC_WORKLET_URL = "/aec-processor.js";
const FILTERED_ANALYSER_FFT = 4096;

interface UseAudioStreamOptions {
  onChunk: (chunk: ArrayBuffer) => void;
  onVolume?: (rms: number) => void;
  /** Called with each audio chunk during note capture for onset detection. */
  onCaptureChunk?: (samples: Float32Array) => void;
  /** Called with the captured PCM buffer to trim multi-onset audio. */
  trimCapture?: (audioBuffer: ArrayBuffer) => ArrayBuffer;

  /**
   * Reference signal for the AEC worklet (typically the drone+metronome
   * reference mix). When `null`/`undefined` or `aecEnabled` is false, no
   * filtered path is built and `filteredAnalyserNode` stays `null`.
   */
  referenceNode?: AudioNode | null;
  /** Master switch for the AEC worklet. Default `true`. */
  aecEnabled?: boolean;
  /** Bulk speaker->mic round-trip latency (ms), from existing calibration. */
  audioInputLatencyMs?: number;
  /**
   * Called with the RMS of each cleaned-audio frame emitted by the AEC.
   * Use this for display-side volume detection (confetti, hit-zone visuals).
   */
  onVolumeFiltered?: (rms: number) => void;
  /**
   * Called with each cleaned-audio Float32 frame emitted by the AEC.
   * Use this for display-side onset detection.
   */
  onCaptureChunkFiltered?: (samples: Float32Array) => void;
  /**
   * When `true` (default), the four display-side audio paths — raw +
   * AEC-filtered analyser nodes, and the raw + AEC-filtered
   * onCaptureChunk* / onVolume* callbacks — are routed through a 4th-order
   * 80–1100 Hz vocal-range bandpass so sub-bass rumble (e.g. thunder) and
   * high-frequency noise can't trip onset detection or jiggle the
   * waveform. The backend training audio (`onChunk` and the buffer
   * returned by `stopNoteCapture`) is intentionally NOT filtered either
   * way — the acoustic model is trained on the full spectrum.
   */
  vocalBandpassEnabled?: boolean;
}

interface UseAudioStreamReturn {
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  isRecording: boolean;
  audioContext: AudioContext | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  analyserNode: AnalyserNode | null;
  /**
   * Cleaned-mic AnalyserNode produced by the AEC worklet. `null` until the
   * worklet has loaded, the reference signal is connected, and AEC is
   * enabled. Display-side consumers (waveform, hit-zone visuals) should
   * fall back to `analyserNode` when this is `null`.
   */
  filteredAnalyserNode: AnalyserNode | null;
  /**
   * Latest AEC worklet diagnostics, sampled at roughly 10 Hz. `null` when
   * the worklet isn't running. Intended for debug HUDs only.
   */
  aecStats: AecStats | null;
  startNoteCapture: () => void;
  stopNoteCapture: () => ArrayBuffer | null;
  /**
   * Record a short window of paired (mic, reference) samples from the AEC
   * worklet, cross-correlate them, and — on a confident pick — immediately
   * push the measured bulk delay to the worklet via `setLatency`.
   *
   * Returns `null` if the AEC worklet isn't running, the request times out,
   * or the cross-correlation peak is too ambiguous to trust.
   *
   * The caller is responsible for arranging that a recognizable probe
   * signal (e.g. a metronome click or the running drone) is playing during
   * the capture window. Default window is ~93 ms @ 44.1 kHz which fits a
   * single click comfortably; max search lag defaults to ~100 ms.
   */
  calibrateBulkDelay: (options?: CalibrateBulkDelayOptions) => Promise<CalibrateBulkDelayResult | null>;
}

export interface CalibrateBulkDelayOptions {
  /** Capture window size in samples. Default 4096. */
  windowSamples?: number;
  /** Maximum candidate lag in samples. Default 4410 (~100 ms @ 44.1 kHz). */
  maxLagSamples?: number;
  /** Minimum confidence (peak / median |corr|) to accept. Default 5. */
  minConfidence?: number;
  /**
   * Minimum normalized peak correlation [0..1] to accept. Default 0. A real
   * speaker→mic echo of the probe typically yields > 0.3; values below that
   * usually mean the mic isn't hearing the probe (headphones, muted speakers,
   * mic too far) and the recovered lag is fitting noise. Reject those so a
   * previously-good calibration isn't overwritten with garbage.
   */
  minPeakCorrelation?: number;
  /** Timeout in ms before giving up on the capture round-trip. Default 1500. */
  timeoutMs?: number;
}

export interface CalibrateBulkDelayResult {
  delaySamples: number;
  delayMs: number;
  confidence: number;
  peakCorrelation: number;
  sampleRate: number;
  /** RMS (dB FS) of the captured mic window. Useful for debugging "is the mic alive?" */
  micRmsDb: number;
  /** RMS (dB FS) of the captured reference window. Useful for debugging "is the ref signal reaching the AEC?" */
  refRmsDb: number;
  /** Length (in samples) of the capture window the measurement ran over. */
  windowSamples: number;
  /** True if the result was confident enough to be pushed to the worklet. */
  applied: boolean;
  /**
   * Top-K strongest cross-correlation peaks by |corr|, in descending order.
   * Surfaces the full "landscape" of candidate delays so debug logs can
   * show whether the chosen peak was clearly the winner or one of several
   * similar weak candidates.
   */
  topPeaks: MeasureBulkDelayPeak[];
}

export interface AecStats {
  delaySamples: number;
  taps: number;
  refEnergyDb: number;
  micEnergyDb: number;
  residualDb: number;
}

/**
 * Converts float32 audio samples to int16 PCM ArrayBuffer.
 */
function float32ToInt16(float32: Float32Array): ArrayBuffer {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16.buffer;
}

/**
 * Root-mean-square of `x` in dB FS. Returns -Infinity-safe -200 for silence.
 */
function rmsDb(x: Float32Array): number {
  if (x.length === 0) return -200;
  let sumSq = 0;
  for (let i = 0; i < x.length; i++) sumSq += x[i] * x[i];
  const ms = sumSq / x.length;
  if (ms <= 1e-20) return -200;
  return 10 * Math.log10(ms);
}

export function useAudioStream(
  options: UseAudioStreamOptions
): UseAudioStreamReturn {
  const [isRecording, setIsRecording] = useState(false);
  /**
   * State mirror of `audioContextRef` so React effects (notably AEC wiring)
   * can react when the context appears/disappears. Always set in lockstep
   * with `audioContextRef.current`.
   */
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null);
  const [filteredAnalyserNode, setFilteredAnalyserNode] = useState<AnalyserNode | null>(null);
  const [aecStats, setAecStats] = useState<AecStats | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const aecNodeRef = useRef<AudioWorkletNode | null>(null);
  const onChunkRef = useRef(options.onChunk);
  onChunkRef.current = options.onChunk;
  const onVolumeRef = useRef(options.onVolume);
  onVolumeRef.current = options.onVolume;
  const onCaptureChunkRef = useRef(options.onCaptureChunk);
  onCaptureChunkRef.current = options.onCaptureChunk;
  const trimCaptureRef = useRef(options.trimCapture);
  trimCaptureRef.current = options.trimCapture;
  const onVolumeFilteredRef = useRef(options.onVolumeFiltered);
  onVolumeFilteredRef.current = options.onVolumeFiltered;
  const onCaptureChunkFilteredRef = useRef(options.onCaptureChunkFiltered);
  onCaptureChunkFilteredRef.current = options.onCaptureChunkFiltered;
  const audioInputLatencyMsRef = useRef(options.audioInputLatencyMs);
  audioInputLatencyMsRef.current = options.audioInputLatencyMs;

  /**
   * Live mirror of `vocalBandpassEnabled` so the per-frame processor
   * callback (and the AEC postMessage handler) can branch on the current
   * setting without rebinding on every render. Default `true`.
   */
  const vocalBandpassEnabledRef = useRef(options.vocalBandpassEnabled !== false);
  vocalBandpassEnabledRef.current = options.vocalBandpassEnabled !== false;

  /**
   * Per-recording-session stateful JS biquad used to filter the raw mic
   * samples handed to display-side consumers (`onCaptureChunk` /
   * `onVolume`). Always primed during recording so toggling the bandpass
   * back on doesn't expose a stale-state transient. The accumulator that
   * feeds the backend WebSocket and the per-note capture buffer keep
   * receiving the unfiltered `copied` array.
   */
  const displayFilterRef = useRef<((s: Float32Array) => Float32Array) | null>(null);

  /**
   * Resolves the next inbound `captureWindow` from the AEC worklet to the
   * waiting `calibrateBulkDelay` caller. Only one calibration may be in
   * flight at a time — the second caller resolves to `null`.
   */
  const pendingCaptureResolverRef = useRef<
    ((value: { mic: Float32Array; ref: Float32Array; sampleRate: number } | null) => void) | null
  >(null);

  const referenceNode = options.referenceNode ?? null;
  const aecEnabled = options.aecEnabled !== false;
  const vocalBandpassEnabled = options.vocalBandpassEnabled !== false;

  // Push latency updates to a live AEC node so calibration changes re-align
  // the worklet's delay ring without forcing a full rebuild.
  useEffect(() => {
    const node = aecNodeRef.current;
    if (!node) return;
    const ms = options.audioInputLatencyMs;
    if (typeof ms !== "number" || !isFinite(ms)) return;
    node.port.postMessage({ type: "setLatency", ms });
  }, [options.audioInputLatencyMs]);

  // Accumulation buffer for chunking at CHUNK_INTERVAL_MS
  const accumulatorRef = useRef<Float32Array[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Per-note capture: independent accumulator active only during hit zone
  const noteCaptureActiveRef = useRef(false);
  const noteCaptureBufferRef = useRef<Float32Array[]>([]);

  const stopRecording = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    analyserRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current = null;
    analyserRef.current = null;
    displayFilterRef.current = null;

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setAudioContext(null);

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }

    accumulatorRef.current = [];
    setIsRecording(false);
  }, []);

  const startRecording = useCallback(async () => {
    if (audioContextRef.current) return; // Already recording

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: TARGET_SAMPLE_RATE,
        autoGainControl: false,
        noiseSuppression: false,
        echoCancellation: false,
      },
    });
    mediaStreamRef.current = stream;

    const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    audioContextRef.current = ctx;
    setAudioContext(ctx);

    const source = ctx.createMediaStreamSource(stream);
    sourceRef.current = source;

    // Shared AnalyserNode (fftSize=4096 for reliable low-frequency pitch detection).
    // The `source -> analyser` edge itself is built by the
    // `vocalBandpassEnabled` effect below (so toggling the filter live
    // can rewire that edge without restarting recording).
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyserRef.current = analyser;

    // Allocate the display-side filter once per recording session. We
    // always pump samples through it so the biquad state stays primed; the
    // per-frame branch decides whether the filtered or raw copy is handed
    // to the display callbacks.
    displayFilterRef.current = createVocalBandpassFilter(ctx.sampleRate);

    // ScriptProcessorNode for raw sample access (widely supported)
    const bufferSize = 4096;
    const processor = ctx.createScriptProcessor(bufferSize, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = (e: AudioProcessingEvent) => {
      const input = e.inputBuffer.getChannelData(0);
      // Copy since the buffer is reused. `copied` is the raw mic signal
      // and is what the backend (WebSocket chunks + per-note capture for
      // training) sees — it MUST NOT be filtered.
      const copied = new Float32Array(input);
      accumulatorRef.current.push(copied);

      // Filtered copy for display-side consumers. Always computed so the
      // biquad keeps a hot state; cheap relative to a 4096-sample frame.
      const filtered = displayFilterRef.current
        ? displayFilterRef.current(copied)
        : copied;
      const displaySamples = vocalBandpassEnabledRef.current ? filtered : copied;

      // Collect into per-note capture buffer if active. The capture buffer
      // is the per-note training payload returned by `stopNoteCapture` —
      // it stays raw too. Only the `onCaptureChunk` notification (which
      // drives the onset detector) sees the filtered samples.
      if (noteCaptureActiveRef.current) {
        noteCaptureBufferRef.current.push(copied);
        onCaptureChunkRef.current?.(displaySamples);
      }

      // Compute RMS for volume detection from the display copy so rumble
      // doesn't pin the volume meter open / fire confetti.
      if (onVolumeRef.current) {
        let sum = 0;
        for (let i = 0; i < displaySamples.length; i++) {
          sum += displaySamples[i] * displaySamples[i];
        }
        onVolumeRef.current(Math.sqrt(sum / displaySamples.length));
      }
    };

    source.connect(processor);
    processor.connect(ctx.destination);

    // Flush accumulated samples at the chunk interval
    timerRef.current = setInterval(() => {
      const chunks = accumulatorRef.current;
      if (chunks.length === 0) return;
      accumulatorRef.current = [];

      // Concatenate
      const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
      const merged = new Float32Array(totalLen);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }

      // Resample if device rate differs
      let samples = merged;
      if (ctx.sampleRate !== TARGET_SAMPLE_RATE) {
        const ratio = TARGET_SAMPLE_RATE / ctx.sampleRate;
        const newLen = Math.round(merged.length * ratio);
        const resampled = new Float32Array(newLen);
        for (let i = 0; i < newLen; i++) {
          const srcIdx = i / ratio;
          const lo = Math.floor(srcIdx);
          const hi = Math.min(lo + 1, merged.length - 1);
          const frac = srcIdx - lo;
          resampled[i] = merged[lo] * (1 - frac) + merged[hi] * frac;
        }
        samples = resampled;
      }

      onChunkRef.current(float32ToInt16(samples));
    }, CHUNK_INTERVAL_MS);

    setIsRecording(true);
  }, []);

  const startNoteCapture = useCallback(() => {
    noteCaptureBufferRef.current = [];
    noteCaptureActiveRef.current = true;
  }, []);

  /**
   * Wire (and re-wire) the `source -> analyser` edge whenever the audio
   * context or the vocal-bandpass toggle changes. When enabled, splices a
   * 4th-order 80\u20131100 Hz bandpass (two HP + two LP biquads) between
   * source and analyser so the waveform / displacement consumers see the
   * vocal-range signal. When disabled, restores a direct connection. The
   * raw mic path into the processor is unaffected (the backend still gets
   * full-spectrum audio).
   */
  useEffect(() => {
    const ctx = audioContext;
    const source = sourceRef.current;
    const analyser = analyserRef.current;
    if (!ctx || !source || !analyser) return;

    let cleanup: (() => void) | null = null;
    if (vocalBandpassEnabled) {
      const handle = connectVocalBandpassNodes(ctx, source, analyser);
      cleanup = handle.disconnect;
    } else {
      try { source.connect(analyser); } catch { /* already connected */ }
      cleanup = () => {
        try { source.disconnect(analyser); } catch { /* ignore */ }
      };
    }

    return () => {
      cleanup?.();
    };
  }, [audioContext, vocalBandpassEnabled]);

  const stopNoteCapture = useCallback((): ArrayBuffer | null => {
    if (!noteCaptureActiveRef.current) return null;
    noteCaptureActiveRef.current = false;

    const chunks = noteCaptureBufferRef.current;
    noteCaptureBufferRef.current = [];
    if (chunks.length === 0) return null;

    // Concatenate captured Float32 samples
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }

    // Resample if device rate differs
    let samples = merged;
    const ctx = audioContextRef.current;
    if (ctx && ctx.sampleRate !== TARGET_SAMPLE_RATE) {
      const ratio = TARGET_SAMPLE_RATE / ctx.sampleRate;
      const newLen = Math.round(merged.length * ratio);
      const resampled = new Float32Array(newLen);
      for (let i = 0; i < newLen; i++) {
        const srcIdx = i / ratio;
        const lo = Math.floor(srcIdx);
        const hi = Math.min(lo + 1, merged.length - 1);
        const frac = srcIdx - lo;
        resampled[i] = merged[lo] * (1 - frac) + merged[hi] * frac;
      }
      samples = resampled;
    }

    let pcmBuffer = float32ToInt16(samples);
    // Apply onset-based trimming if multiple onsets were detected
    if (trimCaptureRef.current) {
      pcmBuffer = trimCaptureRef.current(pcmBuffer);
    }
    return pcmBuffer;
  }, []);

  /**
   * Build the AEC worklet path when the audio context, reference signal, and
   * source are all present and AEC is enabled. Runs in a side-effect so it
   * fires *after* `useReferenceMix` populates its GainNode (which itself only
   * happens after `startRecording` creates the shared AudioContext on the
   * same render that exposes it via state).
   *
   * The raw mic path (analyser + scriptProcessor + WebSocket chunks +
   * per-note capture buffer) is built unconditionally in `startRecording`
   * and is **not** touched by this effect; backend audio stays raw.
   */
  useEffect(() => {
    const ctx = audioContext;
    const source = sourceRef.current;
    if (!ctx || !source || !referenceNode || !aecEnabled) {
      return;
    }

    let cancelled = false;
    let aecNode: AudioWorkletNode | null = null;
    let filtered: AnalyserNode | null = null;
    let bandpassHandle: { disconnect: () => void } | null = null;

    (async () => {
      try {
        await ctx.audioWorklet.addModule(AEC_WORKLET_URL);
      } catch (err) {
        // Likely a 404 or the module already loaded; addModule is idempotent
        // for the same URL but throws on real network errors. Surface for
        // diagnostics but don't crash the recording session.
        console.error("[useAudioStream] failed to load AEC worklet:", err);
        return;
      }
      if (cancelled) return;

      try {
        aecNode = new AudioWorkletNode(ctx, "aec-processor", {
          numberOfInputs: 2,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
      } catch (err) {
        console.error("[useAudioStream] failed to construct AEC node:", err);
        return;
      }

      try {
        source.connect(aecNode, 0, 0);
        referenceNode.connect(aecNode, 0, 1);
      } catch (err) {
        console.error("[useAudioStream] failed to connect AEC inputs:", err);
        try { aecNode.disconnect(); } catch { /* ignore */ }
        aecNode = null;
        return;
      }

      filtered = ctx.createAnalyser();
      filtered.fftSize = FILTERED_ANALYSER_FFT;
      // When the vocal-range bandpass is on, splice it between the AEC
      // output and the analyser so the filtered waveform display only
      // sees vocal-range content. When off, connect directly. Captured
      // here so the cleanup below can tear the chain down.
      if (vocalBandpassEnabled) {
        bandpassHandle = connectVocalBandpassNodes(ctx, aecNode, filtered);
      } else {
        aecNode.connect(filtered);
      }

      // Per-effect-lifetime JS biquad used to filter the worklet's frame
      // postMessages before they reach `onCaptureChunkFiltered` /
      // `onVolumeFiltered`. Bypassed when the toggle is off.
      const frameFilter = vocalBandpassEnabled
        ? createVocalBandpassFilter(ctx.sampleRate)
        : null;

      // Seed the worklet's delay line from the latest calibration value.
      const latencyMs = audioInputLatencyMsRef.current;
      if (typeof latencyMs === "number" && isFinite(latencyMs)) {
        aecNode.port.postMessage({ type: "setLatency", ms: latencyMs });
      }

      aecNode.port.onmessage = (ev: MessageEvent) => {
        const msg = ev.data;
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "frame") {
          const samples = msg.samples as Float32Array;
          if (!samples || samples.length === 0) return;
          const display = frameFilter ? frameFilter(samples) : samples;
          if (onCaptureChunkFilteredRef.current) {
            onCaptureChunkFilteredRef.current(display);
          }
          if (onVolumeFilteredRef.current) {
            let sumSq = 0;
            for (let i = 0; i < display.length; i++) {
              sumSq += display[i] * display[i];
            }
            onVolumeFilteredRef.current(Math.sqrt(sumSq / display.length));
          }
        } else if (msg.type === "stats") {
          setAecStats({
            delaySamples: msg.delaySamples,
            taps: msg.taps,
            refEnergyDb: msg.refEnergyDb,
            micEnergyDb: msg.micEnergyDb,
            residualDb: msg.residualDb,
          });
        } else if (msg.type === "captureWindow") {
          const resolver = pendingCaptureResolverRef.current;
          pendingCaptureResolverRef.current = null;
          if (resolver) {
            resolver({
              mic: msg.mic as Float32Array,
              ref: msg.ref as Float32Array,
              sampleRate: msg.sampleRate as number,
            });
          }
        }
      };

      aecNodeRef.current = aecNode;
      setFilteredAnalyserNode(filtered);
    })();

    return () => {
      cancelled = true;
      if (aecNode) {
        try { source.disconnect(aecNode); } catch { /* ignore */ }
        try { referenceNode.disconnect(aecNode); } catch { /* ignore */ }
        try { aecNode.disconnect(); } catch { /* ignore */ }
        aecNode.port.onmessage = null;
      }
      if (bandpassHandle) {
        bandpassHandle.disconnect();
      }
      if (filtered) {
        try { filtered.disconnect(); } catch { /* ignore */ }
      }
      aecNodeRef.current = null;
      setFilteredAnalyserNode(null);
      setAecStats(null);
    };
  }, [audioContext, referenceNode, aecEnabled, vocalBandpassEnabled]);

  const calibrateBulkDelay = useCallback(
    async (
      opts: CalibrateBulkDelayOptions = {},
    ): Promise<CalibrateBulkDelayResult | null> => {
      const aecNode = aecNodeRef.current;
      if (!aecNode) return null;
      // Only one calibration in flight; subsequent calls bail until the
      // pending capture resolves or times out.
      if (pendingCaptureResolverRef.current) return null;

      const windowSamples = Math.max(512, Math.floor(opts.windowSamples ?? 4096));
      const maxLagSamples = Math.max(64, Math.floor(opts.maxLagSamples ?? 4410));
      const minConfidence = opts.minConfidence ?? 5;
      const minPeakCorrelation = opts.minPeakCorrelation ?? 0;
      const timeoutMs = opts.timeoutMs ?? 1500;

      const capture = await new Promise<{
        mic: Float32Array;
        ref: Float32Array;
        sampleRate: number;
      } | null>((resolve) => {
        pendingCaptureResolverRef.current = resolve;
        const timer = setTimeout(() => {
          if (pendingCaptureResolverRef.current === resolve) {
            pendingCaptureResolverRef.current = null;
            resolve(null);
          }
        }, timeoutMs);
        // Side-effect: cancel the timer when the resolver fires for any
        // reason (success or stale resolve). Wrap the resolver so we can
        // clear before completing.
        const wrapped = (
          v: { mic: Float32Array; ref: Float32Array; sampleRate: number } | null,
        ) => {
          clearTimeout(timer);
          resolve(v);
        };
        pendingCaptureResolverRef.current = wrapped;
        try {
          aecNode.port.postMessage({ type: "captureWindow", samples: windowSamples });
        } catch (err) {
          console.error("[useAudioStream] calibrateBulkDelay postMessage failed:", err);
          if (pendingCaptureResolverRef.current === wrapped) {
            pendingCaptureResolverRef.current = null;
          }
          clearTimeout(timer);
          resolve(null);
        }
      });

      if (!capture) return null;

      // Clamp maxLag so the cross-correlator can't refuse a too-short window.
      const safeMaxLag = Math.min(maxLagSamples, capture.mic.length - 64);
      if (safeMaxLag < 32) return null;

      let measurement;
      try {
        measurement = measureBulkDelaySamples(capture.mic, capture.ref, {
          maxSamples: safeMaxLag,
        });
      } catch (err) {
        console.error("[useAudioStream] cross-correlation failed:", err);
        return null;
      }

      const result: CalibrateBulkDelayResult = {
        delaySamples: measurement.delaySamples,
        delayMs: samplesToMs(measurement.delaySamples, capture.sampleRate),
        confidence: measurement.confidence,
        peakCorrelation: measurement.peakCorrelation,
        sampleRate: capture.sampleRate,
        micRmsDb: rmsDb(capture.mic),
        refRmsDb: rmsDb(capture.ref),
        windowSamples: capture.mic.length,
        applied: false,
        topPeaks: measurement.topPeaks,
      };

      if (
        measurement.confidence >= minConfidence &&
        measurement.peakCorrelation >= minPeakCorrelation
      ) {
        try {
          aecNode.port.postMessage({ type: "setLatency", ms: result.delayMs });
          result.applied = true;
        } catch (err) {
          console.error("[useAudioStream] setLatency postMessage failed:", err);
        }
      }

      return result;
    },
    [],
  );

  return {
    startRecording,
    stopRecording,
    isRecording,
    audioContext,
    sourceNode: sourceRef.current,
    analyserNode: analyserRef.current,
    filteredAnalyserNode,
    aecStats,
    startNoteCapture,
    stopNoteCapture,
    calibrateBulkDelay,
  };
}
