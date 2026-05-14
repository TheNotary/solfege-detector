"""Rolling audio buffer that captures snapshots for training data collection."""

import io
import logging
from datetime import datetime, timezone

import numpy as np
import soundfile as sf

logger = logging.getLogger(__name__)

SAMPLE_RATE = 44_100


class RecordingBuffer:
    """Maintains a rolling buffer of recent PCM audio and captures snapshots on demand.

    Accepts the same raw PCM-16 byte chunks as the WebSocket server receives.
    On ``capture()``, snapshots whatever audio is currently buffered (~2-3 seconds)
    and returns WAV bytes along with metadata suitable for writing to disk.
    """

    def __init__(self, buffer_seconds: float = 3.0, sample_rate: int = SAMPLE_RATE) -> None:
        self.sample_rate = sample_rate
        self.max_samples = int(buffer_seconds * sample_rate)
        self._buffer = np.zeros(self.max_samples, dtype=np.float32)
        self._fill = 0  # valid samples in the buffer

    def append(self, chunk: bytes) -> None:
        """Append raw PCM-16 bytes (mono, 44100 Hz) to the rolling buffer."""
        if len(chunk) == 0:
            return
        samples = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0
        n = len(samples)

        if n >= self.max_samples:
            self._buffer[:] = samples[-self.max_samples:]
            self._fill = self.max_samples
        elif self._fill + n <= self.max_samples:
            self._buffer[self._fill : self._fill + n] = samples
            self._fill += n
        else:
            keep = self.max_samples - n
            self._buffer[:keep] = self._buffer[self._fill - keep : self._fill]
            self._buffer[keep:] = samples
            self._fill = self.max_samples

    def capture(self, syllable: str, hit: bool) -> tuple[bytes, dict]:
        """Snapshot the current buffer and return (wav_bytes, metadata_dict).

        Parameters
        ----------
        syllable:
            The solfege syllable the player was supposed to sing.
        hit:
            Whether the player made a sound when the note was in the crosshair.

        Returns
        -------
        A tuple of (wav_bytes, metadata) where wav_bytes is a complete WAV file
        and metadata is a dict suitable for JSON serialisation.
        """
        audio = self._buffer[: self._fill].copy()
        duration = self._fill / self.sample_rate

        # Encode to WAV in memory
        wav_io = io.BytesIO()
        sf.write(wav_io, audio, self.sample_rate, subtype="PCM_16", format="WAV")
        wav_bytes = wav_io.getvalue()

        timestamp = datetime.now(timezone.utc).isoformat()

        metadata = {
            "syllable": syllable,
            "timestamp": timestamp,
            "hit": hit,
            "sample_rate": self.sample_rate,
            "channels": 1,
            "duration_seconds": round(duration, 3),
        }

        logger.info(
            "Captured %.3fs of audio for syllable '%s' (hit=%s, %d bytes WAV)",
            duration,
            syllable,
            hit,
            len(wav_bytes),
        )
        return wav_bytes, metadata

    def reset(self) -> None:
        """Clear the buffer."""
        self._buffer[:] = 0.0
        self._fill = 0
