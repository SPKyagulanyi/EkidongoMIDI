/**
 * Re-pitching: moves a note written over the style's source chord onto the chord the player holds.
 *
 * NTT (how notes map onto the new chord):
 *  - chord / guitar: chord tones map to the new chord's tones (3rd -> its 3rd, 7th -> its 7th, or the
 *    octave root when it has none); tensions map to the nearest sensible tone.
 *  - bass: like chord, but the root follows the bass note of slash chords (C/E plays E).
 *  - melody / dorian / melodic-minor: a scale mapping that keeps passing tones, fixing the 3rd, 5th, 6th
 *    and 7th to the chord's quality (minor chords: natural minor for melody, dorian 6th for dorian,
 *    dorian 6th and major 7th for melodic-minor).
 *  - bypass: unchanged (drums).
 *
 * NTR (how the phrase follows the root):
 *  - root-transpose: the whole phrase moves by the root interval, folded to -5..+6 semitones.
 *  - root-fixed / guitar: each note lands in the octave closest to where it was written, so voicings
 *    stay in the same register and move smoothly.
 */
import type { Chord } from '../chords.ts';
import { pc } from '../music.ts';
import type { Part } from '../style/schema.ts';

export interface SourceChord {
  root: number;
  intervals: readonly number[];
}

type Rules = Pick<Part, 'ntr' | 'ntt' | 'noteRange'>;

function pick(iv: readonly number[], options: readonly number[], fallback: number): number {
  for (const o of options) if (iv.includes(o)) return o;
  return fallback;
}

function thirdOf(iv: readonly number[]): number {
  return pick(iv, [4, 3], pick(iv, [5, 2], 0));
}
function fifthOf(iv: readonly number[]): number {
  return pick(iv, [7, 6, 8], 7);
}

/** Chord-tone mapping. May return 12 (octave root) when the target has no 7th. */
export function mapChordInterval(srcInt: number, iv: readonly number[]): number {
  switch (srcInt) {
    case 0: return 0;
    case 1: return pick(iv, [1], 0);
    case 2: return 2;
    case 3:
    case 4: return thirdOf(iv);
    case 5: return pick(iv, [5], thirdOf(iv));
    case 6:
    case 7:
    case 8: return fifthOf(iv);
    case 9: return pick(iv, [9], fifthOf(iv));
    case 10:
    case 11: return pick(iv, [10, 11, 9], 12);
    default: return srcInt;
  }
}

function mapMelodyInterval(srcInt: number, iv: readonly number[], ntt: Rules['ntt']): number {
  const minor = iv.includes(3) && !iv.includes(4);
  switch (srcInt) {
    case 3:
    case 4: {
      const t = thirdOf(iv);
      return t === 0 ? srcInt : t;
    }
    case 6:
    case 7:
    case 8: return fifthOf(iv);
    case 9:
      if (iv.includes(9)) return 9;
      return minor && ntt === 'melody' ? 8 : 9;
    case 10:
    case 11:
      if (iv.includes(10) || iv.includes(11)) return pick(iv, [10, 11], 10);
      if (minor) return ntt === 'melodic-minor' ? 11 : 10;
      return srcInt;
    default: return srcInt;
  }
}

/** Re-pitch one source note onto `target`. Returns a MIDI note 0-127. */
export function repitchNote(note: number, rules: Rules, src: SourceChord, target: Chord): number {
  if (rules.ntt === 'bypass') return note;
  const srcInt = pc(note - src.root);
  const base = note - srcInt;
  let delta = pc(target.root - src.root);
  if (delta > 6) delta -= 12;

  let m: number;
  if (rules.ntt === 'chord' || rules.ntr === 'guitar') m = mapChordInterval(srcInt, target.intervals);
  else if (rules.ntt === 'bass') {
    m = mapChordInterval(srcInt, target.intervals);
    if (srcInt === 0 && target.bass !== target.root) {
      m = pc(target.bass - target.root);
      if (m > 6) m -= 12; // slash bass goes down, not up
    }
  } else m = mapMelodyInterval(srcInt, target.intervals, rules.ntt);

  let out = base + delta + m;
  if (rules.ntr === 'root-fixed' || rules.ntr === 'guitar') {
    while (out - note > 6) out -= 12;
    while (note - out > 6) out += 12;
  }
  if (rules.noteRange) {
    const { low, high } = rules.noteRange;
    while (out < low && out + 12 <= high) out += 12;
    while (out > high && out - 12 >= low) out -= 12;
  }
  return Math.max(0, Math.min(127, out));
}
