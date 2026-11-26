/** Basic pitch helpers. MIDI note 60 = C4 (middle C). */

export const PITCH_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/** Pitch class 0-11 of a MIDI note (or any integer, including negatives). */
export function pc(note: number): number {
  return ((note % 12) + 12) % 12;
}

export function pitchName(note: number): string {
  return PITCH_NAMES[pc(note)] ?? '?';
}

export function noteName(note: number): string {
  return `${pitchName(note)}${Math.floor(note / 12) - 1}`;
}
