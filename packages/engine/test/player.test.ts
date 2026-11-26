import { describe, expect, it } from 'vitest';
import { ArrangerEngine, compileGridStyle, makeChord, StylePlayer, type MidiEvent, type Style } from '../src/index.ts';

/** 120 BPM 4/4: one bar = 2000 ms, a 16th = 125 ms. */
const style: Style = compileGridStyle({
  name: 'Test Groove',
  tempo: 120,
  tracks: {
    bass: { type: 'bass', channel: 2, program: 33 },
    keys: { type: 'chord', channel: 3, program: 4, center: 62 },
  },
  sections: {
    main_a: { drums: { kick: 'X...X...X...X...' }, bass: '1-------5-------', keys: 'x---------------' },
    main_b: { drums: { kick: 'X.X.X.X.X.X.X.X.' }, bass: '1---------------' },
    fill: { drums: { snare: 'xxxxxxxxxxxxxxxx' } },
    ending: { drums: { crash: 'X...............' }, bass: '1---------------' },
  },
});

const ons = (evs: MidiEvent[]) => evs.filter((e) => (e.data[0]! & 0xf0) === 0x90 && e.data[2]! > 0);
const offs = (evs: MidiEvent[]) => evs.filter((e) => (e.data[0]! & 0xf0) === 0x80);
const ch = (e: MidiEvent) => (e.data[0]! & 0x0f) + 1;

describe('StylePlayer', () => {
  it('renders the first bar at the right times', () => {
    const p = new StylePlayer(style);
    p.start(1000);
    const evs = p.render(3000);
    const kicks = ons(evs).filter((e) => ch(e) === 10).map((e) => e.t);
    expect(kicks).toEqual([1000, 1500, 2000, 2500]);
    const bass = ons(evs).filter((e) => ch(e) === 11).map((e) => [e.t, e.data[1]]);
    expect(bass).toEqual([[1000, 36], [2000, 43]]);
  });

  it('renders in small windows exactly as in one big window', () => {
    const a = new StylePlayer(style);
    const b = new StylePlayer(style);
    a.start(0);
    b.start(0);
    const canon = (evs: MidiEvent[]) => evs.map((e) => `${e.t.toFixed(3)} ${e.data.join(',')}`).sort();
    const big = a.render(8000);
    const small: MidiEvent[] = [];
    for (let t = 10; t <= 8000; t += 10) small.push(...b.render(t));
    expect(canon(small)).toEqual(canon(big));
  });

  it('re-pitches new notes and sustained notes on a chord change', () => {
    const p = new StylePlayer(style);
    p.start(0);
    p.render(100);
    p.setChord(makeChord(9, 'm'), 500); // A minor while the keys chord is still sounding
    const evs = p.render(2100);
    const keysOn = ons(evs).filter((e) => ch(e) === 12).map((e) => e.data[1]).sort();
    expect(keysOn.length).toBeGreaterThan(0);
    expect(keysOn.every((n) => [9, 0, 4].includes(n! % 12))).toBe(true); // A, C, E only
  });

  it('switches Main at the bar line with a fill in between', () => {
    const p = new StylePlayer(style);
    p.start(0);
    p.render(500);
    p.arrangement.requestMain('mainB');
    const evs = p.render(6000);
    const snare = ons(evs).filter((e) => e.data[1] === 38).map((e) => e.t);
    expect(Math.min(...snare)).toBe(2000);
    expect(Math.max(...snare)).toBeLessThan(4000);
    const kicksBar3 = ons(evs).filter((e) => ch(e) === 10 && e.data[1] === 36 && e.t >= 4000 && e.t < 6000);
    expect(kicksBar3).toHaveLength(8); // Main B: 8th-note kicks
  });

  it('stops by itself after the ending', () => {
    const p = new StylePlayer(style);
    p.start(0);
    p.render(100);
    p.arrangement.requestEnding(1);
    p.render(10000);
    expect(p.isRunning).toBe(false);
  });

  it('applies swing to off-beat 16ths', () => {
    const swung = new StylePlayer({ ...style, swing: 0.2 });
    swung.start(0);
    const evs = swung.render(2000);
    // Main A's kicks fall on beats: no shift there
    expect(ons(evs).filter((e) => ch(e) === 10).map((e) => e.t)).toEqual([0, 500, 1000, 1500]);
    // the fill's off-beat 16th snares are delayed by 20% of a 16th (25 ms at 120 BPM)
    const f = new StylePlayer({ ...style, swing: 0.2 });
    f.start(0);
    f.render(100);
    f.arrangement.requestFill();
    const snares = ons(f.render(4000)).filter((e) => e.data[1] === 38).map((e) => e.t - 2000);
    expect(snares.slice(0, 4)).toEqual([0, 150, 250, 400]);
  });

  it.each([7, 42, 99, 1234, 2026])('never leaves a note stuck: random chords, sections, mutes, tempo, then stop (seed %i)', (start) => {
    let seed = start;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const p = new StylePlayer(style);
    const all: MidiEvent[] = [];
    p.start(0);
    for (let t = 10; t < 60000; t += 10) {
      const r = rand();
      if (r < 0.01) p.setChord(makeChord(Math.floor(rand() * 12), ['', 'm', '7', 'm7', 'sus4'][Math.floor(rand() * 5)]!), t);
      else if (r < 0.012) p.arrangement.requestMain(rand() < 0.5 ? 'mainA' : 'mainB');
      else if (r < 0.013) p.arrangement.requestFill();
      else if (r < 0.014) p.setMuted('keys', rand() < 0.5, t);
      else if (r < 0.015) p.setTempo(60 + rand() * 120, t);
      all.push(...p.render(t + 40));
    }
    all.push(...p.stop(60000));
    const balance = new Map<string, number>();
    for (const e of all) {
      const type = e.data[0]! & 0xf0;
      if (type !== 0x80 && type !== 0x90) continue;
      const key = `${e.data[0]! & 0x0f}:${e.data[1]}`;
      balance.set(key, (balance.get(key) ?? 0) + (type === 0x90 ? 1 : -1));
    }
    for (const [key, n] of balance) expect(n, key).toBeLessThanOrEqual(0);
    expect(ons(all).length).toBeGreaterThan(200); // 60 s of music actually played
    expect(offs(all).length).toBeGreaterThanOrEqual(ons(all).length);
  });

  it('sends program and mixer setup for every part', () => {
    const evs = new StylePlayer(style).setupEvents(0);
    const programs = evs.filter((e) => (e.data[0]! & 0xf0) === 0xc0).map((e) => [ch(e), e.data[1]]);
    expect(programs).toEqual([[10, 0], [11, 33], [12, 4]]);
  });
});

