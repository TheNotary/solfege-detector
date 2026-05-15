"""Tests for solfege_detector.silence_trimmer."""

import numpy as np
import pytest

from solfege_detector.silence_trimmer import (
    pick_center_segment,
    split_on_silence,
    trim_silence,
)

SR = 44_100


def _tone(duration_s: float, freq: float = 440.0, amp: float = 0.5) -> np.ndarray:
    """Generate a sine tone."""
    t = np.arange(int(SR * duration_s))
    return (amp * np.sin(2 * np.pi * freq * t / SR)).astype(np.float32)


def _silence(duration_s: float) -> np.ndarray:
    return np.zeros(int(SR * duration_s), dtype=np.float32)


class TestTrimSilence:
    """Core trimming behaviour."""

    def test_trims_leading_silence(self):
        silence = np.zeros(SR, dtype=np.float32)  # 1s silence
        tone = 0.5 * np.sin(2 * np.pi * 440 * np.arange(SR // 2) / SR).astype(np.float32)
        audio = np.concatenate([silence, tone])
        trimmed = trim_silence(audio, SR)
        # Should be much shorter than original — silence removed
        assert len(trimmed) < len(audio)
        # Trimmed should still contain most of the tone
        assert len(trimmed) >= len(tone) * 0.9

    def test_trims_trailing_silence(self):
        tone = 0.5 * np.sin(2 * np.pi * 440 * np.arange(SR // 2) / SR).astype(np.float32)
        silence = np.zeros(SR, dtype=np.float32)
        audio = np.concatenate([tone, silence])
        trimmed = trim_silence(audio, SR)
        assert len(trimmed) < len(audio)
        assert len(trimmed) >= len(tone) * 0.9

    def test_trims_both_sides(self):
        silence = np.zeros(SR, dtype=np.float32)
        tone = 0.5 * np.sin(2 * np.pi * 440 * np.arange(SR // 4) / SR).astype(np.float32)
        audio = np.concatenate([silence, tone, silence])
        trimmed = trim_silence(audio, SR)
        # Should be roughly the tone length + small padding
        assert len(trimmed) < len(audio) * 0.5

    def test_no_trim_needed(self):
        """Audio that's all voiced should come back unchanged."""
        tone = 0.5 * np.sin(2 * np.pi * 440 * np.arange(SR) / SR).astype(np.float32)
        trimmed = trim_silence(tone, SR)
        assert len(trimmed) == len(tone)

    def test_all_silence_returns_empty(self):
        silence = np.zeros(SR, dtype=np.float32)
        trimmed = trim_silence(silence, SR)
        assert len(trimmed) == 0

    def test_empty_input(self):
        audio = np.array([], dtype=np.float32)
        trimmed = trim_silence(audio, SR)
        assert len(trimmed) == 0


class TestPadding:
    """Padding preserves transients."""

    def test_padding_keeps_context(self):
        """With pad_seconds > 0, trimmed audio includes some silence before the tone."""
        silence = np.zeros(SR, dtype=np.float32)
        tone = 0.5 * np.sin(2 * np.pi * 440 * np.arange(SR // 2) / SR).astype(np.float32)
        audio = np.concatenate([silence, tone])
        trimmed = trim_silence(audio, SR, pad_seconds=0.1)
        # Should be longer than just the tone (pad included)
        assert len(trimmed) > len(tone)

    def test_zero_padding(self):
        silence = np.zeros(SR, dtype=np.float32)
        tone = 0.5 * np.sin(2 * np.pi * 440 * np.arange(SR // 2) / SR).astype(np.float32)
        audio = np.concatenate([silence, tone])
        trimmed = trim_silence(audio, SR, pad_seconds=0.0)
        # Without padding, trim is tighter
        assert len(trimmed) <= len(tone) + SR * 0.02  # allow one frame tolerance


class TestThreshold:
    """Threshold sensitivity."""

    def test_quiet_signal_above_threshold(self):
        """A quiet but non-silent signal should not be trimmed away."""
        # -30 dB signal
        amplitude = 10.0 ** (-30 / 20.0)
        tone = amplitude * np.sin(2 * np.pi * 440 * np.arange(SR) / SR).astype(np.float32)
        # With default -40 dB threshold, this should be kept
        trimmed = trim_silence(tone, SR)
        assert len(trimmed) == len(tone)

    def test_stricter_threshold_trims_quiet(self):
        """A stricter threshold should trim a quiet signal."""
        amplitude = 10.0 ** (-35 / 20.0)  # -35 dB
        silence = np.zeros(SR // 2, dtype=np.float32)
        tone = amplitude * np.sin(2 * np.pi * 440 * np.arange(SR) / SR).astype(np.float32)
        audio = np.concatenate([silence, tone, silence])
        # -20 dB threshold: the -35 dB tone should be trimmed away
        trimmed = trim_silence(audio, SR, threshold_db=-20.0)
        assert len(trimmed) == 0


class TestSplitOnSilence:
    """split_on_silence: find voiced segments separated by silence gaps."""

    def test_three_syllables_with_100ms_gaps(self):
        """The exact scenario reported: do (100ms) re (100ms) mi should yield 3 segments."""
        audio = np.concatenate([
            _tone(0.3, 261),   # "do" ~300ms
            _silence(0.1),     # 100ms gap
            _tone(0.3, 293),   # "re" ~300ms
            _silence(0.1),     # 100ms gap
            _tone(0.3, 329),   # "mi" ~300ms
        ])
        segments = split_on_silence(audio, SR, min_silence_seconds=0.06)
        assert len(segments) == 3

    def test_single_syllable_one_segment(self):
        audio = np.concatenate([_silence(0.2), _tone(0.4), _silence(0.2)])
        segments = split_on_silence(audio, SR)
        assert len(segments) == 1

    def test_all_silence_returns_empty(self):
        audio = _silence(1.0)
        segments = split_on_silence(audio, SR)
        assert len(segments) == 0

    def test_empty_audio(self):
        audio = np.array([], dtype=np.float32)
        segments = split_on_silence(audio, SR)
        assert len(segments) == 0

    def test_continuous_tone_one_segment(self):
        audio = _tone(1.0)
        segments = split_on_silence(audio, SR)
        assert len(segments) == 1

    def test_short_gap_not_split(self):
        """Gaps shorter than min_silence_seconds should not cause a split."""
        audio = np.concatenate([
            _tone(0.3),
            _silence(0.03),   # 30ms gap — below 60ms threshold
            _tone(0.3),
        ])
        segments = split_on_silence(audio, SR, min_silence_seconds=0.06)
        assert len(segments) == 1

    def test_two_syllables_200ms_gap(self):
        audio = np.concatenate([
            _tone(0.4, 440),
            _silence(0.2),
            _tone(0.4, 523),
        ])
        segments = split_on_silence(audio, SR)
        assert len(segments) == 2
        # Each segment should cover roughly the tone duration + padding
        for s, e in segments:
            dur = (e - s) / SR
            assert 0.3 < dur < 0.6

    def test_segments_dont_overlap(self):
        audio = np.concatenate([
            _tone(0.3, 261),
            _silence(0.15),
            _tone(0.3, 293),
            _silence(0.15),
            _tone(0.3, 329),
        ])
        segments = split_on_silence(audio, SR)
        for i in range(len(segments) - 1):
            assert segments[i][1] <= segments[i + 1][0], \
                f"Segment {i} end ({segments[i][1]}) overlaps segment {i+1} start ({segments[i+1][0]})"


class TestPickCenterSegment:
    """pick_center_segment: choose the segment nearest the midpoint."""

    def test_picks_middle_of_three(self):
        """With 3 equally-spaced segments, should pick the middle one."""
        # Segments at [0-100], [200-300], [400-500] in a 500-sample signal
        segments = [(0, 100), (200, 300), (400, 500)]
        best = pick_center_segment(segments, 500)
        assert best == (200, 300)

    def test_picks_only_segment(self):
        segments = [(10, 90)]
        best = pick_center_segment(segments, 100)
        assert best == (10, 90)

    def test_three_syllables_center_is_target(self):
        """Simulates do-re-mi capture where 're' is at the crosshair."""
        # "do" at 0.0-0.3s, "re" at 0.4-0.7s, "mi" at 0.8-1.1s
        # total = 1.1s ≈ 48510 samples, center = 24255
        do_seg = (0, int(0.3 * SR))
        re_seg = (int(0.4 * SR), int(0.7 * SR))
        mi_seg = (int(0.8 * SR), int(1.1 * SR))
        total = int(1.1 * SR)
        best = pick_center_segment([do_seg, re_seg, mi_seg], total)
        assert best == re_seg

    def test_biased_toward_later_when_centered_between_two(self):
        """When two segments are equidistant, either is acceptable."""
        segments = [(0, 100), (400, 500)]
        best = pick_center_segment(segments, 500)
        # Center is 250; seg0 mid=50, seg1 mid=450. Seg0 is closer (200 vs 200).
        # Either is fine — just verify it returns one of them.
        assert best in segments
