/**
 * Yamaha style importer (SFF1 .sty and SFF2 .prs/.sst/.bcs/.fps): turns a style file the player owns
 * into an EkidongoMIDI style for their personal library. Yamaha styles are copyrighted: imported
 * styles are for the owner's own use and must never be bundled or redistributed.
 *
 * A style file is a MIDI file whose markers name the sections ("Main A", "Fill In AA", ...), plus a
 * CASM chunk describing each part per section: source/destination channel, source chord, and the
 * note-transposition rules (NTR/NTT). SFF1 stores one rule per part (Ctab); SFF2 (Ctb2) stores rules
 * for three note ranges - we use the middle range, which covers most notes.
 *
 * Approximations (reported as warnings): one rule set per part (taken from Main A), alternative
 * phrases selected by chord type (chord mute) are reduced to the main phrase, Yamaha-specific voices
 * become the General MIDI voice with the same program number, both rhythm channels merge into one kit.
 */
import { parseSmf, type SmfFile } from '../midi/smf.ts';
import { PPQ, STYLE_FORMAT, STYLE_SCHEMA_VERSION, type NoteEvent, type Part, type Section, type SectionId, type Style } from '../style/schema.ts';

export const YAMAHA_STYLE_EXTENSIONS = ['sty', 'prs', 'sst', 'bcs', 'fps'] as const;

const SECTION_MAP: Readonly<Record<string, SectionId>> = {
  'Intro A': 'intro1', 'Intro B': 'intro2', 'Intro C': 'intro3',
  'Main A': 'mainA', 'Main B': 'mainB', 'Main C': 'mainC', 'Main D': 'mainD',
  'Fill In AA': 'fillA', 'Fill In BB': 'fillB', 'Fill In CC': 'fillC', 'Fill In DD': 'fillD',
  'Fill In BA': 'break',
  'Ending A': 'ending1', 'Ending B': 'ending2', 'Ending C': 'ending3',
};

/** Yamaha source-chord type codes -> our chord qualities (closest available). */
const CHORD_TYPES = ['', '6', 'maj7', 'maj7', 'add9', 'maj9', '6', 'aug', 'm', 'm6', 'm7', 'm7b5', 'madd9', 'm9', 'm7',
  'mMaj7', 'mMaj7', 'dim', 'dim7', '7', '7sus4', '7', '9', '7', '7', '7', '7', '7', 'aug', 'aug', '5', '5', 'sus4', 'sus2'];

/** One part's rule in one section (from a Ctab / Ctb2 entry). */
export interface YamahaChannelRule {
  src: number; // 0-15
  dest: number; // 0-15
  name: string;
  root: number;
  chordType: number;
  ntr: number;
  ntt: number;
  bassFlag: boolean;
  low: number;
  high: number;
}

export interface YamahaImport {
  style: Style;
  warnings: string[];
  format: 'SFF1' | 'SFF2' | 'unknown';
}

const ascii = (b: Uint8Array, start: number, len: number) => String.fromCharCode(...b.subarray(start, start + len));
const u32 = (b: Uint8Array, p: number) => ((b[p]! << 24) >>> 0) + (b[p + 1]! << 16) + (b[p + 2]! << 8) + b[p + 3]!;

/** CASM: section name -> channel rules. */
export function parseCasm(bytes: Uint8Array): Map<string, YamahaChannelRule[]> {
  const out = new Map<string, YamahaChannelRule[]>();
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    const id = ascii(bytes, pos, 4);
    const len = u32(bytes, pos + 4);
    if (id === 'CASM') {
      let p = pos + 8;
      const end = Math.min(bytes.length, pos + 8 + len);
      while (p + 8 <= end) {
        const cid = ascii(bytes, p, 4);
        const clen = u32(bytes, p + 4);
        if (cid === 'CSEG') {
          let q = p + 8;
          const qend = Math.min(end, p + 8 + clen);
          let names: string[] = [];
          const rules: YamahaChannelRule[] = [];
          while (q + 8 <= qend) {
            const eid = ascii(bytes, q, 4);
            const elen = u32(bytes, q + 4);
            const e = bytes.subarray(q + 8, q + 8 + elen);
            if (eid === 'Sdec') names = ascii(e, 0, e.length).split(',').map((s) => s.trim()).filter(Boolean);
            else if (eid === 'Ctab' && e.length >= 25) {
              rules.push({ src: e[0]!, dest: e[9]!, name: ascii(e, 1, 8).trim(), root: e[18]! % 12, chordType: e[19]!, ntr: e[20]!, ntt: e[21]!, bassFlag: e[21] === 3, low: e[23]!, high: e[24]! });
            } else if (eid === 'Ctb2' && e.length >= 34) {
              // Middle note-range block: NTR, NTT (bit 7 = bass), high key, low limit, high limit, RTR.
              rules.push({ src: e[0]!, dest: e[9]!, name: ascii(e, 1, 8).trim(), root: e[18]! % 12, chordType: e[19]!, ntr: e[28]!, ntt: e[29]! & 0x7f, bassFlag: (e[29]! & 0x80) !== 0, low: e[31]!, high: e[32]! });
            }
            q += 8 + elen;
          }
          for (const n of names) out.set(n, rules);
        }
        p += 8 + clen;
      }
    }
    if (len === 0 && id !== 'CASM') break;
    pos += 8 + len;
  }
  return out;
}

