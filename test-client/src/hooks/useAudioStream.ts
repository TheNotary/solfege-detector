import { useCallback, useEffect, useRef, useState } from "react";

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
  startNoteCapture: () => void;
  stopNoteCapture: () => ArrayBuffer | null;
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

  const referenceNode = options.referenceNode ?? null;
  const aecEnabled = options.aecEnabled !== false;

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

    // Shared AnalyserNode (fftSize=4096 for reliable low-frequency pitch detection)
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyserRef.current = analyser;
    source.connect(analyser);

    // ScriptProcessorNode for raw sample access (widely supported)
    const bufferSize = 4096;
    const processor = ctx.createScriptProcessor(bufferSize, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = (e: AudioProcessingEvent) => {
      const input = e.inputBuffer.getChannelData(0);
      // Copy since the buffer is reused
      const copied = new Float32Array(input);
      accumulatorRef.current.push(copied);

      // Collect into per-note capture buffer if active
      if (noteCaptureActiveRef.current) {
        noteCaptureBufferRef.current.push(copied);
        onCaptureChunkRef.current?.(copied);
      }

      // Compute RMS for volume detection
      if (onVolumeRef.current) {
        let sum = 0;
        for (let i = 0; i < input.length; i++) {
          sum += input[i] * input[i];
        }
        onVolumeRef.current(Math.sqrt(sum / input.length));
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
      aecNode.connect(filtered);

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
          if (onCaptureChunkFilteredRef.current) {
            onCaptureChunkFilteredRef.current(samples);
          }
          if (onVolumeFilteredRef.current) {
            let sumSq = 0;
            for (let i = 0; i < samples.length; i++) {
              sumSq += samples[i] * samples[i];
            }
            onVolumeFilteredRef.current(Math.sqrt(sumSq / samples.length));
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
      if (filtered) {
        try { filtered.disconnect(); } catch { /* ignore */ }
      }
      aecNodeRef.current = null;
      setFilteredAnalyserNode(null);
    };
  }, [audioContext, referenceNode, aecEnabled]);

  return {
    startRecording,
    stopRecording,
    isRecording,
    audioContext,
    sourceNode: sourceRef.current,
    analyserNode: analyserRef.current,
    filteredAnalyserNode,
    startNoteCapture,
    stopNoteCapture,
  };
}
