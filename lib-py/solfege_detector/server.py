"""FastAPI WebSocket server for real-time solfege syllable detection."""

import asyncio
import json
import logging
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from solfege_detector.audio_buffer import AudioBuffer
from solfege_detector.detector import SolfegeDetector
from solfege_detector.onset_segmenter import segment_onsets
from solfege_detector.recorder import RecordingBuffer

logger = logging.getLogger(__name__)

# Shared detector singleton — loaded once at startup
_detector: SolfegeDetector | None = None

DEFAULT_CONFIDENCE_THRESHOLD = 0.5

RECORDED_NOTES_DIR = Path("recorded_notes")

# Regex for sanitising filenames
_SAFE_FILENAME_RE = re.compile(r"[^a-zA-Z0-9._-]")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load the CLAP model once at startup."""
    global _detector
    logger.info("Loading SolfegeDetector (CLAP model)...")
    _detector = SolfegeDetector(use_cuda=False)
    logger.info("SolfegeDetector ready.")
    RECORDED_NOTES_DIR.mkdir(parents=True, exist_ok=True)
    logger.info("Recording directory: %s", RECORDED_NOTES_DIR.resolve())
    yield
    _detector = None


app = FastAPI(title="Solfege Detector", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": _detector is not None}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    buffer = AudioBuffer()
    recording_buffer = RecordingBuffer()
    threshold = DEFAULT_CONFIDENCE_THRESHOLD
    segment_mode = "latest"  # "latest" | "multi" | "off"
    onset_sensitivity = 0.07  # maps to onset_delta in onset_segmenter
    onset_min_gap_ms = 200  # maps to min_gap_seconds
    inference_in_progress = False
    pending_window = None
    pending_note_audio: bytes | None = None  # Stashed binary frame for two-frame protocol
    client_ip = ws.client.host if ws.client else "unknown"
    logger.info("WebSocket client connected from %s", client_ip)

    async def _run_inference(window, sr, thresh):
        """Run detection in a thread and send results back on the WebSocket."""
        nonlocal inference_in_progress, pending_window
        try:
            t0 = time.perf_counter()
            logger.info("Inference started (window: %d samples, %.3fs, mode=%s)",
                        len(window), len(window) / sr, segment_mode)

            if segment_mode == "multi":
                detections = await asyncio.to_thread(
                    _detector.detect_multi, window, sample_rate=sr, threshold=thresh,
                )
            elif segment_mode == "latest":
                detections = await asyncio.to_thread(
                    _detector.detect, window, sample_rate=sr, threshold=thresh,
                    use_onset_segmentation=True,
                )
            else:  # "off"
                detections = await asyncio.to_thread(
                    _detector.detect, window, sample_rate=sr, threshold=thresh,
                    use_onset_segmentation=False,
                )
            elapsed_ms = (time.perf_counter() - t0) * 1000
            logger.info("Inference completed in %.1fms, %d detection(s)",
                        elapsed_ms, len(detections))
            for d in detections:
                logger.info("  Sending detection: %s (%.4f)", d.syllable, d.confidence)
                msg = {
                    "type": "detection",
                    "syllable": d.syllable,
                    "confidence": round(d.confidence, 4),
                }
                if d.offset_seconds > 0:
                    msg["offset_seconds"] = round(d.offset_seconds, 3)
                await ws.send_json(msg)
        finally:
            inference_in_progress = False
            # If a newer window arrived while we were busy, process it now
            if pending_window is not None:
                next_window = pending_window
                pending_window = None
                inference_in_progress = True
                logger.debug("Processing pending window (stashed during previous inference)")
                asyncio.ensure_future(_run_inference(next_window, sr, thresh))

    try:
        while True:
            message = await ws.receive()

            if message["type"] == "websocket.receive":
                # Binary data — PCM audio
                if "bytes" in message and message["bytes"]:
                    raw = message["bytes"]
                    # Stash as potential per-note audio (two-frame protocol)
                    pending_note_audio = raw
                    recording_buffer.append(raw)
                    window = buffer.append(raw)
                    if window is not None:
                        logger.debug("Buffer yielded window (%d samples)", len(window))
                        if inference_in_progress:
                            logger.debug("Inference in progress — stashing window as pending")
                            pending_window = window
                        else:
                            inference_in_progress = True
                            asyncio.ensure_future(_run_inference(
                                window, buffer.sample_rate, threshold,
                            ))

                # Text data — JSON config
                elif "text" in message and message["text"]:
                    try:
                        data = json.loads(message["text"])
                        if data.get("type") == "config":
                            new_threshold = data.get("confidence_threshold")
                            if new_threshold is not None:
                                threshold = float(new_threshold)
                                logger.info("Threshold updated to %.2f", threshold)

                            new_mode = data.get("segment_mode")
                            if new_mode in ("latest", "multi", "off"):
                                segment_mode = new_mode
                                logger.info("Segment mode updated to %s", segment_mode)

                            new_sensitivity = data.get("onset_sensitivity")
                            if new_sensitivity is not None:
                                onset_sensitivity = float(new_sensitivity)
                                logger.info("Onset sensitivity updated to %.3f", onset_sensitivity)

                            new_gap = data.get("onset_min_gap_ms")
                            if new_gap is not None:
                                onset_min_gap_ms = int(new_gap)
                                logger.info("Onset min gap updated to %dms", onset_min_gap_ms)

                            await ws.send_json({
                                "type": "config_ack",
                                "confidence_threshold": threshold,
                                "segment_mode": segment_mode,
                                "onset_sensitivity": onset_sensitivity,
                                "onset_min_gap_ms": onset_min_gap_ms,
                            })
                        elif data.get("type") == "note_event":
                            syllable = str(data.get("syllable", "unknown"))
                            hit = bool(data.get("hit", False))
                            client_ts = str(data.get("timestamp", ""))
                            fft_pitch_hz = data.get("fft_pitch_hz")
                            target_frequency_hz = data.get("target_frequency_hz")
                            correlation_id = data.get("correlationId")

                            # Two-frame protocol: use per-note audio if available
                            if correlation_id and pending_note_audio is not None:
                                note_raw = pending_note_audio
                                pending_note_audio = None

                                # Convert PCM bytes to float32 for onset trimming
                                import numpy as np
                                pcm_int16 = np.frombuffer(note_raw, dtype=np.int16)
                                note_float = pcm_int16.astype(np.float32) / 32768.0

                                # Apply onset segmentation to isolate tightest syllable
                                segments = segment_onsets(note_float, buffer.sample_rate)
                                if len(segments) > 1:
                                    # Take the segment with the highest energy (most likely the sung note)
                                    best_start, best_end = segments[-1]
                                    note_float = note_float[best_start:best_end]
                                    logger.info(
                                        "Per-note audio trimmed: %d segments, using last (%.3fs)",
                                        len(segments), len(note_float) / buffer.sample_rate,
                                    )
                                else:
                                    logger.info("Per-note audio: single segment (%.3fs), no trim needed",
                                               len(note_float) / buffer.sample_rate)

                                # Convert back to WAV bytes
                                import io
                                import soundfile as sf
                                wav_buf = io.BytesIO()
                                sf.write(wav_buf, note_float, buffer.sample_rate, format="WAV", subtype="PCM_16")
                                wav_bytes = wav_buf.getvalue()

                                metadata = {
                                    "syllable": syllable,
                                    "timestamp": client_ts,
                                    "hit": hit,
                                    "sample_rate": buffer.sample_rate,
                                    "channels": 1,
                                    "duration_seconds": round(len(note_float) / buffer.sample_rate, 3),
                                    "source": "per_note_capture",
                                }
                                logger.info("Saved per-note audio (trimmed)")
                            else:
                                # Legacy fallback: use rolling recording buffer
                                if correlation_id and pending_note_audio is None:
                                    logger.warning(
                                        "note_event has correlationId but no pending audio — falling back to recording buffer"
                                    )
                                wav_bytes, metadata = recording_buffer.capture(syllable, hit)
                                metadata["source"] = "rolling_buffer"
                                logger.info("Saved rolling buffer capture (fallback)")

                            # Add client IP and pitch metadata
                            metadata["client_ip"] = client_ip
                            if fft_pitch_hz is not None:
                                metadata["fft_pitch_hz"] = float(fft_pitch_hz)
                            if target_frequency_hz is not None:
                                metadata["target_frequency_hz"] = float(target_frequency_hz)

                            # Sanitise for safe filenames
                            safe_ts = _SAFE_FILENAME_RE.sub("_", client_ts)
                            safe_syl = _SAFE_FILENAME_RE.sub("_", syllable)
                            base = f"{safe_ts}_{safe_syl}"

                            wav_path = RECORDED_NOTES_DIR / f"{base}.wav"
                            meta_path = RECORDED_NOTES_DIR / f"{base}.metadata"

                            wav_path.write_bytes(wav_bytes)
                            meta_path.write_text(json.dumps(metadata, indent=2))
                            logger.info("Saved recording: %s", wav_path)

                            await ws.send_json({
                                "type": "note_event_ack",
                                "syllable": syllable,
                                "saved": True,
                            })
                    except (json.JSONDecodeError, ValueError, TypeError) as exc:
                        await ws.send_json({
                            "type": "error",
                            "message": str(exc),
                        })

    except (WebSocketDisconnect, RuntimeError):
        logger.info("WebSocket client disconnected")
    except Exception:
        logger.exception("WebSocket error")
    finally:
        buffer.reset()
        recording_buffer.reset()