describe('ArrangerEngine', () => {
  it('starts on the first left-hand chord (sync start) and passes the right hand through', () => {
    const e = new ArrangerEngine(style);
    e.tick(0);
    const thru = e.input([0x90, 72, 100], 5);
    expect(thru).toEqual([{ t: 5, data: [0x90, 72, 100] }, ]);
    e.input([0x90, 45, 90], 10);
    e.input([0x90, 48, 90], 12);
    e.input([0x90, 52, 90], 14);
    e.tick(20);
    expect(e.status(20).running).toBe(false); // still gathering the rolled chord
    const evs = e.tick(40);
    const s = e.status(40);
    expect(s.running).toBe(true);
    expect(s.chord).toBe('Am');
    expect(ons(evs).length).toBeGreaterThan(0);
  });

  it('leaves the right hand to the platform when thruInEngine is off', () => {
    const e = new ArrangerEngine(style, { thruInEngine: false });
    expect(e.input([0x90, 72, 100], 0)).toEqual([]);
  });

  it('panic silences all 16 channels', () => {
    const e = new ArrangerEngine(style);
    e.command({ type: 'start' }, 0);
    e.tick(0);
    const evs = e.panic(100);
    const allOff = evs.filter((x) => (x.data[0]! & 0xf0) === 0xb0 && x.data[1] === 123);
    expect(new Set(allOff.map(ch)).size).toBe(16);
    expect(e.status(100).running).toBe(false);
  });

});
