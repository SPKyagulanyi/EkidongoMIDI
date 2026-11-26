/**
 * Chord recognition for the left hand ("Fingered" mode).
 *
 * Rules, in order:
 *  1. One key = major chord on that key.
 *  2. Exact match of the played pitch classes against the templates below.
 *     When several roots fit the same notes (C6 = Am7/C), the lowest note wins as root;
 *     otherwise the earlier template wins.
 *  3. Otherwise the largest template fully contained in the notes (extra notes ignored).
 *  4. Otherwise a major chord on the lowest note.
 */
import { pc, pitchName } from './music.ts';

export interface Chord {
  /** Root pitch class 0-11 (0 = C). */
  readonly root: number;
  /** Pitch class of the lowest played note. */
  readonly bass: number;
  /** Chord quality suffix, e.g. "", "m", "7", "maj7", "m7b5". */
  readonly quality: string;
  /** Full intervals of the quality from the root, used for voicing. */
  readonly intervals: readonly number[];
  /** Display name, e.g. "Am7" or "C/E". */
  readonly name: string;
}

interface Template {
  readonly quality: string;
  readonly intervals: readonly number[];
}

/** Earlier entries win ties. Shells (2-3 note partial chords) come last. */
const TEMPLATES: readonly Template[] = (
  [
    ['', [0, 4, 7]],
    ['m', [0, 3, 7]],
    ['7', [0, 4, 7, 10]],
    ['maj7', [0, 4, 7, 11]],
    ['m7', [0, 3, 7, 10]],
    ['6', [0, 4, 7, 9]],
    ['m6', [0, 3, 7, 9]],
    ['dim', [0, 3, 6]],
    ['dim7', [0, 3, 6, 9]],
    ['m7b5', [0, 3, 6, 10]],
    ['aug', [0, 4, 8]],
    ['sus4', [0, 5, 7]],
    ['sus2', [0, 2, 7]],
    ['add9', [0, 2, 4, 7]],
    ['7sus4', [0, 5, 7, 10]],
    ['9', [0, 2, 4, 7, 10]],
    ['m9', [0, 2, 3, 7, 10]],
    ['maj9', [0, 2, 4, 7, 11]],
    ['madd9', [0, 2, 3, 7]],
    ['mMaj7', [0, 3, 7, 11]],
    ['7', [0, 4, 10]],
    ['maj7', [0, 4, 11]],
    ['m7', [0, 3, 10]],
    ['', [0, 4]],
    ['m', [0, 3]],
    ['5', [0, 7]],
  ] as const
).map(([quality, intervals]) => ({ quality, intervals }));

/** Full voicing intervals for each quality (the first template defining it). */
export const CHORD_QUALITIES: ReadonlyMap<string, readonly number[]> = (() => {
  const m = new Map<string, readonly number[]>();
  for (const t of TEMPLATES) if (!m.has(t.quality)) m.set(t.quality, t.intervals);
  return m;
})();

function relativeSet(pcs: ReadonlySet<number>, root: number): Set<number> {
  return new Set([...pcs].map((p) => pc(p - root)));
}

function sameSet(a: ReadonlySet<number>, b: readonly number[]): boolean {
  return a.size === new Set(b).size && b.every((x) => a.has(x));
}

function lexLess(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return a.length < b.length;
}

export function makeChord(root: number, quality: string, bass: number = root): Chord {
  const intervals = CHORD_QUALITIES.get(quality);
  if (!intervals) throw new Error(`Unknown chord quality "${quality}"`);
  const r = pc(root);
  const b = pc(bass);
  const name = pitchName(r) + quality + (b !== r ? `/${pitchName(b)}` : '');
  return { root: r, bass: b, quality, intervals, name };
}

/** Recognise a chord from currently held MIDI notes. Returns null when no notes are held. */
export function detectChord(notes: Iterable<number>): Chord | null {
  const list = [...notes];
  if (list.length === 0) return null;
  const bass = pc(Math.min(...list));
  const pcs = new Set(list.map(pc));
  if (pcs.size === 1) return makeChord(bass, '', bass);

  let best: { key: number[]; root: number; quality: string } | null = null;
  for (const root of pcs) {
    const rel = relativeSet(pcs, root);
    TEMPLATES.forEach((t, i) => {
      if (!sameSet(rel, t.intervals)) return;
      const key = [root === bass ? 0 : 1, i];
      if (best === null || lexLess(key, best.key)) best = { key, root, quality: t.quality };
    });
  }
  if (best === null) {
    for (const root of pcs) {
      const rel = relativeSet(pcs, root);
      TEMPLATES.forEach((t, i) => {
        if (!t.intervals.every((x) => rel.has(x))) return;
        const key = [-t.intervals.length, root === bass ? 0 : 1, i];
        if (best === null || lexLess(key, best.key)) best = { key, root, quality: t.quality };
      });
    }
  }
  const found = best as { root: number; quality: string } | null;
  return found ? makeChord(found.root, found.quality, bass) : makeChord(bass, '', bass);
}
