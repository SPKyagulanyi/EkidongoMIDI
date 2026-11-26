import { describe, expect, it } from 'vitest';
import { barTicks, validateStyle } from '../src/index.ts';

function minimalStyle(): Record<string, unknown> {
  return {
    format: 'ekidongo-style',
    schemaVersion: 1,
    id: 'test-style',
    name: 'Test Style',
    category: 'test',
    tempo: 100,
    timeSignature: [4, 4],
    ppq: 480,
    status: 'prototype',
    license: 'All rights reserved',
    parts: [
      { id: 'drums', name: 'Drums', role: 'drums', channel: 10, program: 0 },
      { id: 'bass', name: 'Bass', role: 'bass', channel: 11, program: 33, ntr: 'root-fixed', ntt: 'bass' },
    ],
    sections: {
      mainA: {
        bars: 1,
        phrases: {
          drums: [{ t: 0, n: 36, v: 100, d: 60 }],
          bass: [{ t: 0, n: 36, v: 90, d: 480 }],
        },
      },
    },
  };
}

describe('style schema v1', () => {
  it('accepts a minimal valid style and fills defaults', () => {
    const r = validateStyle(minimalStyle());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.style.swing).toBe(0);
    expect(r.style.sourceChord).toEqual({ root: 0, quality: 'maj7' });
    expect(r.style.parts[0]?.volume).toBe(100);
  });

  const broken: [string, (s: Record<string, unknown>) => void, RegExp][] = [
    ['drums off channel 10', (s) => { (s.parts as { channel: number }[])[0]!.channel = 9; }, /drums must use channel 10/],
    ['melodic part on channel 10', (s) => { (s.parts as { channel: number }[])[1]!.channel = 10; }, /channel 10 is for drums only|used twice/],
    ['player channel used by a part', (s) => { (s.parts as { channel: number }[])[1]!.channel = 1; }, /channels 9-16/],
    ['no mainA', (s) => { s.sections = { mainB: (s.sections as { mainA: unknown }).mainA }; }, /mainA/],
    ['phrase for unknown part', (s) => {
      (s.sections as { mainA: { phrases: Record<string, unknown> } }).mainA.phrases.guitar = [];
    }, /unknown part "guitar"/],
    ['event after the section end', (s) => {
      (s.sections as { mainA: { phrases: { bass: unknown[] } } }).mainA.phrases.bass = [{ t: 1920, n: 36, v: 90, d: 10 }];
    }, /after the section ends/],
    ['bad velocity', (s) => {
      (s.sections as { mainA: { phrases: { bass: unknown[] } } }).mainA.phrases.bass = [{ t: 0, n: 36, v: 0, d: 10 }];
    }, /v/],
    ['unknown source chord quality', (s) => { s.sourceChord = { root: 0, quality: 'weird' }; }, /unknown chord quality/],
    ['wrong format tag', (s) => { s.format = 'yamaha'; }, /format/],
  ];

  it.each(broken)('rejects: %s', (_name, mutate, message) => {
    const s = minimalStyle();
    mutate(s);
    const r = validateStyle(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(message);
  });

  it('computes bar length in ticks', () => {
    expect(barTicks({ ppq: 480, timeSignature: [4, 4] })).toBe(1920);
    expect(barTicks({ ppq: 480, timeSignature: [3, 4] })).toBe(1440);
    expect(barTicks({ ppq: 480, timeSignature: [12, 8] })).toBe(2880);
  });
});
