# Solfege Detector

A Python library that analyzes an audio stream in real-time and detects when a solfege syllable is spoken/ sung.

## Install Dependencies

The below command will install dependencies listed in `pyproject.toml`

```bash
uv sync
```

## Run the Server

```bash
uv run python -m solfege_detector.main
# Server starts on ws://localhost:8000/ws
```

CLI options:

```
--host              Bind host (default: 0.0.0.0)
--port              Bind port (default: 8000)
--confidence-threshold  Default confidence threshold (default: 0.5)
--log-level         Log level (default: info, or LOG_LEVEL env var)
```

## Run Tests

```bash
uv run pytest solfege_detector/tests/ -v
```

## Install CLI Globally

```bash
uv tool install .
solfege-detector
```

## Usage as a Library

```python
from solfege_detector.detector import SolfegeDetector

detector = SolfegeDetector(use_cuda=False)

# Basic detection (onset segmentation enabled by default)
detections = detector.detect(audio_array, sample_rate=44100, threshold=0.5)
for d in detections:
    print(f"{d.syllable}: {d.confidence:.4f}")

# Classify every onset segment independently
detections = detector.detect_multi(audio_array, sample_rate=44100, threshold=0.5)
for d in detections:
    print(f"{d.syllable}: {d.confidence:.4f} @ {d.offset_seconds:.3f}s")

# Disable onset segmentation (classify raw window)
detections = detector.detect(audio_array, threshold=0.5, use_onset_segmentation=False)
```

### Onset Segmenter

The `onset_segmenter` module (librosa-based) splits an audio array into per-syllable regions:

```python
from solfege_detector.onset_segmenter import segment_onsets

segments = segment_onsets(audio, sr=44100, onset_delta=0.07, min_gap_seconds=0.2)
# Returns [(start_sample, end_sample), ...]
```
