/**
 * Fills in sections a style doesn't have, from the ones it does, so every panel button does something.
 * Real (recorded) styles should provide their own; derived sections are listed in the style's credits.
 *
 *   Main C   = Main A's drums with Main B's band (a lighter take on B)
 *   Main D   = Main A and Main B layered (the fullest groove)
 *   Fill C/D = Fill A / Fill B
 *   Break    = every part's beat-1 hits, then silence for the rest of the bar
 *   Intro 1  = 1 bar of Main A drums, then a fill bar
 *   Intro 2  = 1 bar of Main A, then a fill bar
 *   Intro 3  = 2 bars of Main A drums and bass, 1 bar of Main A, then a fill bar
 *   Ending 2 = a single final hit (short ending)
 *   Ending 3 = 1 bar of Main A, then the final hit
 */
import { barTicks, type NoteEvent, type Section, type SectionId, type Style } from './schema.ts';

type Phrases = Record<string, NoteEvent[]>;

// Plain JSON data, so a JSON round trip is a complete deep copy (no DOM/Node globals in the engine).
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function firstBar(sec: Section | undefined, bar: number): Phrases {
  const out: Phrases = {};
  if (!sec) return out;
  for (const [part, evs] of Object.entries(sec.phrases)) {
    out[part] = evs.filter((e) => e.t < bar).map((e) => ({ ...e, d: Math.min(e.d, bar - e.t) }));
  }
  return out;
}

function shift(ph: Phrases, by: number): Phrases {
  const out: Phrases = {};
  for (const [part, evs] of Object.entries(ph)) out[part] = evs.map((e) => ({ ...e, t: e.t + by }));
  return out;
}

/** Union of phrases, dropping exact duplicates (same part, start and note). */
function merge(...all: Phrases[]): Phrases {
  const out: Phrases = {};
  for (const ph of all) {
    for (const [part, evs] of Object.entries(ph)) {
      const list = (out[part] ??= []);
      for (const e of evs) if (!list.some((x) => x.t === e.t && x.n === e.n)) list.push({ ...e });
    }
  }
  for (const evs of Object.values(out)) evs.sort((a, b) => a.t - b.t || a.n - b.n);
  return out;
}

function only(ph: Phrases, keep: (part: string) => boolean): Phrases {
  const out: Phrases = {};
  for (const [part, evs] of Object.entries(ph)) if (keep(part)) out[part] = evs;
  return out;
}

/** Each part's notes that start on beat 1, shortened to at most a quarter note. */
function hits(ph: Phrases, quarter: number): Phrases {
  const out: Phrases = {};
  for (const [part, evs] of Object.entries(ph)) {
    const first = evs.filter((e) => e.t === 0).map((e) => ({ ...e, d: Math.min(e.d, quarter) }));
    if (first.length) out[part] = first;
  }
  return out;
}

export function deriveMissingSections(style: Style): Style {
  const s: Style = clone(style);
  const sec = s.sections;
  const bar = barTicks(s);
  const quarter = s.ppq;
  const roleOf = new Map(s.parts.map((p) => [p.id, p.role]));
  const isDrums = (p: string) => roleOf.get(p) === 'drums';
  const isRhythm = (p: string) => isDrums(p) || roleOf.get(p) === 'bass';
  const derived: SectionId[] = [];
  const add = (id: SectionId, value: Section) => {
    if (sec[id]) return;
    sec[id] = value;
    derived.push(id);
  };

  const A = sec.mainA;
  if (!A) return s;
  const B = sec.mainB ?? A;
  const a1 = firstBar(A, bar);
  const sameLength = A.bars === B.bars;

  add('mainC', sameLength
    ? { bars: A.bars, phrases: merge(only(A.phrases, isDrums), only(B.phrases, (p) => !isDrums(p))) }
    : { bars: 1, phrases: merge(only(a1, isDrums), only(firstBar(B, bar), (p) => !isDrums(p))) });
  add('mainD', sameLength
    ? { bars: A.bars, phrases: merge(B.phrases, A.phrases) }
    : { bars: 1, phrases: merge(firstBar(B, bar), a1) });

  const fillA = sec.fillA ?? sec.fillB;
  const fillB = sec.fillB ?? sec.fillA;
  if (fillA) add('fillC', clone(fillA));
  if (fillB) add('fillD', clone(fillB));
  const fillBar = fillA ? firstBar(fillA, bar) : a1;

  const finalHit = hits(a1, quarter);
  add('break', { bars: 1, phrases: finalHit });
  add('intro1', { bars: 2, phrases: merge(only(a1, isDrums), shift(fillBar, bar)) });
  add('intro2', { bars: 2, phrases: merge(a1, shift(fillBar, bar)) });
  add('intro3', {
    bars: 4,
    phrases: merge(only(a1, isRhythm), shift(only(a1, isRhythm), bar), shift(a1, 2 * bar), shift(fillBar, 3 * bar)),
  });
  add('ending2', { bars: 1, phrases: finalHit });
  add('ending3', { bars: 2, phrases: merge(a1, shift(finalHit, bar)) });
  if (!sec.ending1) add('ending1', { bars: 2, phrases: merge(a1, shift(finalHit, bar)) });

  if (derived.length) {
    s.credits = [...s.credits, { name: 'EkidongoMIDI (auto-derived)', role: `sections: ${derived.join(', ')}` }];
  }
  return s;
}
