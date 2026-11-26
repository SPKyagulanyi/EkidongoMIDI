import { describe, expect, it } from 'vitest';
import { importYamahaStyle, parseCasm, validateStyle } from '../src/index.ts';

/** A tiny hand-built SFF2-style file: setup, Main A (1 bar) and Fill In AA (1 bar), plus CASM. */
function fixture(): Uint8Array {
  const vlq = (n: number) => {
    const out = [n & 0x7f];
    while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
    return out;
  };
  const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const meta = (type: number, data: number[]) => [0xff, type, data.length, ...data];
  const ppq = 480;
  const bar = ppq * 4;
  const track = [
    ...vlq(0), ...meta(0x58, [4, 2, 24, 8]),
    ...vlq(0), ...meta(0x51, [0x07, 0xa1, 0x20]), // 500000 us = 120 BPM
    ...vlq(0), ...meta(0x06, text('SFF2')),
    ...vlq(0), ...meta(0x06, text('SInt')),
    ...vlq(0), 0xca, 33, // bass program on channel 11
    ...vlq(0), 0xba, 7, 90, // bass volume
    ...vlq(bar), ...meta(0x06, text('Main A')),
    ...vlq(0), 0x99, 36, 100, // kick, channel 10
    ...vlq(0), 0x9a, 36, 90, // bass C2, channel 11
    ...vlq(240), 0x89, 36, 0,
    ...vlq(240), 0x8a, 36, 0,
    ...vlq(bar - 480), ...meta(0x06, text('Fill In AA')),
    ...vlq(0), 0x99, 38, 110, // snare
    ...vlq(120), 0x89, 38, 0,
    ...vlq(bar - 120), 0xff, 0x2f, 0x00,
  ];
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (id: string, body: number[]) => [...text(id), ...u32(body.length), ...body];
  const ctb2 = (src: number, name: string, ntr: number, ntt: number) => {
    const e = new Array(47).fill(0);
    e[0] = src; text(name.padEnd(8)).forEach((c, i) => (e[1 + i] = c)); e[9] = src; e[10] = 1;
    e[18] = 0; e[19] = 2; e[20] = 0; e[21] = 0x7f; // C maj7, middle range covers everything
    e[28] = ntr; e[29] = ntt; e[31] = 0; e[32] = 0x7f;
    return chunk('Ctb2', e);
  };
  const cseg = chunk('CSEG', [...chunk('Sdec', text('Main A,Fill In AA')), ...ctb2(9, 'Drums', 1, 0), ...ctb2(10, 'Bass', 0, 0x81)]);
  return new Uint8Array([
    ...chunk('MThd', [0, 0, 0, 1, (ppq >> 8) & 255, ppq & 255]),
    ...chunk('MTrk', track),
    ...chunk('CASM', cseg),
  ]);
}

describe('Yamaha style import', () => {
  it('reads the CASM part rules', () => {
    const rules = parseCasm(fixture()).get('Main A')!;
    expect(rules.map((r) => [r.dest, r.name, r.ntr, r.ntt, r.bassFlag])).toEqual([[9, 'Drums', 1, 0, false], [10, 'Bass', 0, 1, true]]);
  });

  it('imports sections, parts, rules, instrument setup and notes as a valid style', () => {
    const { style, format, warnings } = importYamahaStyle(fixture(), 'Test Groove.prs');
    expect(format).toBe('SFF2');
    expect(validateStyle(style).ok).toBe(true);
    expect(style).toMatchObject({ id: 'test-groove-yamaha', name: 'Test Groove', category: 'Yamaha (yours)', tempo: 120, timeSignature: [4, 4] });
    expect(style.parts.map((p) => [p.id, p.role, p.channel, p.program, p.ntr, p.ntt])).toEqual([
      ['drums', 'drums', 10, 0, 'root-transpose', 'bypass'],
      ['bass', 'bass', 11, 33, 'root-transpose', 'bass'],
    ]);
    expect(style.parts[1]?.volume).toBe(90);
    expect(style.sections.mainA).toEqual({
      bars: 1,
      phrases: { drums: [{ t: 0, n: 36, v: 100, d: 240 }], bass: [{ t: 0, n: 36, v: 90, d: 480 }] },
    });
    expect(style.sections.fillA?.phrases.drums).toEqual([{ t: 0, n: 38, v: 110, d: 120 }]);
    expect(style.license).toMatch(/personal use only/);
    expect(warnings.join(' ')).toMatch(/General MIDI/);
  });

  it('rejects files with no main section', () => {
    const bytes = fixture();
    // Rename every "Main A" (marker and CASM) to "Xain A".
    const pattern = [...'Main A'].map((c) => c.charCodeAt(0));
    for (let i = 0; i + pattern.length <= bytes.length; i++) {
      if (pattern.every((c, k) => bytes[i + k] === c)) bytes[i] = 'X'.charCodeAt(0);
    }
    expect(() => importYamahaStyle(bytes, 'x.sty')).toThrow(/no Main sections/);
  });
});
