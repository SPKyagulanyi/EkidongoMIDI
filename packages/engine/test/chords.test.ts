import { describe, expect, it } from 'vitest';
import { CHORD_QUALITIES, detectChord, pc } from '../src/index.ts';

const FULL_QUALITIES = [...CHORD_QUALITIES.entries()].filter(([q]) => q !== '5');
const pcsOf = (notes: Iterable<number>) => [...new Set([...notes].map(pc))].sort((a, b) => a - b);
const chordPcs = (root: number, intervals: readonly number[]) => pcsOf(intervals.map((i) => root + i));

/** All inversions of a close voicing starting at `base`. */
function inversions(base: number, intervals: readonly number[]): number[][] {
  const v = intervals.map((i) => base + i);
  return v.map((_, k) => [...v.slice(k), ...v.slice(0, k).map((n) => n + 12)]);
}

describe('detectChord', () => {
  it('returns null with no notes', () => {
    expect(detectChord([])).toBeNull();
  });

  it('treats one key as a major chord', () => {
    expect(detectChord([50])?.name).toBe('D');
  });

  it('recognises every quality in root position on all 12 roots', () => {
    let cases = 0;
    for (const [quality, intervals] of FULL_QUALITIES) {
      for (let root = 0; root < 12; root++) {
        const c = detectChord(intervals.map((i) => 48 + root + i));
        expect(c, `${quality} on ${root}`).not.toBeNull();
        expect([c?.root, c?.quality], `${quality} on ${root}`).toEqual([root, quality]);
        cases++;
      }
    }
    expect(cases).toBeGreaterThanOrEqual(240);
  });

  it('keeps the same notes and names the bass for every inversion (500+ voicings)', () => {
    let cases = 0;
    for (const [quality, intervals] of FULL_QUALITIES) {
      for (let root = 0; root < 12; root++) {
        for (const voicing of inversions(48 + root, intervals)) {
          const c = detectChord(voicing);
          const label = `${quality} root ${root} voicing ${voicing.join(',')}`;
          expect(c, label).not.toBeNull();
          if (!c) continue;
          // Same pitch classes as played (no notes invented or dropped)
          expect(chordPcs(c.root, c.intervals), label).toEqual(pcsOf(voicing));
          // Same root => same quality (ambiguous sets like C6 = Am7 may pick the other root)
          if (c.root === root) expect(c.quality, label).toBe(quality);
          // Slash name whenever the bass is not the root
          expect(c.name.includes('/'), label).toBe(c.bass !== c.root);
          cases++;
        }
      }
    }
    expect(cases).toBeGreaterThanOrEqual(500);
  });

  it.each([
    [[48, 52, 55], 'C'],
    [[45, 48, 52], 'Am'],
    [[43, 47, 50, 53], 'G7'],
    [[48, 52, 55, 57], 'C6'],
    [[45, 48, 52, 55], 'Am7'],
    [[50, 53, 57, 60], 'Dm7'],
    [[48, 53, 55], 'Csus4'],
    [[47, 50, 53], 'Bdim'],
    [[52, 55, 60], 'C/E'],
    [[43, 48, 52], 'C/G'],
    [[48, 55], 'C5'],
    [[48, 51], 'Cm'],
    [[48, 52, 55, 58, 62], 'C9'],
  ])('%j -> %s', (notes, name) => {
    expect(detectChord(notes)?.name).toBe(name);
  });

  it('ignores an extra note by matching the largest contained chord', () => {
    // C major triad plus F# (no template matches all four)
    const c = detectChord([48, 52, 54, 55]);
    expect(c?.root).toBe(0);
    expect(c?.quality).toBe('');
  });
});
