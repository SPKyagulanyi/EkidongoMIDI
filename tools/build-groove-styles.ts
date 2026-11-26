/**
 * Builds "Live Drums" styles: real drummer performances from the Groove MIDI Dataset (Google LLC,
 * CC BY 4.0) combined with each prototype style's bass and chord parts.
 *
 *   pnpm build:groove        (needs third_party/groove from the dataset download; see NOTICE.md)
 *
 * Per style: Main A = a typical 2-bar window of a long beat performance, Main B = a busier one,
 * Fill A/B = the drummer's recorded 1-bar fills. Timing and velocity are kept exactly as played
 * (only ticks are rescaled to 480 PPQ and TD-11 edge/rim notes mapped to General MIDI drums).
 * Missing sections are then derived as for every style.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  barTicks, deriveMissingSections, parseSmf, smfBpm, validateStyle,
  type NoteEvent, type Section, type SectionId, type Style,
} from '../packages/engine/src/index.ts';
import { mixPass } from './style-mix.ts';

const repo = join(import.meta.dirname, '..');
const gmdRoot = join(repo, 'third_party', 'groove', 'groove');
const protoDir = join(repo, 'packages', 'styles', 'prototype');
const outDir = join(repo, 'packages', 'styles', 'live');

/** Our style -> which Groove MIDI performances to use (style label, optional drummer and BPM). */
const PLAN: { target: string; gmdStyle: string; drummer?: string; bpm?: number }[] = [
  { target: 'afrobeat', gmdStyle: 'afrobeat' },
  { target: 'highlife', gmdStyle: 'highlife' },
  { target: 'reggae-one-drop', gmdStyle: 'reggae', drummer: 'drummer1', bpm: 78 },
  { target: 'reggae-rockers', gmdStyle: 'reggae', drummer: 'drummer5', bpm: 126 },
  { target: 'praise-worship', gmdStyle: 'gospel' },
  { target: 'pop-8-beat', gmdStyle: 'pop' },
  { target: 'ballad', gmdStyle: 'soul/groove4' },
  { target: 'rnb', gmdStyle: 'hiphop/groove6' },
  { target: 'reggaeton', gmdStyle: 'latin/reggaeton' },
  { target: 'march', gmdStyle: 'jazz/march', bpm: 120 },
  { target: 'waltz-3-4', gmdStyle: 'jazz', bpm: 120 },
];

/** Roland TD-11 notes that aren't General MIDI drums -> nearest GM sound. */
const DRUM_MAP: Record<number, number> = { 22: 42, 26: 46, 58: 43, 55: 49, 52: 57 };

interface Row { drummer: string; style: string; bpm: number; type: string; ts: string; file: string }
const rows: Row[] = readFileSync(join(gmdRoot, 'info.csv'), 'utf8').trim().split('\n').slice(1).map((l) => {
  const c = l.split(',');
  return { drummer: c[0]!, style: c[3]!, bpm: Number(c[4]), type: c[5]!, ts: c[6]!, file: c[7]! };
});

const matches = (r: Row, p: (typeof PLAN)[number]) =>
  (r.style === p.gmdStyle || r.style.startsWith(`${p.gmdStyle}/`)) &&
  (!p.drummer || r.drummer === p.drummer) && (!p.bpm || r.bpm === p.bpm);

function loadNotes(file: string): { events: NoteEvent[]; bpm: number } {
  const f = parseSmf(readFileSync(join(gmdRoot, file)));
  const scale = 480 / f.ppq;
  const events = f.notes.map((n) => ({
    t: Math.round(n.tick * scale),
    n: DRUM_MAP[n.note] ?? n.note,
    v: n.velocity,
    d: Math.max(30, Math.min(480, Math.round(n.duration * scale) || 60)),
  }));
  return { events, bpm: smfBpm(f) };
}

/** Notes of bars [from, from+count), with anticipations up to 30 ticks early kept on beat 1. */
function window(evs: NoteEvent[], bar: number, from: number, count: number): NoteEvent[] {
  const lo = from * bar - 30;
  const hi = (from + count) * bar - 30;
  return evs.filter((e) => e.t >= lo && e.t < hi).map((e) => ({ ...e, t: Math.max(0, e.t - from * bar) }));
}

function pickMains(evs: NoteEvent[], bar: number): { a: NoteEvent[]; b: NoteEvent[]; info: string } {
  const bars = Math.floor((evs.at(-1)?.t ?? 0) / bar);
  const count = (i: number) => evs.filter((e) => e.t >= i * bar && e.t < (i + 1) * bar).length;
  const cands: { start: number; density: number }[] = [];
  for (let s = 2; s + 2 <= bars - 1; s += 2) { // skip count-in and the last bars; phrases start on even bars
    const d1 = count(s), d2 = count(s + 1);
    if (!d1 || !d2) continue;
    if (Math.abs(d1 - d2) / Math.max(d1, d2) > 0.3) continue; // skip windows containing a fill
    cands.push({ start: s, density: d1 + d2 });
  }
  if (cands.length < 2) throw new Error('not enough steady 2-bar windows');
  const sorted = [...cands].sort((x, y) => x.density - y.density);
  const a = sorted[Math.floor(sorted.length * 0.3)]!;
  let b = sorted[Math.floor(sorted.length * 0.8)]!;
  if (b.start === a.start) b = sorted.at(-1)!;
  return { a: window(evs, bar, a.start, 2), b: window(evs, bar, b.start, 2), info: `A=bars ${a.start}-${a.start + 1} (${a.density} notes), B=bars ${b.start}-${b.start + 1} (${b.density})` };
}

