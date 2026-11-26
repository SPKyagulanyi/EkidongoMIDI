/**
 * Imports every Yamaha style file in a folder (recursively) and reports what came through.
 * For checking the importer against real files; the files themselves stay private.
 *   node tools/try-yamaha-import.ts private-test-styles
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ArrangerEngine, importYamahaStyle, makeChord, validateStyle, type MidiEvent } from '../packages/engine/src/index.ts';

const root = process.argv[2] ?? 'private-test-styles';
const files: string[] = [];
const walk = (d: string) => readdirSync(d).forEach((f) => {
  const p = join(d, f);
  if (statSync(p).isDirectory()) walk(p);
  else if (/\.(sty|prs|sst|bcs|fps)$/i.test(f)) files.push(p);
});
walk(root);

let ok = 0;
const failures: string[] = [];
const warnCounts = new Map<string, number>();
for (const f of files) {
  try {
    const { style, warnings, format } = importYamahaStyle(readFileSync(f), f.split(/[\\/]/).pop()!);
    const r = validateStyle(style);
    if (!r.ok) throw new Error(r.errors.slice(0, 2).join('; '));
    // Play 16 s with chord changes; count notes and check nothing sticks.
    const eng = new ArrangerEngine(r.style);
    eng.command({ type: 'start' }, 0);
    const evs: MidiEvent[] = [];
    const chords = [makeChord(0, ''), makeChord(9, 'm'), makeChord(5, ''), makeChord(7, '7')];
    for (let t = 0; t < 16000; t += 10) {
      if (t % 2000 === 0) eng.command({ type: 'chord', chord: chords[(t / 2000) % 4]! }, t);
      evs.push(...eng.tick(t));
    }
    evs.push(...eng.panic(16000));
    const bal = new Map<string, number>();
    for (const e of evs) {
      const k = e.data[0]! & 0xf0;
      if (k !== 0x80 && k !== 0x90) continue;
      const key = `${e.data[0]! & 15}:${e.data[1]}`;
      bal.set(key, (bal.get(key) ?? 0) + (k === 0x90 && e.data[2]! > 0 ? 1 : -1));
    }
    const stuck = [...bal.values()].filter((v) => v > 0).length;
    const notes = evs.filter((e) => (e.data[0]! & 0xf0) === 0x90 && e.data[2]! > 0).length;
    if (stuck) throw new Error(`${stuck} stuck notes`);
    if (notes < 20) throw new Error(`only ${notes} notes played`);
    ok++;
    for (const w of warnings) warnCounts.set(w.replace(/^\d+/, 'N'), (warnCounts.get(w.replace(/^\d+/, 'N')) ?? 0) + 1);
    if (ok <= 6) console.log(`ok ${format} ${r.style.name}: ${r.style.parts.map((p) => `${p.name}[${p.ntr}/${p.ntt}]`).join(', ')} | ${Object.keys(r.style.sections).length} sections, ${Math.round(r.style.tempo)} BPM ${r.style.timeSignature.join('/')}, ${notes} notes in 16 s`);
  } catch (e) {
    failures.push(`${f.split(/[\\/]/).pop()}: ${(e as Error).message}`);
  }
}
console.log(`\n${ok}/${files.length} imported, played and checked`);
for (const [w, n] of warnCounts) console.log(`  warning x${n}: ${w}`);
for (const f of failures.slice(0, 15)) console.log(`  FAIL ${f}`);
