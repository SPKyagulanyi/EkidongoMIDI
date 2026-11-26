/**
 * Style editing: the pure functions behind the recorder and MIDI import. Every function returns a new
 * style (inputs are never changed); validate with validateStyle before saving.
 */
import { PPQ, STYLE_CHANNELS, STYLE_FORMAT, STYLE_SCHEMA_VERSION, barTicks, type NoteEvent, type Part, type SectionId, type Style } from './schema.ts';

type Role = Part['role'];

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'part';

export interface NewStyleOptions {
  id: string;
  name: string;
  category?: string;
  tempo: number;
  timeSignature: [number, 2 | 4 | 8 | 16];
  bars?: number;
}

/** An empty style with a drum part and an empty 2-bar Main A, ready to record into. */
export function emptyStyle(o: NewStyleOptions): Style {
  return {
    format: STYLE_FORMAT,
    schemaVersion: STYLE_SCHEMA_VERSION,
    id: slug(o.id),
    name: o.name,
    category: o.category ?? 'My styles',
    tempo: o.tempo,
    timeSignature: o.timeSignature,
    ppq: PPQ,
    swing: 0,
    sourceChord: { root: 0, quality: 'maj7' },
    status: 'in-review',
    credits: [],
    license: 'All rights reserved',
    parts: [{
      id: 'drums', name: 'Drums', role: 'drums', channel: 10, program: 0, bankMsb: 0, bankLsb: 0,
      volume: 100, pan: 64, reverb: 30, chorus: 0, ntr: 'root-transpose', ntt: 'bypass',
    }],
    sections: { mainA: { bars: o.bars ?? 2, phrases: {} } },
  };
}

/** Sensible re-pitching rules for a recorded part of each role. */
function rulesFor(role: Role): Pick<Part, 'ntr' | 'ntt'> {
  switch (role) {
    case 'drums': return { ntr: 'root-transpose', ntt: 'bypass' };
    case 'bass': return { ntr: 'root-fixed', ntt: 'bass' };
    case 'chord':
    case 'pad': return { ntr: 'root-fixed', ntt: 'chord' };
    case 'phrase': return { ntr: 'root-transpose', ntt: 'melody' };
  }
}

/** Add a part on the next free style channel. Throws when no channel is free. */
export function addPart(style: Style, p: { name: string; role: Role; program: number }): { style: Style; partId: string } {
  const s = clone(style);
  const used = new Set(s.parts.map((x) => x.channel));
  let channel: number | undefined;
  if (p.role === 'drums') channel = used.has(10) ? undefined : 10;
  else channel = [11, 12, 13, 14, 15, 16, 9].find((c) => !used.has(c) && (STYLE_CHANNELS as readonly number[]).includes(c));
  if (channel === undefined) throw new Error(p.role === 'drums' ? 'This style already has a drum part.' : 'No free channel: a style can have up to 8 parts.');
  let id = slug(p.name);
  for (let i = 2; s.parts.some((x) => x.id === id); i++) id = `${slug(p.name)}-${i}`;
  s.parts.push({
    id, name: p.name, role: p.role, channel, program: p.program, bankMsb: 0, bankLsb: 0,
    volume: 100, pan: 64, reverb: 40, chorus: 0, ...rulesFor(p.role),
  });
  return { style: s, partId: id };
}

/** Create a section, or change its length (notes past the new end are removed). */
export function setSectionBars(style: Style, section: SectionId, bars: number): Style {
  const s = clone(style);
  const len = bars * barTicks(s);
  const sec = s.sections[section] ?? { bars, phrases: {} };
  sec.bars = bars;
  for (const [part, evs] of Object.entries(sec.phrases)) sec.phrases[part] = evs.filter((e) => e.t < len);
  s.sections[section] = sec;
  return s;
}

/** Put notes into one part of one section: replace what was there, or add to it (overdub). */
export function writePhrase(style: Style, section: SectionId, partId: string, events: NoteEvent[], mode: 'replace' | 'add'): Style {
  const s = clone(style);
  const sec = s.sections[section];
  if (!sec) throw new Error(`The style has no ${section} section.`);
  if (!s.parts.some((p) => p.id === partId)) throw new Error(`The style has no part "${partId}".`);
  const len = sec.bars * barTicks(s);
  const kept = mode === 'add' ? sec.phrases[partId] ?? [] : [];
  sec.phrases[partId] = [...kept, ...events.filter((e) => e.t >= 0 && e.t < len)].sort((a, b) => a.t - b.t || a.n - b.n);
  return s;
}

/** A raw MIDI message with its time in ms (as recorded from the keyboard). */
export interface TimedMessage {
  t: number;
  data: readonly number[];
}

