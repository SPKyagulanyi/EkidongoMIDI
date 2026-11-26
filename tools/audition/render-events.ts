/**
 * Renders styles into timed MIDI events (JSON) using the real engine, for auditioning / recording:
 *   node tools/audition/render-events.ts <out.json> <style-id> [style-id ...]
 * Plan per style: 4 bars Main A, a fill into Main B, 3 bars Main B, then stop.
 * Chords: C - Am - F - G, one per bar (I-vi-IV-V, the most common progression in these genres).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArrangerEngine, barTicks, makeChord, validateStyle, type MidiEvent, type Style } from '../../packages/engine/src/index.ts';

const root = join(import.meta.dirname, '..', '..', 'packages', 'styles');
const [out, ...ids] = process.argv.slice(2);
if (!out || ids.length === 0) throw new Error('usage: render-events.ts <out.json> <style-id> ...');

function load(id: string): Style {
  for (const dir of ['live', 'prototype']) {
    try {
      const r = validateStyle(JSON.parse(readFileSync(join(root, dir, `${id}.json`), 'utf8')));
      if (r.ok) return r.style;
    } catch { /* try next folder */ }
  }
  throw new Error(`style ${id} not found`);
}

const progression = [makeChord(0, ''), makeChord(9, 'm'), makeChord(5, ''), makeChord(7, '')];
const result = ids.map((id) => {
  const style = load(id);
  const barMs = (barTicks(style) * 60000) / (style.tempo * style.ppq);
  const startAt = 300;
  const bars = 8;
  const eng = new ArrangerEngine(style, { lookaheadMs: 20 }, 0);
  const events: MidiEvent[] = [...eng.tick(0)];
  eng.command({ type: 'chord', chord: progression[0]! }, 0);
  eng.command({ type: 'config', config: { syncStart: false } }, 0);
  eng.command({ type: 'stop' }, 0);
  events.push(...eng.tick(1));
  eng.command({ type: 'start', at: startAt }, 2);
  let bar = 0;
  for (let t = 10; t < startAt + bars * barMs; t += 10) {
    const nextBarAt = startAt + (bar + 1) * barMs;
    if (t >= nextBarAt - 60 && bar < bars - 1) {
      bar++;
      eng.command({ type: 'chord', chord: progression[bar % 4]! }, t);
      if (bar === 3) eng.command({ type: 'main', id: 'mainB' }, t); // fill in bar 4, Main B from bar 5
    }
    events.push(...eng.tick(t));
  }
  const end = startAt + bars * barMs;
  events.push(...eng.panic(end));
  return {
    id, name: style.name, tempo: style.tempo, durationMs: Math.round(end + 1500),
    events: events.filter((e) => e.t <= end).sort((a, b) => a.t - b.t).map((e) => [Math.round(e.t * 10) / 10, ...e.data]),
  };
});
writeFileSync(out, JSON.stringify(result));
console.log(result.map((r) => `${r.id}: ${r.events.length} events, ${(r.durationMs / 1000).toFixed(1)} s`).join('\n'));
