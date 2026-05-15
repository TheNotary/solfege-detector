"""Core solfege syllable detection engine using CLAP zero-shot classification."""

import logging
import os
import sys
import tempfile
import time
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

logger = logging.getLogger(__name__)


@dataclass
class Detection:
    """A detected solfege syllable with its confidence score."""
    syllable: str
    confidence: float
    offset_seconds: float = 0.0


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
        use_onset_segmentation: bool = True,
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
        use_onset_segmentation:
            When True and multiple onsets are detected, isolate the most
            recent syllable before classification. When False, classify
            the raw window unchanged.

        Returns
        -------
        List of ``Detection`` objects for syllables exceeding *threshold*
        whose probability also beats every negative class.
        """
        duration = len(audio) / sample_rate
        logger.info("detect() called: %d samples, %d Hz, %.3fs",
                    len(audio), sample_rate, duration)

        # Onset segmentation: isolate most recent syllable if multiple detected
        if use_onset_segmentation:
            from solfege_detector.onset_segmenter import segment_onsets

            segments = segment_onsets(audio, sample_rate)
            logger.info("Onset segmentation: %d segment(s) detected", len(segments))
            if len(segments) > 1:
                # Take the most recent (rightmost) segment
                start, end = segments[-1]
                segment_audio = audio[start:end]
                segment_duration = len(segment_audio) / sample_rate
                logger.info(
                    "Using most recent segment: %.3fs-%.3fs (%.3fs duration)",
                    start / sample_rate, end / sample_rate, segment_duration,
                )
                # Zero-pad to original window size, centering the segment
                window_samples = len(audio)
                padded = np.zeros(window_samples, dtype=np.float32)
                offset = (window_samples - len(segment_audio)) // 2
                padded[offset:offset + len(segment_audio)] = segment_audio
                audio = padded
                # TODO: If confidence is low with zero-padding, experiment with
                # looping the segment to fill the window as an alternative.

        # Write audio to a temp WAV file (CLAP requires file paths)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            tmp_path = f.name
        try:
            sf.write(tmp_path, audio, sample_rate)
            t0 = time.perf_counter()
            logger.info("CLAP audio embedding started")
            audio_embeddings = self._clap.get_audio_embeddings([tmp_path], resample=True)
            embed_ms = (time.perf_counter() - t0) * 1000
            logger.info("CLAP audio embedding completed in %.1fms", embed_ms)
        finally:
            os.unlink(tmp_path)

        # Cosine similarity → softmax probabilities
        similarity = self._clap.compute_similarity(audio_embeddings, self._text_embeddings)
        probs = F.softmax(similarity, dim=1)[0]  # shape: (num_classes,)

        # Split into solfege and negative probabilities
        solfege_probs = probs[:NUM_SOLFEGE_CLASSES]
        negative_probs = probs[NUM_SOLFEGE_CLASSES:]
        max_negative = float(negative_probs.max())

        # Log all class probabilities
        prob_parts = [f"{s}={float(p):.4f}" for s, p in zip(SOLFEGE_SYLLABLES, solfege_probs)]
        neg_parts = [f"{name}={float(p):.4f}" for name, p in zip(NEGATIVE_PROMPTS, negative_probs)]
        logger.info("Probabilities: %s | %s", " ".join(prob_parts), " ".join(neg_parts))

        detections: List[Detection] = []
        for i, (syllable, prob) in enumerate(zip(SOLFEGE_SYLLABLES, solfege_probs)):
            p = float(prob)
            if p >= threshold and p > max_negative:
                detections.append(Detection(syllable=syllable, confidence=p))

        # Sort by confidence descending
        detections.sort(key=lambda d: d.confidence, reverse=True)
        det_summary = ", ".join(f"{d.syllable}({d.confidence:.4f})" for d in detections) or "none"
        logger.info("Returning %d detection(s): %s", len(detections), det_summary)
        return detections

    def detect_multi(
        self,
        audio: np.ndarray,
        sample_rate: int = 44_100,
        threshold: float = 0.5,
    ) -> List[Detection]:
        """Classify each onset segment independently, returning multiple detections.

        Unlike ``detect()`` which only classifies the most recent segment,
        this method runs CLAP on every segment found by onset detection and
        returns one detection per segment (if above threshold).

        Note: latency scales linearly with the number of detected onsets.

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
        List of ``Detection`` objects sorted by offset_seconds ascending.
        Each detection includes the temporal offset of its segment within
        the original window.
        """
        from solfege_detector.onset_segmenter import segment_onsets

        segments = segment_onsets(audio, sample_rate)
        logger.info("detect_multi: %d segment(s) found", len(segments))

        all_detections: List[Detection] = []
        window_samples = len(audio)

        for seg_idx, (start, end) in enumerate(segments):
            segment_audio = audio[start:end]
            offset_seconds = start / sample_rate

            # Zero-pad segment to original window size, centering it
            padded = np.zeros(window_samples, dtype=np.float32)
            pad_offset = (window_samples - len(segment_audio)) // 2
            padded[pad_offset:pad_offset + len(segment_audio)] = segment_audio

            # Classify this segment (disable onset segmentation since we already segmented)
            detections = self.detect(
                padded,
                sample_rate=sample_rate,
                threshold=threshold,
                use_onset_segmentation=False,
            )

            # Attach offset to each detection from this segment
            for d in detections:
                d.offset_seconds = offset_seconds
                all_detections.append(d)

            if detections:
                logger.info(
                    "  Segment %d (%.3fs): %s",
                    seg_idx, offset_seconds,
                    ", ".join(f"{d.syllable}({d.confidence:.4f})" for d in detections),
                )
            else:
                logger.info("  Segment %d (%.3fs): no detection", seg_idx, offset_seconds)

        # Sort by offset ascending
        all_detections.sort(key=lambda d: d.offset_seconds)
        return all_detections
