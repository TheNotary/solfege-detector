"""FastAPI WebSocket server for real-time solfege syllable detection."""

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from solfege_detector.audio_buffer import AudioBuffer
from solfege_detector.detector import SolfegeDetector

logger = logging.getLogger(__name__)

# Shared detector singleton — loaded once at startup
_detector: SolfegeDetector | None = None

DEFAULT_CONFIDENCE_THRESHOLD = 0.5


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load the CLAP model once at startup."""
    global _detector
    logger.info("Loading SolfegeDetector (CLAP model)...")
    _detector = SolfegeDetector(use_cuda=False)
    logger.info("SolfegeDetector ready.")
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
    threshold = DEFAULT_CONFIDENCE_THRESHOLD
    inference_in_progress = False
    pending_window = None
    logger.info("WebSocket client connected")

    async def _run_inference(window, sr, thresh):
        """Run detection in a thread and send results back on the WebSocket."""
        nonlocal inference_in_progress, pending_window
        try:
            t0 = time.perf_counter()
            logger.info("Inference started (window: %d samples, %.3fs)",
                        len(window), len(window) / sr)
            detections = await asyncio.to_thread(
                _detector.detect, window, sample_rate=sr, threshold=thresh,
            )
            elapsed_ms = (time.perf_counter() - t0) * 1000
            logger.info("Inference completed in %.1fms, %d detection(s)",
                        elapsed_ms, len(detections))
            for d in detections:
                logger.info("  Sending detection: %s (%.4f)", d.syllable, d.confidence)
                await ws.send_json({
                    "type": "detection",
                    "syllable": d.syllable,
                    "confidence": round(d.confidence, 4),
                })
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
                    window = buffer.append(message["bytes"])
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
                                await ws.send_json({
                                    "type": "config_ack",
                                    "confidence_threshold": threshold,
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
