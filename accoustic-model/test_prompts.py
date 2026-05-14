#!/usr/bin/env python3
"""Standalone CLAP zero-shot classification test script.

Usage:
    cd lib-py && uv run python ../accoustic-model/test_prompts.py <audio_file> [audio_file ...]

Loads the CLAP model with the prompts from prompt_config.py and prints
per-class softmax probabilities for each input audio file.  Useful for
iterating on prompt phrasing.

Pass --prompts to override the default prompts with custom ones:
    uv run python ../accoustic-model/test_prompts.py audio.wav \\
        --prompts "a person singing do" "background noise" "silence"
"""

import argparse
import sys
import os

# Ensure prompt_config is importable
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import torch
import torch.nn.functional as F
from msclap import CLAP
from prompt_config import ALL_PROMPTS


def classify(model, audio_paths: list[str], prompts: list[str]) -> None:
    text_embeddings = model.get_text_embeddings(prompts)

    for path in audio_paths:
        if not os.path.isfile(path):
            print(f"\n[!] File not found: {path}", file=sys.stderr)
            continue

        print(f"\n{'='*60}")
        print(f"File: {path}")
        print(f"{'='*60}")

        audio_embeddings = model.get_audio_embeddings([path], resample=True)
        similarity = model.compute_similarity(audio_embeddings, text_embeddings)
        probs = F.softmax(similarity, dim=1)[0]

        # Sort by probability descending
        ranked = sorted(
            zip(prompts, probs.tolist()), key=lambda x: x[1], reverse=True
        )

        for prompt, prob in ranked:
            bar = "█" * int(prob * 40)
            print(f"  {prob:6.2%}  {bar:<40s}  {prompt}")


def main():
    parser = argparse.ArgumentParser(
        description="Test CLAP zero-shot classification on audio files."
    )
    parser.add_argument(
        "audio_files", nargs="+", help="Path(s) to audio file(s) to classify."
    )
    parser.add_argument(
        "--prompts",
        nargs="+",
        default=None,
        help="Custom prompts (overrides prompt_config.py defaults).",
    )
    parser.add_argument(
        "--cuda", action="store_true", help="Use CUDA if available."
    )
    args = parser.parse_args()

    prompts = args.prompts if args.prompts else ALL_PROMPTS
    print(f"Loading CLAP model (v2023, cuda={args.cuda})...")
    model = CLAP(version="2023", use_cuda=args.cuda)

    print(f"Prompts ({len(prompts)}):")
    for i, p in enumerate(prompts):
        print(f"  [{i}] {p}")

    classify(model, args.audio_files, prompts)


if __name__ == "__main__":
    main()
