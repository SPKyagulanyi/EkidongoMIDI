import { describe, expect, it } from 'vitest';
import { makeChord, repitchNote, type SourceChord } from '../src/index.ts';

const SRC: SourceChord = { root: 0, intervals: [0, 4, 7, 11] }; // C major 7
const chordRT = { ntr: 'root-transpose', ntt: 'chord' } as const;
const chordRF = { ntr: 'root-fixed', ntt: 'chord' } as const;
const bassRF = { ntr: 'root-fixed', ntt: 'bass' } as const;
const melody = { ntr: 'root-transpose', ntt: 'melody' } as const;
const CMAJ7 = [60, 64, 67, 71];

const map = (notes: number[], rules: Parameters<typeof repitchNote>[1], chord = makeChord(0, '')) =>
  notes.map((n) => repitchNote(n, rules, SRC, chord));

describe('repitchNote', () => {
  it('leaves the source chord unchanged when the target is the source chord', () => {
    expect(map(CMAJ7, chordRT, makeChord(0, 'maj7'))).toEqual(CMAJ7);
  });

  it('maps C major 7 onto Am7 (root-transpose moves down a minor 3rd)', () => {
    expect(map(CMAJ7, chordRT, makeChord(9, 'm7'))).toEqual([57, 60, 64, 67]); // A C E G
  });

  it('turns a missing 7th into the octave root', () => {
    expect(map(CMAJ7, chordRT, makeChord(0, ''))).toEqual([60, 64, 67, 72]);
  });

  it('maps the 3rd to the 4th for sus4 and to the minor 3rd for minor', () => {
    expect(repitchNote(64, chordRT, SRC, makeChord(0, 'sus4'))).toBe(65);
    expect(repitchNote(64, chordRT, SRC, makeChord(0, 'm'))).toBe(63);
  });

  it('keeps root-fixed voicings within 6 semitones of where they were written', () => {
    for (let root = 0; root < 12; root++) {
      for (const q of ['', 'm', '7', 'm7', 'dim', 'sus4']) {
        for (const n of CMAJ7) {
          const out = repitchNote(n, chordRF, SRC, makeChord(root, q));
          expect(Math.abs(out - n), `${n} -> ${root}${q}`).toBeLessThanOrEqual(6);
        }
      }
    }
  });

  it('moves a root-fixed bass to the nearest root and fifth', () => {
    const g = makeChord(7, '7');
    expect(repitchNote(36, bassRF, SRC, g)).toBe(31); // C2 -> G1 (down a 4th, not up a 5th)
    expect(repitchNote(43, bassRF, SRC, g)).toBe(38); // G2 (5th) -> D2
  });

  it('plays the slash bass note for the root of a slash chord', () => {
    expect(repitchNote(36, bassRF, SRC, makeChord(0, '', 4))).toBe(40); // C/E -> E
    expect(repitchNote(36, bassRF, SRC, makeChord(0, '', 7))).toBe(31); // C/G -> G below
  });

  it('bypasses drums', () => {
    expect(repitchNote(38, { ntr: 'root-transpose', ntt: 'bypass' }, SRC, makeChord(5, 'm7'))).toBe(38);
  });

  it('uses natural minor for melody over minor chords, dorian for dorian', () => {
    const am = makeChord(9, 'm');
    // A (9) over C = the 6th; over Am, melody gives the minor 6th (F), dorian the major 6th (F#)
    expect(repitchNote(69, melody, SRC, am)).toBe(65);
    expect(repitchNote(69, { ntr: 'root-transpose', ntt: 'dorian' }, SRC, am)).toBe(66);
  });

  it('keeps passing tones in melody mode', () => {
    expect(repitchNote(62, melody, SRC, makeChord(7, ''))).toBe(57); // D (2nd) over G -> A
  });

  it('folds into the note range', () => {
    expect(repitchNote(60, { ...chordRT, noteRange: { low: 64, high: 76 } }, SRC, makeChord(0, ''))).toBe(72);
  });
});
