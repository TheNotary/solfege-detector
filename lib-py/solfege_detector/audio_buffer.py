"""Sliding window ring buffer for streaming PCM audio."""

from typing import Optional

import numpy as np


class AudioBuffer:
    """Accumulates PCM audio and yields fixed-length windows at a configurable hop interval.

    Accepts raw PCM bytes (16-bit signed int, mono) and maintains a circular
    buffer.  Each time enough new audio has arrived (>= hop_size_seconds),
    ``append`` returns a float32 numpy array of ``window_size_seconds`` length.
    """

    def __init__(
        self,
        window_size_seconds: float = 7.0,
        hop_size_seconds: float = 1.0,
        sample_rate: int = 44_100,
    ) -> None:
        self.sample_rate = sample_rate
        self.window_samples = int(window_size_seconds * sample_rate)
        self.hop_samples = int(hop_size_seconds * sample_rate)

        # Pre-allocate the ring buffer (float32, normalised to [-1, 1])
        self._buffer = np.zeros(self.window_samples, dtype=np.float32)
        self._fill = 0  # how many valid samples are in the buffer
        self._new_samples = 0  # samples received since last yield

    def append(self, chunk: bytes) -> Optional[np.ndarray]:
        """Append raw PCM-16 bytes and return a window when the hop threshold is met.

        Parameters
        ----------
        chunk:
            Raw PCM bytes — 16-bit signed integer, mono, at ``self.sample_rate``.

        Returns
        -------
        A float32 numpy array of length ``window_samples`` normalised to [-1, 1],
        or ``None`` if not enough new audio has accumulated yet.
        """
        # Convert PCM int16 bytes → float32 in [-1, 1]
        samples = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0
        n = len(samples)
        if n == 0:
            return None

        # Append to the ring buffer
        if self._fill + n <= self.window_samples:
            # Still filling the initial window
            self._buffer[self._fill : self._fill + n] = samples
            self._fill += n
        else:
            # Shift left and append at the end
            shift = self._fill + n - self.window_samples
            self._buffer[: self.window_samples - shift] = self._buffer[shift : self._fill]
            write_start = max(0, self.window_samples - n)
            self._buffer[write_start:self.window_samples] = samples[-(self.window_samples - write_start):]
            self._fill = self.window_samples

        self._new_samples += n

        # Only yield when we have a full window AND enough new audio since last yield
        if self._fill >= self.window_samples and self._new_samples >= self.hop_samples:
            self._new_samples = 0
            return self._buffer.copy()

        return None

    def reset(self) -> None:
        """Clear the buffer."""
        self._buffer[:] = 0.0
        self._fill = 0
        self._new_samples = 0
