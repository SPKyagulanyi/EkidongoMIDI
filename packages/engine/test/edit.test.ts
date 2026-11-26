import { describe, expect, it } from 'vitest';
import {
  addPart, ArrangerEngine, captureToPhrase, emptyStyle, phraseFromMidi, quantize, setSectionBars,
  validateStyle, writePhrase, type MidiEvent,
} from '../src/index.ts';

const base = () => emptyStyle({ id: 'My Groove', name: 'My Groove', tempo: 120, timeSignature: [4, 4] });

describe('style editing', () => {
  it('creates a valid empty style', () => {
    const s = base();
    expect(s.id).toBe('my-groove');
    expect(validateStyle(s).ok).toBe(true);
  });

  it('adds parts on free channels with role-appropriate rules', () => {
    let { style, partId } = addPart(base(), { name: 'Bass', role: 'bass', program: 33 });
    expect(partId).toBe('bass');
    expect(style.parts.find((p) => p.id === 'bass')).toMatchObject({ channel: 11, ntr: 'root-fixed', ntt: 'bass' });
    ({ style, partId } = addPart(style, { name: 'Bass', role: 'chord', program: 27 }));
    expect(partId).toBe('bass-2');
    expect(style.parts.at(-1)?.channel).toBe(12);
    expect(() => addPart(style, { name: 'Kit', role: 'drums', program: 0 })).toThrow(/already has a drum part/);
    expect(validateStyle(style).ok).toBe(true);
  });

  it('never changes the input style', () => {
    const s = base();
    const before = JSON.stringify(s);
    addPart(s, { name: 'Bass', role: 'bass', program: 33 });
    setSectionBars(s, 'mainB', 4);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('writes phrases: replace, add, and drops notes past the section end', () => {
    const { style } = addPart(base(), { name: 'Bass', role: 'bass', program: 33 });
    let s = writePhrase(style, 'mainA', 'bass', [{ t: 0, n: 36, v: 90, d: 240 }, { t: 9999, n: 40, v: 90, d: 10 }], 'replace');
    expect(s.sections.mainA!.phrases.bass).toEqual([{ t: 0, n: 36, v: 90, d: 240 }]);
    s = writePhrase(s, 'mainA', 'bass', [{ t: 960, n: 43, v: 80, d: 240 }], 'add');
    expect(s.sections.mainA!.phrases.bass!.map((e) => e.n)).toEqual([36, 43]);
    s = writePhrase(s, 'mainA', 'bass', [{ t: 480, n: 38, v: 80, d: 240 }], 'replace');
    expect(s.sections.mainA!.phrases.bass!.map((e) => e.n)).toEqual([38]);
    expect(() => writePhrase(s, 'mainB', 'bass', [], 'replace')).toThrow(/no mainB/);
  });

  it('resizes and creates sections', () => {
    let s = writePhrase(base(), 'mainA', 'drums', [{ t: 0, n: 36, v: 100, d: 60 }, { t: 1920, n: 38, v: 100, d: 60 }], 'replace');
    s = setSectionBars(s, 'mainA', 1);
    expect(s.sections.mainA!.phrases.drums!.map((e) => e.t)).toEqual([0]);
    s = setSectionBars(s, 'fillA', 1);
    expect(s.sections.fillA).toEqual({ bars: 1, phrases: {} });
  });
});

describe('captureToPhrase', () => {
  // 120 BPM: 1 tick = 60000 / (120 * 480) ms; a quarter note = 500 ms
  const msg = (t: number, data: number[]) => ({ t, data });

  it('pairs notes, converts ms to ticks and keeps the played timing', () => {
    const evs = captureToPhrase([
      msg(1000, [0x90, 60, 100]), msg(1490, [0x80, 60, 0]),
      msg(1510, [0x90, 64, 80]), msg(1750, [0x90, 64, 0]),
    ], { startMs: 1000, tempo: 120, lengthTicks: 1920 });
    expect(evs).toEqual([
      { t: 0, n: 60, v: 100, d: 470 },
      { t: 490, n: 64, v: 80, d: 230 },
    ]);
  });

  it('counts slightly early notes as beat 1, drops earlier ones, and closes held notes at the end', () => {
    const evs = captureToPhrase([
      msg(800, [0x90, 50, 90]), msg(850, [0x80, 50, 0]), // well before the start: ignored
      msg(970, [0x90, 36, 90]), msg(1200, [0x80, 36, 0]), // 30 ms early: beat 1
      msg(1800, [0x90, 48, 70]), // never released
    ], { startMs: 1000, tempo: 120, lengthTicks: 1920 });
    expect(evs).toEqual([
      { t: 0, n: 36, v: 90, d: 192 },
      { t: 768, n: 48, v: 70, d: 1152 },
    ]);
  });

  it('round-trips through the engine: a recorded part plays back at the same times', () => {
    const { style } = addPart(base(), { name: 'Keys', role: 'chord', program: 4 });
    const played = [msg(0, [0x90, 60, 90]), msg(400, [0x80, 60, 0]), msg(1000, [0x90, 64, 90]), msg(1400, [0x80, 64, 0])];
    const s = writePhrase(style, 'mainA', 'keys', captureToPhrase(played, { startMs: 0, tempo: 120, lengthTicks: 3840 }), 'replace');
    const eng = new ArrangerEngine(s);
    eng.command({ type: 'loop', section: 'mainA', at: 5000 }, 0);
    const evs: MidiEvent[] = [];
    for (let t = 0; t < 7000; t += 10) evs.push(...eng.tick(t));
    const ons = evs.filter((e) => (e.data[0]! & 0xf0) === 0x90 && e.data[2]! > 0 && (e.data[0]! & 0x0f) === 10); // channel 11
    expect(ons.map((e) => [Math.round(e.t), e.data[1]])).toEqual([[5000, 60], [6000, 64]]);
  });
});

describe('quantize', () => {
  const evs = [{ t: 130, n: 1, v: 1, d: 1 }, { t: 350, n: 2, v: 1, d: 1 }];
  it('snaps fully to the grid, or partly with strength', () => {
    expect(quantize(evs, 120).map((e) => e.t)).toEqual([120, 360]);
    expect(quantize(evs, 120, 0.5).map((e) => e.t)).toEqual([125, 355]);
    expect(quantize(evs, 0).map((e) => e.t)).toEqual([130, 350]);
  });
});

describe('loop command', () => {
  it('repeats one section and ignores panel requests until unloop', () => {
    let s = setSectionBars(base(), 'fillA', 1);
    s = writePhrase(s, 'fillA', 'drums', [{ t: 0, n: 38, v: 100, d: 60 }], 'replace');
    const eng = new ArrangerEngine(s);
    eng.command({ type: 'loop', section: 'fillA' }, 0);
    eng.command({ type: 'main', id: 'mainA' }, 0);
    const evs: MidiEvent[] = [];
    for (let t = 0; t < 6000; t += 10) evs.push(...eng.tick(t));
    const snares = evs.filter((e) => e.data[0] === 0x99 && e.data[1] === 38 && e.t < 6000).map((e) => e.t);
    expect(snares).toEqual([0, 2000, 4000]);
    expect(eng.status(6000).section).toBe('fillA');
  });
});

describe('phraseFromMidi', () => {
  it('takes one channel, rescales ticks and cuts the chosen bars', () => {
    const notes = [
      { tick: 0, duration: 96, channel: 1, note: 40, velocity: 90 },
      { tick: 384, duration: 96, channel: 1, note: 43, velocity: 90 }, // bar 1 at 96 ppq (bar = 384)
      { tick: 384, duration: 96, channel: 9, note: 36, velocity: 90 },
    ];
    expect(phraseFromMidi(notes, { ppq: 96, channel: 1, fromBar: 1, bars: 1, barTicks: 1920 })).toEqual([{ t: 0, n: 43, v: 90, d: 480 }]);
  });
});
