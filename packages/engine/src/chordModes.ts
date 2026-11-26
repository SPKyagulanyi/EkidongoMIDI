/**
 * Chord fingering modes (as on arranger keyboards):
 *
 *  - fingered: play the full chord (detectChord).
 *  - single:   one key = major on that key; add keys to its LEFT (below) for other types:
 *              a black key -> minor, a white key -> 7th, both -> minor 7th. The highest key is the root.
 *  - multi:    single-finger and fingered both work without switching: one or two keys, or keys that
 *              don't make a full chord, are read as single finger; a full chord is read as fingered.
 */
import { detectChord, makeChord, type Chord } from './chords.ts';
import { pc } from './music.ts';

export type ChordMode = 'fingered' | 'single' | 'multi';
export const CHORD_MODES: readonly ChordMode[] = ['fingered', 'single', 'multi'];

const isBlack = (n: number) => [1, 3, 6, 8, 10].includes(pc(n));

export function detectSingleFinger(notes: Iterable<number>): Chord | null {
  const list = [...notes].sort((a, b) => a - b);
  if (list.length === 0) return null;
  const root = list[list.length - 1]!;
  const below = list.slice(0, -1).filter((n) => root - n <= 12);
  const black = below.some(isBlack);
  const white = below.some((n) => !isBlack(n));
  const quality = black && white ? 'm7' : black ? 'm' : white ? '7' : '';
  return makeChord(root, quality);
}

/** True when every played pitch class belongs to the chord and the chord has at least 3 notes. */
function isFullChord(notes: number[], c: Chord): boolean {
  const played = new Set(notes.map(pc));
  const tones = new Set(c.intervals.map((i) => pc(c.root + i)));
  return played.size >= 3 && [...played].every((p) => tones.has(p));
}

export function detectChordWithMode(notes: Iterable<number>, mode: ChordMode): Chord | null {
  const list = [...notes];
  if (list.length === 0) return null;
  if (mode === 'fingered') return detectChord(list);
  if (mode === 'single') return detectSingleFinger(list);
  const fingered = detectChord(list);
  if (fingered && isFullChord(list, fingered)) return fingered;
  const span = Math.max(...list) - Math.min(...list);
  if (list.length <= 3 && span <= 12) return detectSingleFinger(list);
  return fingered;
}