function ruleFor(r: YamahaChannelRule | undefined, role: Part['role'], sff2: boolean): Pick<Part, 'ntr' | 'ntt'> {
  if (role === 'drums') return { ntr: 'root-transpose', ntt: 'bypass' };
  if (!r) return role === 'bass' ? { ntr: 'root-fixed', ntt: 'bass' } : { ntr: 'root-fixed', ntt: 'chord' };
  const ntr: Part['ntr'] = r.ntr === 2 ? 'guitar' : r.ntr === 1 ? 'root-fixed' : 'root-transpose';
  if (ntr === 'guitar') return { ntr, ntt: 'chord' };
  if (r.bassFlag || (!sff2 && r.ntt === 3)) return { ntr, ntt: 'bass' };
  const t = r.ntt;
  if (t === 0) return { ntr, ntt: 'bypass' };
  if (t === 2) return { ntr, ntt: 'chord' };
  if (sff2) {
    if (t >= 3 && t <= 6) return { ntr, ntt: 'melodic-minor' };
    if (t === 9 || t === 10) return { ntr, ntt: 'dorian' };
    return { ntr, ntt: 'melody' };
  }
  if (t === 4 || t === 5) return { ntr, ntt: 'melodic-minor' };
  return { ntr, ntt: 'melody' };
}

function roleOf(dest: number): Part['role'] {
  if (dest === 8 || dest === 9) return 'drums';
  if (dest === 10) return 'bass';
  if (dest === 13) return 'pad';
  if (dest === 14 || dest === 15) return 'phrase';
  return 'chord';
}

const DEFAULT_NAMES: Record<number, string> = { 9: 'Drums', 10: 'Bass', 11: 'Chord 1', 12: 'Chord 2', 13: 'Pad', 14: 'Phrase 1', 15: 'Phrase 2' };
const GM2_KITS = new Set([0, 8, 16, 24, 25, 32, 40, 48]);

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'style';

