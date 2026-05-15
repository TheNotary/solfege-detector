"""Tests for solfege_detector.silence_trimmer."""

import numpy as np
import pytest

from solfege_detector.silence_trimmer import trim_silence

SR = 44_100


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
