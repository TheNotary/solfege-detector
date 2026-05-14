"""FastAPI WebSocket server for real-time solfege syllable detection."""

import json
import logging
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
    logger.info("WebSocket client connected")

    try:
        while True:
            message = await ws.receive()

            if message["type"] == "websocket.receive":
                # Binary data — PCM audio
                if "bytes" in message and message["bytes"]:
                    window = buffer.append(message["bytes"])
                    if window is not None:
                        detections = _detector.detect(
                            window,
                            sample_rate=buffer.sample_rate,
                            threshold=threshold,
                        )
                        for d in detections:
                            await ws.send_json({
                                "type": "detection",
                                "syllable": d.syllable,
                                "confidence": round(d.confidence, 4),
                            })

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

    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
    except Exception:
        logger.exception("WebSocket error")
    finally:
        buffer.reset()
