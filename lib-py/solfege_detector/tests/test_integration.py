"""Integration tests for solfege syllable detection.

These tests use the CLAP model directly with TTS-generated fixture files.
They are slow (~10s for model loading) — use pytest -m integration to run
them selectively.

NOTE: TTS (gTTS) generates spoken English, not sung solfege. The CLAP prompts
target "someone singing the solfege syllable X", so only syllables whose spoken
pronunciation closely matches the sung sound (e.g. "mi", "la") reliably map.
Pipeline / signal-vs-noise tests are the primary validation here.
"""

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from solfege_detector.detector import SolfegeDetector

FIXTURES_DIR = Path(__file__).parent / "fixtures"
SOLFEGE_SYLLABLES = ["do", "re", "mi", "fa", "sol", "la", "ti"]


@pytest.fixture(scope="session")
def detector():
    """Shared SolfegeDetector — loaded once for the entire test session."""
    return SolfegeDetector(use_cuda=False)


def _load_audio(filename: str) -> tuple[np.ndarray, int]:
    """Load an audio fixture file as float32 numpy array."""
    path = FIXTURES_DIR / filename
    data, sr = sf.read(str(path), dtype="float32")
    return data, sr


class TestDetectorPipeline:
    """Validate the detection pipeline processes audio without errors."""

    @pytest.mark.parametrize("syllable", SOLFEGE_SYLLABLES)
    def test_returns_detections_for_speech(self, detector, syllable):
        """Each TTS fixture should produce some solfege detection at low threshold."""
        audio, sr = _load_audio(f"{syllable}.mp3")
        detections = detector.detect(audio, sample_rate=sr, threshold=0.1)

        # Pipeline must return Detection objects (TTS speech triggers some solfege)
        assert len(detections) > 0, (
            f"Expected at least one detection for '{syllable}' TTS audio"
        )
        assert all(d.syllable in SOLFEGE_SYLLABLES for d in detections)
        assert all(0 < d.confidence <= 1 for d in detections)

    def test_detections_sorted_by_confidence(self, detector):
        """Results should be sorted descending by confidence."""
        audio, sr = _load_audio("mi.mp3")
        detections = detector.detect(audio, sample_rate=sr, threshold=0.1)
        confidences = [d.confidence for d in detections]
        assert confidences == sorted(confidences, reverse=True)


class TestAccuracyKnownGood:
    """Accuracy tests for syllables where TTS pronunciation matches solfege."""

    @pytest.mark.parametrize("syllable", ["mi", "la"])
    def test_correctly_identifies_syllable(self, detector, syllable):
        """'mi' and 'la' TTS speech closely matches the sung solfege sound."""
        audio, sr = _load_audio(f"{syllable}.mp3")
        detections = detector.detect(audio, sample_rate=sr, threshold=0.1)

        detected_syllables = [d.syllable for d in detections]
        assert syllable in detected_syllables, (
            f"Expected '{syllable}' in detections, got: {detections}"
        )


class TestNoiseRejection:
    """Tests that the detector ignores non-solfege audio."""

    def test_ignores_silence(self, detector):
        """Pure silence should produce no detections."""
        silence = np.zeros(44100 * 7, dtype=np.float32)
        detections = detector.detect(silence, sample_rate=44100, threshold=0.3)

        assert len(detections) == 0, (
            f"Expected no detections on silence, got: {detections}"
        )

    def test_speech_scores_higher_than_silence(self, detector):
        """Speech fixture should score higher than silence."""
        mi_audio, mi_sr = _load_audio("mi.mp3")
        mi_dets = detector.detect(mi_audio, sample_rate=mi_sr, threshold=0.01)
        mi_max = max((d.confidence for d in mi_dets), default=0)

        silence = np.zeros(44100 * 7, dtype=np.float32)
        silence_dets = detector.detect(silence, sample_rate=44100, threshold=0.01)
        silence_max = max((d.confidence for d in silence_dets), default=0)

        assert mi_max > silence_max, (
            f"Speech should score higher than silence: "
            f"mi={mi_max:.3f}, silence={silence_max:.3f}"
        )


class TestNoisyDetection:
    """Tests detection in noisy conditions."""

    def test_mixed_audio_produces_detections(self, detector):
        """Audio with solfege overlaid on chatter should produce detections."""
        audio, sr = _load_audio("do_with_noise.wav")
        detections = detector.detect(audio, sample_rate=sr, threshold=0.1)

        assert len(detections) > 0, (
            f"Expected detections in noisy audio, got none"
        )