/**
 * The drummer's own fills inside a long performance: bars at the end of a phrase (odd bar index)
 * that are clearly busier than the two bars before them.
 */
function fillsFromPerformance(evs: NoteEvent[], bar: number): NoteEvent[][] {
  const bars = Math.floor((evs.at(-1)?.t ?? 0) / bar);
  const counts = Array.from({ length: bars }, (_, i) => evs.filter((e) => e.t >= i * bar && e.t < (i + 1) * bar).length);
  const typical = [...counts].filter((c) => c > 0).sort((a, b) => a - b)[Math.floor(counts.length / 2)] ?? 1;
  const scored = counts
    .map((c, i) => ({ i, ratio: c / typical, phraseEnd: i % 4 === 3 }))
    .filter((x) => x.i >= 2 && x.i < bars - 1);
  // Prefer busy bars that end a 4-bar phrase; otherwise the busiest bars of the performance.
  let picks = scored.filter((x) => x.phraseEnd && x.ratio >= 1.2);
  if (picks.length < 2) picks = [...scored].sort((a, b) => b.ratio - a.ratio).slice(0, 4);
  return picks.sort((a, b) => a.ratio - b.ratio).map((f) => window(evs, bar, f.i, 1));
}

/** Repeat a 1-bar band phrase so it covers `bars` bars. */
function stretch(evs: NoteEvent[] | undefined, srcBars: number, bars: number, bar: number): NoteEvent[] {
  if (!evs) return [];
  const out: NoteEvent[] = [];
  for (let k = 0; k < bars; k += srcBars) out.push(...evs.map((e) => ({ ...e, t: e.t + k * bar })));
  return out.filter((e) => e.t < bars * bar);
}

mkdirSync(outDir, { recursive: true });
let failed = 0;
for (const p of PLAN) {
  try {
    const proto: Style = JSON.parse(readFileSync(join(protoDir, `${p.target}.json`), 'utf8'));
    const meter = `${proto.timeSignature[0]}-${proto.timeSignature[1]}`;
    const beats = rows.filter((r) => r.type === 'beat' && r.ts === meter && matches(r, p));
    if (!beats.length) throw new Error(`no ${meter} beat performances for ${p.gmdStyle}`);
    const longest = beats.map((r) => ({ r, ...loadNotes(r.file) })).sort((x, y) => y.events.length - x.events.length)[0]!;
    const bar = barTicks(proto);
    const { a, b, info } = pickMains(longest.events, bar);
    let fills = rows
      .filter((r) => r.type === 'fill' && r.ts === meter && r.drummer === longest.r.drummer && matches(r, { ...p, drummer: longest.r.drummer }))
      .map((r) => window(loadNotes(r.file).events, bar, 0, 1))
      .filter((evs) => evs.length >= 6)
      .sort((x, y) => x.length - y.length);
    let fillSource = 'fill recordings';
    if (fills.length < 2) {
      fills = fillsFromPerformance(longest.events, bar);
      fillSource = 'fills played in the performance';
    }

    const band = (id: SectionId, bars: number): Record<string, NoteEvent[]> => {
      const src = proto.sections[id];
      const out: Record<string, NoteEvent[]> = {};
      if (!src) return out;
      for (const [part, evs] of Object.entries(src.phrases)) if (part !== 'drums') out[part] = stretch(evs, src.bars, bars, bar);
      return out;
    };
    const sec = (drums: NoteEvent[], bars: number, bandFrom: SectionId): Section => ({ bars, phrases: { drums, ...band(bandFrom, bars) } });
    const sections: Partial<Record<SectionId, Section>> = {
      mainA: sec(a, 2, 'mainA'),
      mainB: sec(b, 2, 'mainB'),
    };
    if (fills.length) {
      sections.fillA = sec(fills[Math.floor(fills.length / 3)]!, 1, 'fillA');
      sections.fillB = sec(fills[Math.floor((fills.length * 2) / 3)] ?? fills.at(-1)!, 1, 'fillB');
    }
    if (proto.sections.ending1) sections.ending1 = proto.sections.ending1; // keep the band's ending

    const style: Style = deriveMissingSections(mixPass({
      ...proto,
      id: `${p.target}-live`,
      name: `${proto.name} · Live Drums`,
      tempo: Math.round(longest.bpm),
      swing: 0, // the drummer's own feel replaces programmed swing
      status: 'in-review',
      credits: [
        { name: `Groove MIDI Dataset, ${longest.r.drummer}`, role: `drums (${longest.r.style}, ${longest.r.bpm} BPM)` },
        { name: 'Claude (draft grid)', role: 'bass and chord parts' },
      ],
      license: 'Drums: Groove MIDI Dataset by Google LLC, CC BY 4.0 (bars selected, notes mapped to GM). Other parts: all rights reserved.',
      sections,
    }, {
      // The drummer's performance keeps its own feel and dynamics; the programmed band parts get the mix pass.
      humanizeParts: () => false, // band parts come from the prototypes, already humanized once
      keepVelocity: (p) => p.role === 'drums',
    }));
    const r = validateStyle(style);
    if (!r.ok) throw new Error(r.errors.join('; '));
    writeFileSync(join(outDir, `${style.id}.json`), JSON.stringify(r.style, null, 1) + '\n');
    console.log(`ok ${style.id}: ${longest.r.file.split('/').pop()} @${longest.bpm.toFixed(0)} ${info}, ${fills.length} ${fillSource}`);
  } catch (e) {
    failed++;
    console.error(`x ${p.target}: ${(e as Error).message}`);
  }
}
console.log(`\n${PLAN.length - failed}/${PLAN.length} live-drum styles written to ${outDir}`);
process.exitCode = failed ? 1 : 0;
