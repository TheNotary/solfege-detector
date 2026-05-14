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
--log-level         Log level (default: info)
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
detections = detector.detect(audio_array, sample_rate=44100, threshold=0.5)
for d in detections:
    print(f"{d.syllable}: {d.confidence:.4f}")
```
