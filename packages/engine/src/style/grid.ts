/**
 * Grid compiler: turns the prototype's one-character-per-step patterns into v1 phrase styles.
 *
 * Grids stay useful as a quick authoring shorthand; real styles will be recorded as phrases.
 * Phrases are written over the source chord C major 7, as the format requires.
 */
import { makeChord } from '../chords.ts';
import { PPQ, STYLE_FORMAT, STYLE_SCHEMA_VERSION, type NoteEvent, type Part, type Section, type SectionId, type Style } from './schema.ts';

export const GRID_DRUMS: Readonly<Record<string, number>> = {
  kick: 36, kick2: 35, rim: 37, snare: 38, clap: 39, snare2: 40, chh: 42, phh: 44, ohh: 46,
  tomL: 45, tomM: 47, tomH: 50, crash: 49, ride: 51, ridebell: 53, tamb: 54, cowbell: 56,
  bongoH: 60, bongoL: 61, congaMute: 62, congaHi: 63, congaLo: 64, timbaleH: 65, timbaleL: 66,
  agogoH: 67, agogoL: 68, cabasa: 69, shaker: 70, guiro: 73, clave: 75, woodH: 76, woodL: 77,
  triangle: 81,
};
const DRUM_VEL: Readonly<Record<string, number>> = { X: 118, x: 92, o: 62, g: 38 };
const ACCENT: Readonly<Record<string, number>> = { X: 20, x: 0, o: -25 };

export interface GridTrack {
  type: 'bass' | 'chord';
  channel: number;
  program: number;
  volume?: number;
  velocity?: number;
  center?: number;
  ring?: boolean;
  transpose?: number;
  pan?: number;
  reverb?: number;
}

export interface GridStyle {
  name: string;
  tempo: number;
  steps?: number;
  beats?: number;
  swing?: number;
  drum_volume?: number;
  tracks: Record<string, GridTrack>;
  sections: Record<string, { drums?: Record<string, string> } & Record<string, unknown>>;
}

const SECTION_MAP: Readonly<Record<string, readonly SectionId[]>> = {
  main_a: ['mainA'],
  main_b: ['mainB'],
  fill: ['fillA', 'fillB'],
  ending: ['ending1'],
};

const SOURCE = makeChord(0, 'maj7');

