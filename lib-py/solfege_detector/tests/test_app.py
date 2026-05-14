"""Smoke tests for solfege_detector module imports and AudioBuffer."""

import numpy as np

from solfege_detector import AudioBuffer, Detection, SolfegeDetector


class TestImports:
    def test_module_exports(self):
        assert SolfegeDetector is not None
        assert AudioBuffer is not None
        assert Detection is not None

    def test_detection_dataclass(self):
        d = Detection(syllable="do", confidence=0.95)
        assert d.syllable == "do"
        assert d.confidence == 0.95


class TestAudioBuffer:
    def test_returns_none_before_window_filled(self):
        buf = AudioBuffer(window_size_seconds=2.0, hop_size_seconds=0.5, sample_rate=8000)
        # Send 0.5 seconds (4000 samples) — not enough for 2s window
        chunk = np.zeros(4000, dtype=np.int16).tobytes()
        assert buf.append(chunk) is None

    def test_returns_window_when_full(self):
        buf = AudioBuffer(window_size_seconds=1.0, hop_size_seconds=0.5, sample_rate=8000)
        # Send 1 second (8000 samples) — fills window + meets hop
        chunk = np.zeros(8000, dtype=np.int16).tobytes()
        result = buf.append(chunk)
        assert result is not None
        assert len(result) == 8000
        assert result.dtype == np.float32

    def test_sliding_window_yields_on_hop(self):
        buf = AudioBuffer(window_size_seconds=2.0, hop_size_seconds=1.0, sample_rate=4000)
        # First 2 seconds fills window
        chunk1 = np.zeros(8000, dtype=np.int16).tobytes()
        result1 = buf.append(chunk1)
        assert result1 is not None

        # Next 0.5s — not enough for hop
        chunk2 = np.zeros(2000, dtype=np.int16).tobytes()
        assert buf.append(chunk2) is None

        # Another 0.5s — now meets 1s hop
        result2 = buf.append(chunk2)
        assert result2 is not None

    def test_reset_clears_buffer(self):
        buf = AudioBuffer(window_size_seconds=1.0, hop_size_seconds=0.5, sample_rate=8000)
        chunk = np.zeros(8000, dtype=np.int16).tobytes()
        buf.append(chunk)
        buf.reset()
        # After reset, should need full window again
        assert buf.append(np.zeros(2000, dtype=np.int16).tobytes()) is None
