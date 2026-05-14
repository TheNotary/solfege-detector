"""Generate TTS test fixture .mp3 files for solfege detection integration tests.

Usage:
    cd lib-py && uv run python solfege_detector/tests/generate_fixtures.py
"""

import os
from pathlib import Path

import numpy as np
import soundfile as sf
from gtts import gTTS

FIXTURES_DIR = Path(__file__).parent / "fixtures"

SOLFEGE_SYLLABLES = ["do", "re", "mi", "fa", "sol", "la", "ti"]

CHATTER_TEXT = (
    "The weather is really nice today. "
    "I wonder what time it is. "
    "Did you remember to pick up groceries? "
    "The meeting starts at three o'clock."
)


def generate_solfege_fixtures():
    """Generate one .mp3 per solfege syllable using TTS."""
    for syllable in SOLFEGE_SYLLABLES:
        out_path = FIXTURES_DIR / f"{syllable}.mp3"
        # Use a phrasing that emphasizes the syllable sound
        tts = gTTS(text=syllable, lang="en", slow=True)
        tts.save(str(out_path))
        print(f"  Created {out_path}")


def generate_chatter_fixture():
    """Generate a background chatter .mp3."""
    out_path = FIXTURES_DIR / "chatter.mp3"
    tts = gTTS(text=CHATTER_TEXT, lang="en")
    tts.save(str(out_path))
    print(f"  Created {out_path}")


def generate_mixed_fixture():
    """Generate a solfege syllable overlaid on background chatter.

    Uses soundfile + numpy for mixing (no ffmpeg dependency).
    The mixed output is saved as .wav since we can't encode mp3 without ffmpeg.
    """
    # Read source audio
    syllable_data, syllable_sr = sf.read(str(FIXTURES_DIR / "do.mp3"), dtype="float32")
    chatter_data, chatter_sr = sf.read(str(FIXTURES_DIR / "chatter.mp3"), dtype="float32")

    # Resample chatter to match syllable sample rate if needed
    if chatter_sr != syllable_sr:
        import torchaudio
        import torch
        chatter_tensor = torch.tensor(chatter_data).unsqueeze(0)
        chatter_tensor = torchaudio.functional.resample(chatter_tensor, chatter_sr, syllable_sr)
        chatter_data = chatter_tensor.squeeze(0).numpy()

    # Pad syllable with 1 second of silence at the start
    pad_samples = syllable_sr  # 1 second
    syllable_padded = np.concatenate([np.zeros(pad_samples, dtype=np.float32), syllable_data])

    # Make chatter at least as long as padded syllable
    target_len = len(syllable_padded) + syllable_sr  # extra 1s padding at end
    if len(chatter_data) < target_len:
        repeats = target_len // len(chatter_data) + 1
        chatter_data = np.tile(chatter_data, repeats)
    chatter_data = chatter_data[:target_len]

    # Reduce chatter volume (-10 dB) and overlay syllable
    chatter_reduced = chatter_data * (10 ** (-10 / 20))  # -10 dB

    # Overlay syllable onto chatter
    mixed = chatter_reduced.copy()
    end_idx = min(pad_samples + len(syllable_data), len(mixed))
    mixed[pad_samples:end_idx] += syllable_data[: end_idx - pad_samples]

    # Clip to prevent clipping
    mixed = np.clip(mixed, -1.0, 1.0)

    # Save as .wav (mp3 encoding requires ffmpeg)
    out_path = FIXTURES_DIR / "do_with_noise.wav"
    sf.write(str(out_path), mixed, syllable_sr)
    print(f"  Created {out_path}")


def main():
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    print("Generating solfege syllable fixtures...")
    generate_solfege_fixtures()
    print("Generating chatter fixture...")
    generate_chatter_fixture()
    print("Generating mixed (do + noise) fixture...")
    generate_mixed_fixture()
    print("Done! All fixtures in:", FIXTURES_DIR)


if __name__ == "__main__":
    main()
