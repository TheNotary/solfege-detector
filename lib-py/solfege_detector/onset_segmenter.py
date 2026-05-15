"""Onset detection and audio segmentation for isolating individual syllables."""

from typing import List, Tuple

import librosa
import numpy as np


def segment_onsets(
    audio: np.ndarray,
    sr: int,
    min_gap_seconds: float = 0.2,
    onset_delta: float = 0.07,
) -> List[Tuple[int, int]]:
    """Segment audio into individual note regions using onset detection.

    Args:
        audio: 1-D float32 audio array normalized to [-1, 1].
        sr: Sample rate in Hz.
        min_gap_seconds: Minimum time between onsets (debounce).
        onset_delta: Onset detection threshold (higher = fewer onsets).

    Returns:
        List of (start_sample, end_sample) tuples. Each segment ends where the
        next begins, or at the end of the audio for the last segment.
        Always returns at least one segment spanning the full audio.
    """
    if len(audio) == 0:
        return [(0, 0)]

    # Detect onsets with backtracking to find true syllable starts
    onset_frames = librosa.onset.onset_detect(
        y=audio,
        sr=sr,
        backtrack=True,
        units="frames",
        hop_length=512,
        delta=onset_delta,
        wait=int(min_gap_seconds * sr / 512),
    )

    if len(onset_frames) == 0:
        return [(0, len(audio))]

    # Convert frames to samples
    onset_samples = librosa.frames_to_samples(onset_frames, hop_length=512)

    # Energy-rise gate: only keep onsets where energy is rising (true attacks).
    # Compare RMS in a short window AFTER the onset vs BEFORE the onset.
    # A true onset has significantly more energy after than before.
    gate_window = int(0.03 * sr)  # 30ms comparison window
    energy_gated: List[int] = []
    for s in onset_samples:
        s = int(s)
        # RMS after the onset point
        after_start = s
        after_end = min(len(audio), s + gate_window)
        if after_end <= after_start:
            continue
        rms_after = np.sqrt(np.mean(audio[after_start:after_end] ** 2))

        # RMS before the onset point
        before_end = s
        before_start = max(0, s - gate_window)
        if before_end <= before_start:
            # At the very start of audio, keep onset if energy is present
            if rms_after > 0.01:
                energy_gated.append(s)
            continue
        rms_before = np.sqrt(np.mean(audio[before_start:before_end] ** 2))

        # Keep onset only if there's a meaningful energy rise or it starts from silence
        if rms_before < 0.01 and rms_after > 0.01:
            # Transition from silence to sound — definite onset
            energy_gated.append(s)
        elif rms_after > rms_before * 1.5 and rms_after > 0.01:
            # Significant energy increase — likely a new syllable
            energy_gated.append(s)

    if len(energy_gated) == 0:
        return [(0, len(audio))]

    # Debounce: remove onsets that are too close together
    min_gap_samples = int(min_gap_seconds * sr)
    filtered: List[int] = [energy_gated[0]]
    for i in range(1, len(energy_gated)):
        if energy_gated[i] - filtered[-1] >= min_gap_samples:
            filtered.append(energy_gated[i])

    if len(filtered) == 0:
        return [(0, len(audio))]

    # Build segments: each segment runs from its onset to the next onset (or end)
    segments: List[Tuple[int, int]] = []
    for i, start in enumerate(filtered):
        end = filtered[i + 1] if i + 1 < len(filtered) else len(audio)
        segments.append((start, end))

    return segments
