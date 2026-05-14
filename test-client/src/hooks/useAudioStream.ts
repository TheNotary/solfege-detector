import { useCallback, useRef, useState } from "react";

const TARGET_SAMPLE_RATE = 44_100;
const CHUNK_INTERVAL_MS = 250;

interface UseAudioStreamOptions {
  onChunk: (chunk: ArrayBuffer) => void;
  onVolume?: (rms: number) => void;
}

interface UseAudioStreamReturn {
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  isRecording: boolean;
  audioContext: AudioContext | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  analyserNode: AnalyserNode | null;
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

  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const onChunkRef = useRef(options.onChunk);
  onChunkRef.current = options.onChunk;
  const onVolumeRef = useRef(options.onVolume);
  onVolumeRef.current = options.onVolume;

  // Accumulation buffer for chunking at CHUNK_INTERVAL_MS
  const accumulatorRef = useRef<Float32Array[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      },
    });
    mediaStreamRef.current = stream;

    const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    audioContextRef.current = ctx;

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
      accumulatorRef.current.push(new Float32Array(input));

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

  return {
    startRecording,
    stopRecording,
    isRecording,
    audioContext: audioContextRef.current,
    sourceNode: sourceRef.current,
    analyserNode: analyserRef.current,
  };
}
