"""Trim leading and trailing silence from audio signals."""

import logging

import numpy as np

logger = logging.getLogger(__name__)

# Default RMS threshold below which audio is considered silence.
DEFAULT_SILENCE_THRESHOLD_DB = -40.0
# Size of the RMS analysis window in seconds.
DEFAULT_FRAME_SECONDS = 0.01
# Extra padding (in seconds) to keep on each side of the voiced region.
DEFAULT_PAD_SECONDS = 0.05


def trim_silence(
    audio: np.ndarray,
    sr: int,
    *,
    threshold_db: float = DEFAULT_SILENCE_THRESHOLD_DB,
    frame_seconds: float = DEFAULT_FRAME_SECONDS,
    pad_seconds: float = DEFAULT_PAD_SECONDS,
) -> np.ndarray:
    """Remove leading and trailing silence from a 1-D float32 audio array.

    Parameters
    ----------
    audio:
        Mono audio signal, expected float32 in [-1, 1].
    sr:
        Sample rate in Hz.
    threshold_db:
        RMS below this dB level is treated as silence.  -40 dB is a good
        default for microphone recordings.
    frame_seconds:
        Duration of each analysis frame.
    pad_seconds:
        Extra audio to preserve on each side of the detected voiced region
        so consonant transients aren't clipped.

    Returns
    -------
    Trimmed audio (may be the original array unchanged if no trimming needed,
    or an empty array if the entire signal is silent).
    """
    if len(audio) == 0:
        return audio

    frame_len = max(1, int(frame_seconds * sr))
    threshold_linear = 10.0 ** (threshold_db / 20.0)

    # Compute per-frame RMS
    n_frames = len(audio) // frame_len
    if n_frames == 0:
        # Audio shorter than one frame — check the whole thing
        rms = np.sqrt(np.mean(audio ** 2))
        if rms < threshold_linear:
            return np.array([], dtype=audio.dtype)
        return audio

    frames = audio[: n_frames * frame_len].reshape(n_frames, frame_len)
    rms = np.sqrt(np.mean(frames ** 2, axis=1))

    # Find first and last frame above threshold
    voiced = np.where(rms >= threshold_linear)[0]
    if len(voiced) == 0:
        logger.debug("trim_silence: entire signal is below threshold (%.1f dB)", threshold_db)
        return np.array([], dtype=audio.dtype)

    first_frame = voiced[0]
    last_frame = voiced[-1]

    pad_samples = int(pad_seconds * sr)
    start_sample = max(0, first_frame * frame_len - pad_samples)
    end_sample = min(len(audio), (last_frame + 1) * frame_len + pad_samples)

    trimmed = audio[start_sample:end_sample]

    if len(trimmed) < len(audio):
        removed_ms = (len(audio) - len(trimmed)) / sr * 1000
        logger.debug(
            "trim_silence: removed %.0fms of silence (%.3fs → %.3fs)",
            removed_ms,
            len(audio) / sr,
            len(trimmed) / sr,
        )

    return trimmed
