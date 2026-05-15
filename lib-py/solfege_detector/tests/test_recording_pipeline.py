"""Integration tests for the recording pipeline using real captured audio.

These tests use actual microphone recordings captured at various BPM to verify
that the split-on-silence + pick-center pipeline produces audio that matches
the labeled syllable.
"""

import json
import os
from pathlib import Path
from typing import Optional

import numpy as np
import pytest
import soundfile as sf

from solfege_detector.silence_trimmer import pick_center_segment, split_on_silence

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "per_note_samples"

TARGET_FREQ = {
    "do": 130.81,
    "re": 146.83,
    "mi": 164.81,
    "fa": 174.61,
    "sol": 196.0,
    "la": 220.0,
    "ti": 246.94,
}

# Tolerance: detected pitch must be within this many Hz of the target
PITCH_TOLERANCE_HZ = 25.0


def _estimate_pitch(audio: np.ndarray, sr: int) -> Optional[float]:
    """Autocorrelation-based pitch estimator."""
    if len(audio) < 1024:
        return None
    n = len(audio)
    seg = audio[n // 4 : 3 * n // 4]
    from numpy.fft import irfft, rfft

    corr = irfft(np.abs(rfft(seg, n=len(seg) * 2)) ** 2)
    corr = corr[: len(seg)]
    min_lag = int(sr / 400)  # max 400 Hz
    max_lag = int(sr / 80)  # min 80 Hz
    if max_lag > len(corr):
        return None
    search = corr[min_lag:max_lag]
    if len(search) == 0:
        return None
    peak = np.argmax(search) + min_lag
    if peak == 0:
        return None
    return sr / peak


def _closest_syllable(freq: Optional[float]) -> Optional[str]:
    if freq is None:
        return None
    return min(TARGET_FREQ.items(), key=lambda kv: abs(kv[1] - freq))[0]


def _load_fixtures():
    """Load all per-note capture fixtures that have both raw and processed WAV."""
    if not FIXTURES_DIR.exists():
        return []
    items = []
    for meta_path in sorted(FIXTURES_DIR.glob("*.metadata")):
        base = meta_path.stem
        raw_path = FIXTURES_DIR / f"{base}.raw.wav"
        proc_path = FIXTURES_DIR / f"{base}.wav"
        if not raw_path.exists() or not proc_path.exists():
            continue
        metadata = json.loads(meta_path.read_text())
        if metadata.get("source") != "per_note_capture":
            continue
        items.append((base, metadata, raw_path, proc_path))
    return items


FIXTURES = _load_fixtures()


@pytest.mark.skipif(len(FIXTURES) == 0, reason="No per-note capture fixtures available")
class TestRecordingPipelineAccuracy:
    """Verify the split-on-silence pipeline produces correctly-labeled audio."""

    def test_processed_files_contain_voiced_audio(self):
        """Every processed file should have non-trivial RMS energy."""
        for base, metadata, _, proc_path in FIXTURES:
            audio, sr = sf.read(str(proc_path), dtype="float32")
            rms = np.sqrt(np.mean(audio**2))
            assert rms > 0.005, (
                f"{base}: processed audio is near-silent (RMS={rms:.4f})"
            )

    def test_processed_duration_reasonable(self):
        """Processed files should be between 50ms and 2s."""
        for base, metadata, _, proc_path in FIXTURES:
            audio, sr = sf.read(str(proc_path), dtype="float32")
            dur = len(audio) / sr
            assert 0.05 <= dur <= 2.0, (
                f"{base}: duration {dur:.3f}s outside expected range"
            )

    def test_raw_captures_are_longer_than_processed(self):
        """Raw captures should be >= processed (processing trims)."""
        for base, metadata, raw_path, proc_path in FIXTURES:
            raw_audio, _ = sf.read(str(raw_path), dtype="float32")
            proc_audio, _ = sf.read(str(proc_path), dtype="float32")
            assert len(raw_audio) >= len(proc_audio), (
                f"{base}: raw ({len(raw_audio)}) < processed ({len(proc_audio)})"
            )

    def test_split_on_silence_finds_segments_in_raw(self):
        """split_on_silence should find at least one segment in every raw capture."""
        for base, _, raw_path, _ in FIXTURES:
            audio, sr = sf.read(str(raw_path), dtype="float32")
            segments = split_on_silence(audio, sr)
            assert len(segments) >= 1, (
                f"{base}: no voiced segments found in raw audio"
            )

    def test_overall_pitch_accuracy_above_threshold(self):
        """At least 60% of processed files should have pitch matching the label.

        This is a statistical check — individual files may fail due to
        capture timing at high BPM, but the majority should be correct.
        """
        correct = 0
        total = 0
        failures = []
        for base, metadata, _, proc_path in FIXTURES:
            audio, sr = sf.read(str(proc_path), dtype="float32")
            pitch = _estimate_pitch(audio, sr)
            detected = _closest_syllable(pitch)
            label = metadata["syllable"]
            total += 1
            if detected == label:
                correct += 1
            else:
                failures.append(
                    f"  {base}: label={label}, detected={detected} ({pitch:.0f}Hz)"
                    if pitch
                    else f"  {base}: label={label}, detected=None"
                )

        accuracy = correct / total if total > 0 else 0
        msg = f"Pitch accuracy {correct}/{total} ({accuracy:.0%})"
        if failures:
            msg += "\nMismatches:\n" + "\n".join(failures)
        assert accuracy >= 0.60, msg

    def test_pick_center_improves_over_pick_last(self):
        """For multi-segment raw captures, pick_center should be at least as
        accurate as always picking the last segment.

        This validates the fix for the -1 offset bug where pick-last always
        returned the previous syllable.
        """
        center_correct = 0
        last_correct = 0
        multi_count = 0

        for base, metadata, raw_path, _ in FIXTURES:
            audio, sr = sf.read(str(raw_path), dtype="float32")
            segments = split_on_silence(audio, sr)
            if len(segments) <= 1:
                continue
            multi_count += 1
            label = metadata["syllable"]

            # Center pick
            cs, ce = pick_center_segment(segments, len(audio))
            center_pitch = _estimate_pitch(audio[cs:ce], sr)
            if _closest_syllable(center_pitch) == label:
                center_correct += 1

            # Last pick
            ls, le = segments[-1]
            last_pitch = _estimate_pitch(audio[ls:le], sr)
            if _closest_syllable(last_pitch) == label:
                last_correct += 1

        if multi_count == 0:
            pytest.skip("No multi-segment raw captures in fixtures")

        assert center_correct >= last_correct, (
            f"pick_center ({center_correct}/{multi_count}) should be >= "
            f"pick_last ({last_correct}/{multi_count})"
        )
