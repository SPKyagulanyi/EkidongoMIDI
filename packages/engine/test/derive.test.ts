import { describe, expect, it } from 'vitest';
import { compileGridStyle, deriveMissingSections, SECTION_IDS, validateStyle } from '../src/index.ts';

const base = compileGridStyle({
  name: 'Derive Test',
  tempo: 120,
  tracks: { bass: { type: 'bass', channel: 2, program: 33 }, keys: { type: 'chord', channel: 3, program: 4 } },
  sections: {
    main_a: { drums: { kick: 'X...X...X...X...' }, bass: '1-------5-------', keys: 'x---------------' },
    main_b: { drums: { snare: '....X.......X...' }, bass: '1---------------' },
    fill: { drums: { tomL: '............XXXX' } },
    ending: { drums: { crash: 'X...............' } },
  },
});

describe('deriveMissingSections', () => {
  const d = deriveMissingSections(base);

  it('fills every panel section and stays valid', () => {
    expect(Object.keys(d.sections).sort()).toEqual([...SECTION_IDS].sort());
    const r = validateStyle(d);
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it('keeps sections the style already had, untouched', () => {
    expect(d.sections.mainA).toEqual(base.sections.mainA);
    expect(d.sections.ending1).toEqual(base.sections.ending1);
  });

  it('builds Main C from Main A drums plus Main B band, and Main D from both', () => {
    const drumsC = d.sections.mainC!.phrases.drums!.map((e) => e.n);
    expect(new Set(drumsC)).toEqual(new Set([36])); // A's kick, not B's snare
    expect(d.sections.mainC!.phrases.bass).toEqual(base.sections.mainB!.phrases.bass);
    const drumsD = new Set(d.sections.mainD!.phrases.drums!.map((e) => e.n));
    expect(drumsD).toEqual(new Set([36, 38]));
  });

  it('makes Break and Ending 2 beat-1 hits only', () => {
    for (const id of ['break', 'ending2'] as const) {
      const evs = Object.values(d.sections[id]!.phrases).flat();
      expect(evs.length).toBeGreaterThan(0);
      expect(evs.every((e) => e.t === 0 && e.d <= 480)).toBe(true);
    }
  });

  it('ends intros on a fill bar', () => {
    const intro2 = d.sections.intro2!;
    expect(intro2.bars).toBe(2);
    expect(intro2.phrases.drums!.some((e) => e.n === 45 && e.t >= 1920)).toBe(true); // fill tom in bar 2
  });

  it('credits the derived sections', () => {
    expect(d.credits.at(-1)?.role).toMatch(/mainC.*break.*intro1/);
  });

  it('does nothing to a style that has every section', () => {
    expect(deriveMissingSections(d)).toEqual(d);
  });
});
