import { describe, expect, it } from 'vitest';
import { ArrangerEngine, compileGridStyle, detectChordWithMode, gmName, GM_VOICES, type MidiEvent } from '../src/index.ts';

const style = compileGridStyle({
  name: 'Feature Test',
  tempo: 120,
  tracks: { bass: { type: 'bass', channel: 2, program: 33 }, keys: { type: 'chord', channel: 3, program: 4 } },
  sections: { main_a: { drums: { kick: 'X...X...X...X...' }, bass: '1---------------', keys: 'x---------------' } },
});

const cc = (evs: MidiEvent[], num: number) => evs.filter((e) => (e.data[0]! & 0xf0) === 0xb0 && e.data[1] === num);
const ons = (evs: MidiEvent[]) => evs.filter((e) => (e.data[0]! & 0xf0) === 0x90 && e.data[2]! > 0);

describe('chord modes', () => {
  const name = (notes: number[], mode: Parameters<typeof detectChordWithMode>[1]) => detectChordWithMode(notes, mode)?.name;

  it('single finger: one key major, black key left minor, white key left 7th, both m7', () => {
    expect(name([48], 'single')).toBe('C');
    expect(name([46, 48], 'single')).toBe('Cm'); // Bb (black) to the left of C
    expect(name([47, 48], 'single')).toBe('C7'); // B (white) to the left of C
    expect(name([46, 47, 48], 'single')).toBe('Cm7');
  });

  it('multi finger: full chords read as fingered, one or two keys as single finger', () => {
    expect(name([45, 48, 52], 'multi')).toBe('Am'); // a full A minor chord
    expect(name([48, 52, 55, 58], 'multi')).toBe('C7');
    expect(name([46, 48], 'multi')).toBe('Cm'); // single-finger minor
    expect(name([43], 'multi')).toBe('G');
  });

  it('fingered ignores single-finger meaning', () => {
    expect(name([47, 48], 'fingered')).not.toBe('C7');
  });
});

describe('synchro stop', () => {
  it('stops when every left-hand key is released, and restarts on the next chord', () => {
    const e = new ArrangerEngine(style, { syncStop: true });
    e.input([0x90, 48, 90], 0);
    e.tick(30);
    expect(e.status(30).running).toBe(true);
    e.input([0x80, 48, 0], 500);
    expect(e.status(500).running).toBe(false);
    e.input([0x90, 43, 90], 900);
    e.tick(930);
    expect(e.status(930)).toMatchObject({ running: true, chord: 'G' });
  });

  it('keeps playing when synchro stop is off (chord memory)', () => {
    const e = new ArrangerEngine(style);
    e.input([0x90, 48, 90], 0);
    e.tick(30);
    e.input([0x80, 48, 0], 500);
    expect(e.status(500).running).toBe(true);
  });
});

describe('fade in / fade out', () => {
  it('fade in starts silent and rises to full expression', () => {
    const e = new ArrangerEngine(style, { fadeMs: 1000 });
    e.tick(0);
    e.command({ type: 'fadeIn' }, 100);
    const evs: MidiEvent[] = [];
    for (let t = 110; t <= 1300; t += 10) evs.push(...e.tick(t));
    const expr = cc(evs, 11).filter((x) => (x.data[0]! & 0x0f) === 9).map((x) => x.data[2]!);
    expect(expr[0]).toBe(0);
    expect(expr.at(-1)).toBe(127);
    expect([...expr].sort((a, b) => a - b)).toEqual(expr); // never goes down
    expect(e.status(1300).fading).toBeNull();
  });

  it('fade out lowers expression, then stops and restores full expression', () => {
    const e = new ArrangerEngine(style, { fadeMs: 1000 });
    e.command({ type: 'start' }, 0);
    e.tick(0);
    e.command({ type: 'fadeOut' }, 500);
    const evs: MidiEvent[] = [];
    for (let t = 510; t <= 1700; t += 10) evs.push(...e.tick(t));
    expect(e.status(1700).running).toBe(false);
    const expr = cc(evs, 11).filter((x) => (x.data[0]! & 0x0f) === 9).map((x) => x.data[2]!);
    expect(Math.min(...expr)).toBeLessThanOrEqual(5);
    expect(expr.at(-1)).toBe(127);
  });
});

describe('mixer and voices', () => {
  it('sets a part volume (CC7 on its channel) and reports it', () => {
    const e = new ArrangerEngine(style);
    e.tick(0);
    e.command({ type: 'partVolume', part: 'bass', volume: 64 }, 10);
    const evs = cc(e.tick(20), 7);
    expect(evs).toEqual([{ t: 10, data: [0xb0 | 10, 7, 64] }]); // bass is on channel 11
    expect(e.status(20).parts.find((p) => p.id === 'bass')?.volume).toBe(64);
  });

  it('changes the right-hand voice with a program change on channel 1', () => {
    const e = new ArrangerEngine(style);
    e.tick(0);
    e.command({ type: 'voice', slot: 'right', program: 65 }, 10);
    const evs = e.tick(20);
    expect(evs.some((x) => x.data[0] === 0xc0 && x.data[1] === 65)).toBe(true);
    expect(e.status(20).voices.right.program).toBe(65);
  });

  it('sets every voice up when created', () => {
    const evs = new ArrangerEngine(style).tick(0);
    const programs = evs.filter((x) => (x.data[0]! & 0xf0) === 0xc0).map((x) => [(x.data[0]! & 0x0f) + 1, x.data[1]]);
    expect(programs).toEqual(expect.arrayContaining([[1, 0], [2, 48], [3, 0]]));
    expect(ons(evs)).toEqual([]);
  });

  it('names all 128 GM voices', () => {
    expect(GM_VOICES).toHaveLength(128);
    expect(gmName(0)).toBe('Acoustic Grand Piano');
    expect(gmName(65)).toBe('Alto Sax');
  });
});
