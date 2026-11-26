import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArrangerEngine, makeChord, validateStyle, type MidiEvent } from '@ekidongo/engine';

const dirs = ['prototype', 'live'].map((d) => join(import.meta.dirname, '..', d));
const paths = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => join(d, f)));
const files = paths.map((p) => basename(p));
const pathOf = (file: string) => paths[files.indexOf(file)]!;
const isOn = (e: MidiEvent) => (e.data[0]! & 0xf0) === 0x90 && e.data[2]! > 0;

describe('every library style plays', () => {
  it.each(files)('%s: 30 s with chord changes and a section change, no stuck notes', (file) => {
    const r = validateStyle(JSON.parse(readFileSync(pathOf(file), 'utf8')));
    if (!r.ok) throw new Error(r.errors.join('\n'));
    const eng = new ArrangerEngine(r.style);
    const all: MidiEvent[] = [];
    eng.command({ type: 'start' }, 0);
    const progression = [makeChord(0, ''), makeChord(9, 'm7'), makeChord(5, 'maj7'), makeChord(7, '7')];
    for (let t = 0; t < 30000; t += 10) {
      if (t % 4000 === 0) eng.command({ type: 'chord', chord: progression[(t / 4000) % 4]! }, t);
      if (t === 12000) eng.command({ type: 'main', id: 'mainB' }, t);
      all.push(...eng.tick(t));
    }
    all.push(...eng.panic(30000));
    expect(all.filter(isOn).length, 'notes played').toBeGreaterThan(30);
    const bal = new Map<string, number>();
    for (const e of all) {
      const type = e.data[0]! & 0xf0;
      if (type !== 0x80 && type !== 0x90) continue;
      const k = `${e.data[0]! & 0x0f}:${e.data[1]}`;
      bal.set(k, (bal.get(k) ?? 0) + (type === 0x90 ? 1 : -1));
    }
    for (const [k, n] of bal) expect(n, `stuck ${k}`).toBeLessThanOrEqual(0);
  });
});
