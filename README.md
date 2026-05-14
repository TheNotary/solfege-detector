# Solfege Detector

Real-time solfege syllable detection using Microsoft CLAP zero-shot audio classification.

Detects when standard solfege syllables (**do, re, mi, fa, sol, la, ti**) are spoken or sung in an audio stream, and reports the detected syllable with its confidence level.

## Architecture

```
accoustic-model/    CLAP prompt configuration and validation scripts
lib-py/             Python library: detector engine, FastAPI WebSocket server
test-client/        React UI: rhythm game with solfege note singing
recorded_notes/     Captured .wav + .metadata training data (gitignored)
```

### How It Works

1. **Client** captures microphone audio as PCM (16-bit int, mono, 44100 Hz) and streams it over WebSocket
2. **Server** buffers audio in a 1.5-second sliding window with 0.25-second hop
3. **CLAP model** (msclap v2023) runs zero-shot classification asynchronously (via `asyncio.to_thread` with frame-skipping) against solfege prompts
4. **Detection events** (syllable + confidence) are pushed back to the client in real-time

### Game Mode

The test-client presents a rhythm-game interface:

- **Sliding notes** ride an invisible staff from right to left, following an ascending solfege scale (do→re→mi→fa→sol→la→ti)
- **Crosshair** marks when to sing — notes in the zone light up when the player makes sound
- **Confetti burst** fires when the microphone detects any sound while a note is in the crosshair (client-side volume detection for instant feedback)
- **Speed slider** controls note spawn rate (10–120 BPM)
- **Backend recording** captures ~3 seconds of audio around each note event, saving `.wav` + `.metadata` files to `recorded_notes/` for acoustic model training

## Quick Start

### Server (Python)

```bash
cd lib-py
uv sync
uv run python -m solfege_detector.main
# Server starts on ws://localhost:8000/ws
```

### Client (React)

```bash
cd test-client
pnpm install
pnpm dev
# Opens http://localhost:5173
```

### Prompt Validation Tool

```bash
cd lib-py
uv run python ../accoustic-model/test_prompts.py <audio_file.wav>
```

## Testing

```bash
cd lib-py

# Smoke tests (fast, no model loading)
uv run pytest solfege_detector/tests/test_app.py -v

# Integration tests (loads CLAP model, ~16s)
uv run pytest solfege_detector/tests/test_integration.py -v

# All tests
uv run pytest solfege_detector/tests/ -v
```

### Generating Test Fixtures

```bash
cd lib-py
uv run python solfege_detector/tests/generate_fixtures.py
```

Generates TTS-spoken syllable .mp3 files and a mixed noise .wav fixture in `solfege_detector/tests/fixtures/`.

## Build

```bash
# Python
cd lib-py && uv sync

# TypeScript
cd test-client && pnpm install && npx tsc --noEmit
```

## Technical Details

- **Model**: Microsoft CLAP v2023 (zero-shot, no fine-tuning)
- **Audio**: 1.5-second window, 0.25-second hop, 44100 Hz, 64 mel bins
- **Prompts**: "someone singing the solfege syllable {X}" + negative classes (noise, talking, silence)
- **Environment**: Set `LOG_LEVEL` env var to control verbosity (default: `info`)
- **Platform**: Python 3.12, CPU inference (torch CPU), aarch64/x86_64
- **Dependencies**: numba==0.60/llvmlite==0.43 pinned for aarch64 LLVM compatibility
