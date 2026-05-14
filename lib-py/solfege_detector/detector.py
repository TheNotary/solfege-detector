"""Core solfege syllable detection engine using CLAP zero-shot classification."""

import os
import sys
import tempfile
from dataclasses import dataclass
from typing import List

import numpy as np
import soundfile as sf
import torch
import torch.nn.functional as F

# Add accoustic-model to path so we can import prompt_config
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_ACCOUSTIC_MODEL_DIR = os.path.join(_REPO_ROOT, "accoustic-model")
if _ACCOUSTIC_MODEL_DIR not in sys.path:
    sys.path.insert(0, _ACCOUSTIC_MODEL_DIR)

from prompt_config import (
    ALL_PROMPTS,
    NEGATIVE_PROMPTS,
    NUM_SOLFEGE_CLASSES,
    SOLFEGE_SYLLABLES,
)


@dataclass
class Detection:
    """A detected solfege syllable with its confidence score."""
    syllable: str
    confidence: float


class SolfegeDetector:
    """Zero-shot solfege syllable detector using Microsoft CLAP.

    Loads the CLAP model once and pre-computes text embeddings for solfege
    and negative-class prompts.  The ``detect`` method runs audio embeddings
    per call and returns syllables whose probability exceeds a threshold.
    """

    SAMPLE_RATE = 44_100

    def __init__(self, use_cuda: bool = False) -> None:
        from msclap import CLAP

        self._clap = CLAP(version="2023", use_cuda=use_cuda)
        # Pre-compute text embeddings (expensive — done once)
        self._text_embeddings = self._clap.get_text_embeddings(ALL_PROMPTS)

    def detect(
        self,
        audio: np.ndarray,
        sample_rate: int = 44_100,
        threshold: float = 0.5,
    ) -> List[Detection]:
        """Run zero-shot classification on a float32 audio chunk.

        Parameters
        ----------
        audio:
            1-D float32 numpy array normalised to [-1, 1].
        sample_rate:
            Sample rate of *audio*.
        threshold:
            Minimum probability for a solfege syllable to be returned.

        Returns
        -------
        List of ``Detection`` objects for syllables exceeding *threshold*
        whose probability also beats every negative class.
        """
        # Write audio to a temp WAV file (CLAP requires file paths)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            tmp_path = f.name
        try:
            sf.write(tmp_path, audio, sample_rate)
            audio_embeddings = self._clap.get_audio_embeddings([tmp_path], resample=True)
        finally:
            os.unlink(tmp_path)

        # Cosine similarity → softmax probabilities
        similarity = self._clap.compute_similarity(audio_embeddings, self._text_embeddings)
        probs = F.softmax(similarity, dim=1)[0]  # shape: (num_classes,)

        # Split into solfege and negative probabilities
        solfege_probs = probs[:NUM_SOLFEGE_CLASSES]
        negative_probs = probs[NUM_SOLFEGE_CLASSES:]
        max_negative = float(negative_probs.max())

        detections: List[Detection] = []
        for i, (syllable, prob) in enumerate(zip(SOLFEGE_SYLLABLES, solfege_probs)):
            p = float(prob)
            if p >= threshold and p > max_negative:
                detections.append(Detection(syllable=syllable, confidence=p))

        # Sort by confidence descending
        detections.sort(key=lambda d: d.confidence, reverse=True)
        return detections
