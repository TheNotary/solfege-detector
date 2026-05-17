import type { Syllable } from "../hooks/useGameEngine";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

/** Map flat names to their sharp equivalents for normalization. */
const FLAT_TO_SHARP: Record<string, string> = {
  Cb: "B", Db: "C#", Eb: "D#", Fb: "E", Gb: "F#", Ab: "G#", Bb: "A#",
};

/**
 * Parse a note name like "C3", "D#4", "Bb2", "f#5" into a frequency and
 * normalized display name.  Returns null for invalid input.
 */
export function parseNoteName(
  input: string,
): { frequency: number; name: string } | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^([A-Ga-g])(#|b)?(\d)$/);
  if (!match) return null;

  let letter = match[1].toUpperCase();
  const accidental = match[2] ?? "";
  const octave = parseInt(match[3], 10);

  // Normalize flats to sharps
  if (accidental === "b") {
    const sharpName = FLAT_TO_SHARP[letter + "b"];
    if (!sharpName) return null;
    letter = sharpName.replace("#", "");
    // If the flat resolved to a note in the previous octave (Cb → B),
    // adjust the octave.
    if (letter + "b" === "Cb") {
      // Cb4 = B3
      return parseNoteName(`${sharpName}${octave - 1}`);
    }
  }

  const noteName = accidental === "#" ? `${letter}#` : letter;
  const noteIndex = NOTE_NAMES.indexOf(noteName as (typeof NOTE_NAMES)[number]);
  if (noteIndex === -1) return null;

  // MIDI note number: C4 = 60
  const midi = (octave + 1) * 12 + noteIndex;
  const frequency = 440 * Math.pow(2, (midi - 69) / 12);

  return { frequency, name: `${noteName}${octave}` };
}

/**
 * Fold any frequency into the octave starting at rootHz: [rootHz, rootHz × 2).
 * C3, C4, C5 all map to the same canonical frequency in the root octave.
 *
 * A tolerance of 1 semitone below each octave boundary prevents a pitch sung
 * slightly flat from wrapping all the way up to Ti.  Anything within that
 * tolerance snaps down to rootHz (Do).
 */
export function foldToOctave(hz: number, rootHz: number): number {
  if (hz <= 0 || rootHz <= 0) return rootHz;
  const octavesFromRoot = Math.log2(hz / rootHz);
  const fractional = octavesFromRoot - Math.floor(octavesFromRoot);
  // 1 semitone below the next octave = 11/12 of an octave
  if (fractional >= 11 / 12) return rootHz;
  return rootHz * Math.pow(2, fractional);
}

/** Major-scale semitone intervals: do=0, re=2, mi=4, fa=5, sol=7, la=9, ti=11 */
const MAJOR_INTERVALS: readonly number[] = [0, 2, 4, 5, 7, 9, 11];
const SOLFEGE_SYLLABLES: readonly Syllable[] = [
  "do", "re", "mi", "fa", "sol", "la", "ti",
];

/**
 * Compute target frequencies for each solfege syllable given a root frequency.
 * Uses equal-temperament major-scale intervals.
 */
export function computeScaleFrequencies(
  rootHz: number,
): Record<Syllable, number> {
  const result = {} as Record<Syllable, number>;
  for (let i = 0; i < SOLFEGE_SYLLABLES.length; i++) {
    result[SOLFEGE_SYLLABLES[i]] = rootHz * Math.pow(2, MAJOR_INTERVALS[i] / 12);
  }
  return result;
}
