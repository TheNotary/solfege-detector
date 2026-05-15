"""Unit tests for the onset_segmenter module."""

import numpy as np
import pytest

from solfege_detector.onset_segmenter import segment_onsets

SR = 44_100


def _make_burst(duration_s: float, freq: float = 440.0, amplitude: float = 0.8) -> np.ndarray:
    """Generate a sine burst with a quick attack envelope."""
    length = int(duration_s * SR)
    t = np.linspace(0, duration_s, length, dtype=np.float32)
    envelope = np.minimum(t * 20, 1.0).astype(np.float32)  # 50ms attack
    return amplitude * np.sin(2 * np.pi * freq * t).astype(np.float32) * envelope


def _place_bursts(total_duration: float, onsets: list[float], burst_duration: float = 0.15) -> np.ndarray:
    """Place tone bursts at specified onset times within a silence array."""
    audio = np.zeros(int(total_duration * SR), dtype=np.float32)
    burst = _make_burst(burst_duration)
    for onset_sec in onsets:
        start = int(onset_sec * SR)
        end = start + len(burst)
        if end <= len(audio):
            audio[start:end] = burst
    return audio


class TestMultiSyllable:
    """Test detection of multiple syllable onsets."""

    def test_three_bursts_detected(self):
        expected_onsets = [0.2, 0.6, 1.1]
        audio = _place_bursts(1.5, expected_onsets)
        segments = segment_onsets(audio, SR)

        assert len(segments) == 3, f"Expected 3 segments, got {len(segments)}"

    def test_three_bursts_within_50ms_tolerance(self):
        expected_onsets = [0.2, 0.6, 1.1]
        audio = _place_bursts(1.5, expected_onsets)
        segments = segment_onsets(audio, SR)

        for i, (start, _end) in enumerate(segments):
            actual_sec = start / SR
            error_ms = abs(actual_sec - expected_onsets[i]) * 1000
            assert error_ms < 50, (
                f"Onset {i}: expected {expected_onsets[i]:.3f}s, "
                f"got {actual_sec:.3f}s, error={error_ms:.1f}ms"
            )

    def test_segment_boundaries_contiguous(self):
        """Each segment's end should equal the next segment's start."""
        audio = _place_bursts(1.5, [0.2, 0.6, 1.1])
        segments = segment_onsets(audio, SR)

        for i in range(len(segments) - 1):
            assert segments[i][1] == segments[i + 1][0], (
                f"Gap between segment {i} end ({segments[i][1]}) "
                f"and segment {i+1} start ({segments[i+1][0]})"
            )

    def test_last_segment_ends_at_audio_length(self):
        audio = _place_bursts(1.5, [0.2, 0.6, 1.1])
        segments = segment_onsets(audio, SR)
        assert segments[-1][1] == len(audio)


class TestSingleSyllable:
    """Test that a single tone burst produces exactly one segment."""

    def test_single_burst_one_segment(self):
        audio = _place_bursts(1.5, [0.5], burst_duration=0.3)
        segments = segment_onsets(audio, SR)
        assert len(segments) == 1

    def test_single_burst_starts_near_onset(self):
        audio = _place_bursts(1.5, [0.5], burst_duration=0.3)
        segments = segment_onsets(audio, SR)
        actual_sec = segments[0][0] / SR
        assert abs(actual_sec - 0.5) < 0.05, f"Expected ~0.5s, got {actual_sec:.3f}s"


class TestSilence:
    """Test behavior with silent audio."""

    def test_silence_returns_full_span(self):
        audio = np.zeros(int(1.5 * SR), dtype=np.float32)
        segments = segment_onsets(audio, SR)
        assert segments == [(0, len(audio))]

    def test_empty_audio(self):
        audio = np.zeros(0, dtype=np.float32)
        segments = segment_onsets(audio, SR)
        assert segments == [(0, 0)]


class TestContinuousTone:
    """Test that a continuous tone (no clear onset) produces one segment."""

    def test_constant_sine_one_segment(self):
        t = np.linspace(0, 1.5, int(1.5 * SR), dtype=np.float32)
        audio = 0.5 * np.sin(2 * np.pi * 440 * t).astype(np.float32)
        segments = segment_onsets(audio, SR)
        assert len(segments) == 1


class TestDebounce:
    """Test that closely-spaced onsets are debounced into one."""

    def test_bursts_within_min_gap_merged(self):
        """Two bursts 120ms apart (< 200ms default) should be one segment."""
        audio = _place_bursts(1.5, [0.3, 0.42], burst_duration=0.08)
        segments = segment_onsets(audio, SR)
        assert len(segments) == 1

    def test_bursts_beyond_min_gap_separate(self):
        """Two bursts 400ms apart (> 200ms default) should be two segments."""
        audio = _place_bursts(1.5, [0.3, 0.7], burst_duration=0.1)
        segments = segment_onsets(audio, SR)
        assert len(segments) == 2

    def test_custom_min_gap(self):
        """Increasing min_gap should merge more onsets."""
        audio = _place_bursts(1.5, [0.2, 0.6, 1.1])
        # With a very large min_gap, all should merge into 1
        segments = segment_onsets(audio, SR, min_gap_seconds=1.0)
        assert len(segments) == 1