/** Import one Yamaha style file. `fileName` names the style when the file has no usable name. */
export function importYamahaStyle(bytes: Uint8Array, fileName: string): YamahaImport {
  const smf: SmfFile = parseSmf(bytes);
  const warnings: string[] = [];
  const format = smf.markers.some((m) => m.text === 'SFF2') ? 'SFF2' : smf.markers.some((m) => m.text === 'SFF1') ? 'SFF1' : 'unknown';
  const sff2 = format === 'SFF2';
  if (format === 'unknown') warnings.push('No SFF1/SFF2 marker found: reading it as a style anyway.');
  const casm = parseCasm(bytes);
  if (casm.size === 0) warnings.push('No CASM part rules found: default rules used for every part.');

  const [num0, den0] = smf.timeSignature ?? [4, 4];
  const den = ([2, 4, 8, 16] as const).find((d) => d === den0) ?? 4;
  const num = Math.max(1, Math.min(16, num0));
  const fileBar = (smf.ppq * 4 * num) / den;
  const ourBar = (PPQ * 4 * num) / den;
  const scale = PPQ / smf.ppq;

  // Section spans from consecutive markers.
  const spans: { name: string; start: number; end: number }[] = [];
  const lastTick = Math.max(0, ...smf.notes.map((n) => n.tick + n.duration));
  smf.markers.forEach((m, i) => {
    const next = smf.markers.slice(i + 1).find((x) => x.tick > m.tick);
    spans.push({ name: m.text, start: m.tick, end: next ? next.tick : Math.max(lastTick, m.tick + fileBar) });
  });
  const firstSection = spans.find((s) => SECTION_MAP[s.name])?.start ?? 0;

  // Parts: one per destination channel; rules from Main A when available.
  const mainRules = casm.get('Main A') ?? [...casm.values()][0] ?? [];
  const parts = new Map<number, Part>(); // keyed by our 1-based channel
  const used = new Set<string>();
  const partFor = (dest: number, rule: YamahaChannelRule | undefined): Part => {
    const role = roleOf(dest);
    const channel = role === 'drums' ? 10 : dest + 1;
    const existing = parts.get(channel);
    if (existing) return existing;
    const mainRule = mainRules.find((r) => r.dest === dest && (r.src === dest || !mainRules.some((x) => x.dest === dest && x.src === dest))) ?? rule;
    let id = role === 'drums' ? 'drums' : slugify(mainRule?.name || DEFAULT_NAMES[dest] || `part-${channel}`);
    for (let i = 2; used.has(id); i++) id = `${id.replace(/-\d+$/, '')}-${i}`;
    used.add(id);
    // Instrument setup from the setup area (before the first section).
    const setup = smf.controls.filter((c) => c.channel === dest && c.tick <= firstSection);
    const last = (k: 'program' | 'cc', d1?: number) => [...setup].reverse().find((c) => c.kind === k && (d1 === undefined || c.d1 === d1));
    let program = last('program')?.d1 ?? 0;
    if (role === 'drums') program = GM2_KITS.has(program) ? program : 0;
    const p: Part = {
      id, name: role === 'drums' ? 'Drums' : mainRule?.name || DEFAULT_NAMES[dest] || `Part ${channel}`, role, channel, program,
      bankMsb: 0, bankLsb: 0,
      volume: last('cc', 7)?.d2 ?? 100, pan: last('cc', 10)?.d2 ?? 64, reverb: last('cc', 91)?.d2 ?? 40, chorus: last('cc', 93)?.d2 ?? 0,
      ...ruleFor(mainRule, role, sff2),
    };
    parts.set(channel, p);
    return p;
  };

  const sections: Partial<Record<SectionId, Section>> = {};
  let skippedAlternates = 0;
  let notesKept = 0;
  for (const span of spans) {
    const id = SECTION_MAP[span.name];
    if (!id) continue;
    const bars = Math.max(1, Math.min(16, Math.round((span.end - span.start) / fileBar)));
    const rules = casm.get(span.name) ?? mainRules;
    // Which source channel feeds each destination: the matching channel first, else the first rule.
    const byDest = new Map<number, YamahaChannelRule | undefined>();
    for (const r of rules) {
      if (byDest.has(r.dest) && byDest.get(r.dest)?.src === r.dest) { skippedAlternates++; continue; }
      if (byDest.has(r.dest) && r.src !== r.dest) { skippedAlternates++; continue; }
      byDest.set(r.dest, r);
    }
    if (byDest.size === 0) for (let ch = 8; ch <= 15; ch++) byDest.set(ch, undefined);
    const phrases: Record<string, NoteEvent[]> = {};
    for (const [dest, rule] of byDest) {
      if (dest < 8 || dest > 15) continue;
      const src = rule?.src ?? dest;
      const part = partFor(dest, rule);
      const role = part.role;
      // Phrases written over a source chord rooted on another note are moved to C (our source root).
      const root = role === 'drums' ? 0 : rule?.root ?? 0;
      const shift = root > 6 ? 12 - root : -root;
      const evs = smf.notes
        .filter((n) => n.channel === src && n.tick >= span.start && n.tick < span.end)
        .map((n) => ({ t: Math.round((n.tick - span.start) * scale), n: Math.max(0, Math.min(127, n.note + shift)), v: n.velocity, d: Math.max(1, Math.round(n.duration * scale) || 60) }))
        .filter((e) => e.t < bars * ourBar);
      if (!evs.length) continue;
      const list = (phrases[part.id] ??= []);
      list.push(...evs);
      list.sort((a, b) => a.t - b.t || a.n - b.n);
      notesKept += evs.length;
    }
    sections[id] = { bars, phrases };
  }
  if (!sections.mainA) {
    const first = (['mainB', 'mainC', 'mainD'] as SectionId[]).find((s) => sections[s]);
    if (first) sections.mainA = sections[first];
    else throw new Error('This file has no Main sections: it does not look like a style.');
  }
  if (skippedAlternates) warnings.push(`${skippedAlternates} alternative phrases (played only for certain chord types on Yamaha keyboards) were left out.`);
  warnings.push('Yamaha voices are played with the matching General MIDI voice of your keyboard, so some sounds differ from the original.');
  if (smf.notes.some((n) => n.channel === 8)) warnings.push('The two rhythm parts were combined into one drum kit.');

  const rawName = smf.markers.length ? '' : '';
  const base = fileName.replace(/\.[^.]+$/, '').trim() || rawName || 'Yamaha style';
  const quality = CHORD_TYPES[mainRules.find((r) => r.dest === 11)?.chordType ?? 2] ?? 'maj7';
  const style: Style = {
    format: STYLE_FORMAT,
    schemaVersion: STYLE_SCHEMA_VERSION,
    id: `${slugify(base)}-yamaha`.slice(0, 64),
    name: base,
    category: 'Yamaha (yours)',
    tempo: Math.max(20, Math.min(400, Math.round(60_000_000 / smf.tempoUsPerQuarter))),
    timeSignature: [num, den],
    ppq: PPQ,
    swing: 0,
    sourceChord: { root: 0, quality: quality === '' || quality === 'maj7' ? quality : 'maj7' },
    status: 'in-review',
    credits: [{ name: 'Imported Yamaha style', role: `${fileName} (${format}, ${notesKept} notes)` }],
    license: 'Imported from a Yamaha style file you own: for your personal use only, not for sharing or redistribution.',
    parts: [...parts.values()].sort((a, b) => a.channel - b.channel),
    sections,
  };
  return { style, warnings, format };
}
