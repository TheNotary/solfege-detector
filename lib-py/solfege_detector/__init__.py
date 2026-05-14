"""
Solfege Detector — real-time solfege syllable detection using CLAP zero-shot audio classification.

Detects standard solfege syllables (do, re, mi, fa, sol, la, ti) from audio streams
using Microsoft CLAP's contrastive language-audio pretraining model.
"""

from solfege_detector.audio_buffer import AudioBuffer
from solfege_detector.detector import Detection, SolfegeDetector

__all__ = ["AudioBuffer", "Detection", "SolfegeDetector"]