function clean(p: string): string {
  return p.replace(/[\s|]/g, '');
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Source-chord voicing (C E G B) folded into an octave around `center`. */
function sourceVoicing(center: number): number[] {
  const low = center - 6;
  return [...new Set(SOURCE.intervals.map((i) => low + ((SOURCE.root + i - low) % 12 + 12) % 12))].sort((a, b) => a - b);
}

function bassDegree(d: string, transpose: number): number {
  const semis: Record<string, number> = { '1': 0, '2': 2, '3': 4, '4': 5, '5': 7, '6': 9, '7': 11, '8': 12 };
  return 36 + (semis[d] ?? 0) + transpose; // C2 = source root for bass
}

function timeSignatureOf(steps: number, beats: number): { ts: [number, 2 | 4 | 8 | 16]; tempoFactor: number } {
  if (steps === 12 && beats === 4) return { ts: [12, 8], tempoFactor: 1.5 }; // dotted-quarter beat
  if (steps === 12 && beats === 3) return { ts: [3, 4], tempoFactor: 1 };
  if (steps === 16 && beats === 4) return { ts: [4, 4], tempoFactor: 1 };
  if (steps === 8 && beats === 4) return { ts: [4, 4], tempoFactor: 1 };
  throw new Error(`unsupported grid: ${steps} steps / ${beats} beats`);
}

/** Next index after i whose char is not '-' (or the pattern end). */
function holdEnd(p: string, i: number): number {
  let j = i + 1;
  while (j < p.length && p[j] === '-') j++;
  return j;
}

function compilePart(track: GridTrack, pattern: string, stepTicks: number): NoteEvent[] {
  const p = clean(pattern);
  const out: NoteEvent[] = [];
  const vel = track.velocity ?? 85;
  const clampV = (v: number) => Math.max(1, Math.min(127, Math.round(v)));
  if (track.type === 'bass') {
    for (let i = 0; i < p.length; i++) {
      const c = p[i] ?? '.';
      if (!/[1-8]/.test(c)) continue;
      const end = holdEnd(p, i);
      out.push({ t: i * stepTicks, n: bassDegree(c, track.transpose ?? 0), v: clampV(vel), d: (end - i) * stepTicks });
    }
    return out;
  }
  const voicing = sourceVoicing(track.center ?? 60);
  for (let i = 0; i < p.length; i++) {
    const c = p[i] ?? '.';
    if (c in ACCENT) {
      const end = holdEnd(p, i);
      for (const n of voicing) out.push({ t: i * stepTicks, n, v: clampV(vel + (ACCENT[c] ?? 0)), d: (end - i) * stepTicks });
    } else if (/[1-9]/.test(c)) {
      const k = Number(c) - 1;
      const n = (voicing[k % voicing.length] ?? 60) + 12 * Math.floor(k / voicing.length);
      let end = holdEnd(p, i);
      if (track.ring) {
        // ringing notes last until a rest, a full strum, or the pattern end
        end = i + 1;
        while (end < p.length && p[end] !== '.' && !((p[end] ?? '') in ACCENT)) end++;
      }
      out.push({ t: i * stepTicks, n, v: clampV(vel * 0.92), d: (end - i) * stepTicks });
    }
  }
  return out;
}

function compileDrums(drums: Record<string, string>, stepTicks: number): NoteEvent[] {
  const out: NoteEvent[] = [];
  for (const [name, pattern] of Object.entries(drums)) {
    const note = GRID_DRUMS[name];
    if (note === undefined) throw new Error(`unknown drum "${name}"`);
    const p = clean(pattern);
    for (let i = 0; i < p.length; i++) {
      const v = DRUM_VEL[p[i] ?? '.'];
      if (v) out.push({ t: i * stepTicks, n: note, v, d: Math.max(1, Math.floor(stepTicks / 2)) });
    }
  }
  return out.sort((a, b) => a.t - b.t || a.n - b.n);
}

/** Compile one prototype grid style into a v1 style object (validate it with validateStyle). */
export function compileGridStyle(grid: GridStyle, category = 'prototype'): Style {
  const steps = grid.steps ?? 16;
  const beats = grid.beats ?? 4;
  const { ts, tempoFactor } = timeSignatureOf(steps, beats);
  const bar = (PPQ * 4 * ts[0]) / ts[1];
  const stepTicks = bar / steps;

  // Remap channels into the style range: bass 11, chord parts 12.. ; drums 10.
  const parts: Part[] = [];
  const trackIds = Object.keys(grid.tracks);
  let nextChordCh = 12;
  const partId = (t: string) => slugify(t) || 'part';
  for (const tid of trackIds) {
    const tr = grid.tracks[tid];
    if (!tr) continue;
    const isBass = tr.type === 'bass';
    const isPad = /pad|string/i.test(tid);
    const channel = isBass ? 11 : nextChordCh++;
    parts.push({
      id: partId(tid), name: tid, role: isBass ? 'bass' : isPad ? 'pad' : 'chord', channel,
      program: tr.program, bankMsb: 0, bankLsb: 0, volume: tr.volume ?? 90, pan: tr.pan ?? 64,
      reverb: tr.reverb ?? 40, chorus: 0, ntr: isBass ? 'root-fixed' : 'root-transpose',
      ntt: isBass ? 'bass' : 'chord',
    });
  }
  const anyDrums = Object.values(grid.sections).some((s) => s.drums && Object.keys(s.drums).length);
  if (anyDrums) {
    parts.unshift({
      id: 'drums', name: 'Drums', role: 'drums', channel: 10, program: 0, bankMsb: 0, bankLsb: 0,
      volume: grid.drum_volume ?? 100, pan: 64, reverb: 30, chorus: 0, ntr: 'root-transpose', ntt: 'bypass',
    });
  }

  const sections: Partial<Record<SectionId, Section>> = {};
  for (const [gName, gSec] of Object.entries(grid.sections)) {
    const targets = SECTION_MAP[gName];
    if (!targets) throw new Error(`unknown grid section "${gName}"`);
    const phrases: Record<string, NoteEvent[]> = {};
    let maxLen = steps;
    if (gSec.drums) {
      phrases.drums = compileDrums(gSec.drums, stepTicks);
      for (const p of Object.values(gSec.drums)) maxLen = Math.max(maxLen, clean(p).length);
    }
    for (const tid of trackIds) {
      const pat = gSec[tid];
      const tr = grid.tracks[tid];
      if (typeof pat !== 'string' || !tr) continue;
      phrases[partId(tid)] = compilePart(tr, pat, stepTicks);
      maxLen = Math.max(maxLen, clean(pat).length);
    }
    const section: Section = { bars: Math.ceil(maxLen / steps), phrases };
    for (const t of targets) sections[t] = section;
  }

  return {
    format: STYLE_FORMAT,
    schemaVersion: STYLE_SCHEMA_VERSION,
    id: slugify(grid.name),
    name: grid.name,
    category,
    tempo: Math.round(grid.tempo * tempoFactor),
    timeSignature: ts,
    ppq: PPQ,
    swing: grid.swing ?? 0,
    sourceChord: { root: 0, quality: 'maj7' },
    status: 'prototype',
    credits: [{ name: 'Claude (draft grid)', role: 'pattern draft' }],
    license: 'All rights reserved',
    parts,
    sections,
  };
}
