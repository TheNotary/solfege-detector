"""
Prompt configuration for CLAP zero-shot solfege syllable classification.

This module defines the text prompts used with Microsoft CLAP (msclap v2023)
for zero-shot audio classification. Prompt engineering replaces traditional
model training — these prompts are the "training" step.
"""

# Standard solfege syllables
SOLFEGE_SYLLABLES = ["do", "re", "mi", "fa", "sol", "la", "ti"]

# Template for generating solfege classification prompts
SOLFEGE_PROMPT_TEMPLATE = "someone singing the solfege syllable {syllable}"

# Generated prompts for each solfege syllable
SOLFEGE_PROMPTS = [
    SOLFEGE_PROMPT_TEMPLATE.format(syllable=s) for s in SOLFEGE_SYLLABLES
]

# Negative-class prompts to reject non-solfege audio
NEGATIVE_PROMPTS = [
    "background noise",
    "people talking",
    "silence",
]

# Combined prompt list: solfege first, then negatives
ALL_PROMPTS = SOLFEGE_PROMPTS + NEGATIVE_PROMPTS

# Number of solfege classes (used to split results from ALL_PROMPTS)
NUM_SOLFEGE_CLASSES = len(SOLFEGE_SYLLABLES)