export interface CaptureOptions {
  /** Time (ms) of tick 0 of the section. */
  startMs: number;
  /** Quarter-note BPM while recording. */
  tempo: number;
  /** Section length in ticks; notes starting at or after it are dropped. */
  lengthTicks: number;
  /** Notes played up to this much before the start count as beat 1 (default 60 ms). */
  earlyMs?: number;
}

/**
 * Turn recorded keyboard messages into phrase notes: note-ons paired with their note-offs, times
 * converted to ticks (480 per quarter), timing kept exactly as played. Notes still held at the end
 * last until the end of the section.
 */
export function captureToPhrase(messages: TimedMessage[], o: CaptureOptions): NoteEvent[] {
  const msPerTick = 60000 / (o.tempo * PPQ);
  const early = o.earlyMs ?? 60;
  const open = new Map<number, { t: number; v: number }[]>();
  const out: NoteEvent[] = [];
  const toTick = (ms: number) => Math.round((ms - o.startMs) / msPerTick);
  const sorted = [...messages].sort((a, b) => a.t - b.t);
  for (const m of sorted) {
    const [st = 0, n = 0, v = 0] = m.data;
    const kind = st & 0xf0;
    if (kind === 0x90 && v > 0) {
      if (m.t < o.startMs - early) continue;
      (open.get(n) ?? open.set(n, []).get(n)!).push({ t: Math.max(0, toTick(m.t)), v });
    } else if (kind === 0x80 || (kind === 0x90 && v === 0)) {
      const start = open.get(n)?.shift();
      if (!start || start.t >= o.lengthTicks) continue;
      out.push({ t: start.t, n, v: start.v, d: Math.max(1, Math.min(toTick(m.t), o.lengthTicks) - start.t) });
    }
  }
  for (const [n, starts] of open) {
    for (const s of starts) if (s.t < o.lengthTicks) out.push({ t: s.t, n, v: s.v, d: Math.max(1, o.lengthTicks - s.t) });
  }
  return out.sort((a, b) => a.t - b.t || a.n - b.n);
}

/**
 * Move note starts toward a grid. `grid` in ticks (120 = 16th, 240 = 8th, 160 = 8th triplet,
 * 80 = 16th triplet); `strength` 0..1 (1 = exactly on the grid, 0.5 = halfway).
 */
export function quantize(events: NoteEvent[], grid: number, strength = 1): NoteEvent[] {
  if (grid <= 0 || strength <= 0) return events.map((e) => ({ ...e }));
  return events.map((e) => {
    const target = Math.round(e.t / grid) * grid;
    return { ...e, t: Math.max(0, Math.round(e.t + (target - e.t) * Math.min(1, strength))) };
  });
}

/**
 * Small, repeatable human variation for programmed parts: velocities vary by up to ±`velocity` and
 * start times by up to ±`timing` ticks. The same seed always gives the same result. Never apply it
 * to performances that were played by people (they already have their feel).
 */
export function humanize(events: NoteEvent[], o: { velocity?: number; timing?: number; seed?: number } = {}): NoteEvent[] {
  let s = (o.seed ?? 1) >>> 0 || 1;
  const rand = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0xffffffff * 2 - 1; // -1..1
  };
  const dv = o.velocity ?? 8;
  const dt = o.timing ?? 6;
  return events.map((e) => {
    const v = Math.max(1, Math.min(127, Math.round(e.v + rand() * dv)));
    const t = e.t === 0 ? 0 : Math.max(0, Math.round(e.t + rand() * dt)); // keep beat 1 exactly on the bar
    return { ...e, t, v };
  });
}

/** Scale velocities so their average becomes `target`, keeping the accents' shape. */
export function setAverageVelocity(events: NoteEvent[], target: number): NoteEvent[] {
  if (!events.length) return [];
  const avg = events.reduce((a, e) => a + e.v, 0) / events.length;
  const k = target / avg;
  return events.map((e) => ({ ...e, v: Math.max(1, Math.min(127, Math.round(e.v * k))) }));
}

/** Notes of one MIDI channel from an imported file, as a phrase starting at `fromBar`. */
export function phraseFromMidi(
  notes: { tick: number; duration: number; channel: number; note: number; velocity: number }[],
  o: { ppq: number; channel: number; fromBar: number; bars: number; barTicks: number },
): NoteEvent[] {
  const scale = PPQ / o.ppq;
  const start = o.fromBar * o.barTicks;
  const end = start + o.bars * o.barTicks;
  return notes
    .filter((n) => n.channel === o.channel)
    .map((n) => ({ t: Math.round(n.tick * scale) - start, n: n.note, v: n.velocity, d: Math.max(1, Math.round(n.duration * scale) || 120) }))
    .filter((e) => e.t >= 0 && e.t < end - start)
    .sort((a, b) => a.t - b.t || a.n - b.n);
}
