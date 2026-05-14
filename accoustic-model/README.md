# Acoustic Model — CLAP Zero-Shot Classification

## Model Choice

This project uses **Microsoft CLAP** (Contrastive Language-Audio Pretraining) via the [`msclap`](https://pypi.org/project/msclap/) Python package (v2023 model variant).

CLAP enables **zero-shot audio classification** — it classifies audio using natural language text prompts with no task-specific fine-tuning required.

## How It Works

1. **Text prompts** describe what we're listening for (e.g., `"someone singing the solfege syllable do"`)
2. CLAP encodes both audio and text into a shared embedding space
3. Cosine similarity between audio and text embeddings yields classification scores
4. Softmax over scores produces per-class probabilities

### Why Zero-Shot?

- **No training data needed** — we skip collecting/labeling solfege audio datasets
- **No fine-tuning** — prompt engineering replaces model training
- **Flexible** — adding new sound classes means adding text prompts, not retraining

## Prompt Strategy

See [`prompt_config.py`](prompt_config.py) for the full prompt definitions.

**Solfege prompts (7):** One per standard syllable — do, re, mi, fa, sol, la, ti  
**Negative-class prompts (3):** background noise, people talking, silence — to reject non-solfege audio

## Technical Constraints

| Parameter | Value | Notes |
|-----------|-------|-------|
| Model version | 2023 | Best zero-shot accuracy (93.9% on ESC50) |
| Sample rate | 44,100 Hz | CLAP's native rate |
| Inference window | 7 seconds | Fixed by the model architecture |
| Mel bins | 64 | |
| Frequency range | 50–8,000 Hz | |

Audio shorter than 7 seconds is padded (repeated); longer audio is trimmed.

## Model Weights

Weights are **auto-downloaded from HuggingFace** (`microsoft/msclap`) on first use. No manual setup needed.

## Performance Notes

- **CPU:** ~2–5 seconds per inference window. Functional but may not keep up with 1-second hop for real-time use.
- **GPU (CUDA):** Recommended for production real-time detection. Inference drops to milliseconds.
- Text embeddings are computed **once at startup** (expensive); only audio embeddings run per-inference (cheaper).

## References

- [Microsoft CLAP GitHub](https://github.com/microsoft/CLAP)
- [msclap on PyPI](https://pypi.org/project/msclap/)
- [Model weights on HuggingFace](https://huggingface.co/microsoft/msclap)
