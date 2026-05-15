"""Trim leading and trailing silence from audio signals."""

import logging
from typing import List, Tuple

import numpy as np

logger = logging.getLogger(__name__)

# Default RMS threshold below which audio is considered silence.
DEFAULT_SILENCE_THRESHOLD_DB = -40.0
# Size of the RMS analysis window in seconds.
DEFAULT_FRAME_SECONDS = 0.01
# Extra padding (in seconds) to keep on each side of the voiced region.
DEFAULT_PAD_SECONDS = 0.15
# Minimum silence gap (in seconds) to split voiced segments.
DEFAULT_MIN_SILENCE_SECONDS = 0.06


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


def _compute_frame_rms(
    audio: np.ndarray,
    sr: int,
    frame_seconds: float = DEFAULT_FRAME_SECONDS,
    threshold_db: float = DEFAULT_SILENCE_THRESHOLD_DB,
) -> Tuple[np.ndarray, np.ndarray, int, float]:
    """Shared helper: compute per-frame RMS and voiced mask.

    Returns (rms, voiced_mask, frame_len, threshold_linear).
    """
    frame_len = max(1, int(frame_seconds * sr))
    threshold_linear = 10.0 ** (threshold_db / 20.0)
    n_frames = len(audio) // frame_len
    if n_frames == 0:
        rms = np.array([np.sqrt(np.mean(audio ** 2))]) if len(audio) > 0 else np.array([0.0])
        voiced = rms >= threshold_linear
        return rms, voiced, max(len(audio), 1), threshold_linear
    frames = audio[: n_frames * frame_len].reshape(n_frames, frame_len)
    rms = np.sqrt(np.mean(frames ** 2, axis=1))
    voiced = rms >= threshold_linear
    return rms, voiced, frame_len, threshold_linear


def split_on_silence(
    audio: np.ndarray,
    sr: int,
    *,
    threshold_db: float = DEFAULT_SILENCE_THRESHOLD_DB,
    frame_seconds: float = DEFAULT_FRAME_SECONDS,
    min_silence_seconds: float = DEFAULT_MIN_SILENCE_SECONDS,
    pad_seconds: float = DEFAULT_PAD_SECONDS,
) -> List[Tuple[int, int]]:
    """Split audio into voiced segments separated by silence gaps.

    Unlike ``trim_silence`` which only trims edges, this finds *all* voiced
    regions in the signal, splitting wherever there's a silence gap of at
    least ``min_silence_seconds``.

    Parameters
    ----------
    audio:
        Mono float32 audio in [-1, 1].
    sr:
        Sample rate.
    threshold_db:
        RMS below this is silence.
    frame_seconds:
        Analysis frame size.
    min_silence_seconds:
        Minimum silence duration (in seconds) to split on.  Gaps shorter
        than this are bridged (treated as part of a single syllable).
    pad_seconds:
        Padding to keep on each side of each voiced segment.

    Returns
    -------
    List of (start_sample, end_sample) tuples.  Empty list if the signal
    is entirely silent.
    """
    if len(audio) == 0:
        return []

    rms, voiced, frame_len, _ = _compute_frame_rms(audio, sr, frame_seconds, threshold_db)

    if not np.any(voiced):
        return []

    min_silence_frames = max(1, int(min_silence_seconds / frame_seconds))
    pad_samples = int(pad_seconds * sr)

    # Walk frames and group voiced runs, splitting on silence gaps
    segments: List[Tuple[int, int]] = []
    in_voiced = False
    seg_start_frame = 0
    silence_count = 0

    for i, v in enumerate(voiced):
        if v:
            if not in_voiced:
                seg_start_frame = i
                in_voiced = True
            silence_count = 0
        else:
            if in_voiced:
                silence_count += 1
                if silence_count >= min_silence_frames:
                    # End this segment at the frame before the silence gap started
                    seg_end_frame = i - silence_count + 1
                    start_s = max(0, seg_start_frame * frame_len - pad_samples)
                    end_s = min(len(audio), seg_end_frame * frame_len + pad_samples)
                    segments.append((start_s, end_s))
                    in_voiced = False
                    silence_count = 0

    # Close final segment if we ended inside a voiced region
    if in_voiced:
        # Find last voiced frame
        last_voiced = len(voiced) - 1
        while last_voiced >= seg_start_frame and not voiced[last_voiced]:
            last_voiced -= 1
        seg_end_frame = last_voiced + 1
        start_s = max(0, seg_start_frame * frame_len - pad_samples)
        end_s = min(len(audio), seg_end_frame * frame_len + pad_samples)
        segments.append((start_s, end_s))

    # Clamp overlapping segments: if padding causes overlap, split at midpoint
    for i in range(len(segments) - 1):
        if segments[i][1] > segments[i + 1][0]:
            mid = (segments[i][1] + segments[i + 1][0]) // 2
            segments[i] = (segments[i][0], mid)
            segments[i + 1] = (mid, segments[i + 1][1])

    logger.debug(
        "split_on_silence: %d segment(s) from %.3fs audio",
        len(segments), len(audio) / sr,
    )
    return segments


def pick_center_segment(
    segments: List[Tuple[int, int]],
    total_samples: int,
) -> Tuple[int, int]:
    """Pick the voiced segment closest to the center of the audio.

    The per-note capture window is centered on the crosshair, so the
    target syllable is most likely near the temporal midpoint.

    Parameters
    ----------
    segments:
        List of (start_sample, end_sample) from ``split_on_silence``.
    total_samples:
        Total length of the original audio.

    Returns
    -------
    The (start, end) tuple of the best segment.
    """
    if len(segments) == 1:
        return segments[0]

    center = total_samples / 2.0
    best = segments[0]
    best_dist = abs((best[0] + best[1]) / 2.0 - center)

    for seg in segments[1:]:
        mid = (seg[0] + seg[1]) / 2.0
        dist = abs(mid - center)
        if dist < best_dist:
            best = seg
            best_dist = dist

    return best
