import { describe, expect, it } from 'vitest';
import { compileGridStyle, validateStyle, type GridStyle } from '../src/index.ts';

const pop: GridStyle = {
  name: 'Mini Pop',
  tempo: 100,
  steps: 16,
  beats: 4,
  tracks: {
    bass: { type: 'bass', channel: 2, program: 33, velocity: 95 },
    gtr: { type: 'chord', channel: 3, program: 27, center: 62, velocity: 80 },
  },
  sections: {
    main_a: { drums: { kick: 'X.......X.......' }, bass: '1---..5-', gtr: 'x-.x............' },
    fill: { drums: { snare: '....x.x.xxxxXXXX' }, bass: '1---------------' },
  },
};

describe('compileGridStyle', () => {
  const style = compileGridStyle(pop);

  it('produces a valid v1 style', () => {
    const r = validateStyle(style);
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it('maps sections and channels into the style range', () => {
    expect(Object.keys(style.sections).sort()).toEqual(['fillA', 'fillB', 'mainA']);
    expect(style.parts.map((p) => [p.id, p.channel])).toEqual([['drums', 10], ['bass', 11], ['gtr', 12]]);
  });

  it('turns steps into ticks (120 ticks per 16th in 4/4)', () => {
    const kick = style.sections.mainA?.phrases.drums ?? [];
    expect(kick.map((e) => e.t)).toEqual([0, 960]);
    expect(kick[0]?.v).toBe(118);
  });

  it('holds notes over "-" and writes bass over the C source root', () => {
    const bass = style.sections.mainA?.phrases.bass ?? [];
    expect(bass).toEqual([
      { t: 0, n: 36, v: 95, d: 480 },
      { t: 720, n: 43, v: 95, d: 240 },
    ]);
  });

  it('strums the full C major 7 source voicing', () => {
    const gtr = style.sections.mainA?.phrases.gtr ?? [];
    expect(gtr.filter((e) => e.t === 0).map((e) => e.n)).toEqual([59, 60, 64, 67]);
    expect(gtr.filter((e) => e.t === 0).every((e) => e.d === 240)).toBe(true);
  });

  it('converts a 12/8 grid to quarter-note tempo', () => {
    const gospel = compileGridStyle({ ...pop, name: 'Slow 12', tempo: 66, steps: 12, beats: 4,
      sections: { main_a: { drums: { kick: 'X.....X.....' } } } });
    expect(gospel.timeSignature).toEqual([12, 8]);
    expect(gospel.tempo).toBe(99);
    expect(gospel.sections.mainA?.phrases.drums?.map((e) => e.t)).toEqual([0, 1440]);
  });

  it('rejects unknown drums', () => {
    expect(() => compileGridStyle({ ...pop, sections: { main_a: { drums: { cymbalz: 'x' } } } })).toThrow(/unknown drum/);
  });
});
