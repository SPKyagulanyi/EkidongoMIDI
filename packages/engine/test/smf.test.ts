import { describe, expect, it } from 'vitest';
import { parseSmf, smfBpm } from '../src/index.ts';

/** Build a small format-1 file by hand: tempo 100 BPM, 4/4, two notes (one via running status). */
function fixture(): Uint8Array {
  const vlq = (n: number) => {
    const out = [n & 0x7f];
    while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
    return out;
  };
  const track = [
    ...vlq(0), 0xff, 0x51, 0x03, 0x09, 0x27, 0xc0, // 600000 us = 100 BPM
    ...vlq(0), 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08, // 4/4
    ...vlq(0), 0x99, 36, 110, // kick on, channel 10
    ...vlq(240), 38, 90, // snare on via running status
    ...vlq(240), 0x89, 36, 0, // kick off (note-off)
    ...vlq(0), 0x99, 38, 0, // snare off (note-on velocity 0)
    ...vlq(0), 0xff, 0x2f, 0x00,
  ];
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return new Uint8Array([
    ...[...'MThd'].map((c) => c.charCodeAt(0)), ...u32(6), 0, 1, 0, 1, 0x01, 0xe0, // format 1, 1 track, 480 ppq
    ...[...'MTrk'].map((c) => c.charCodeAt(0)), ...u32(track.length), ...track,
  ]);
}

describe('parseSmf', () => {
  const f = parseSmf(fixture());

  it('reads header, tempo and meter', () => {
    expect(f.ppq).toBe(480);
    expect(smfBpm(f)).toBeCloseTo(100);
    expect(f.timeSignature).toEqual([4, 4]);
  });

  it('reads notes with running status, note-off and velocity-0 note-off', () => {
    expect(f.notes).toEqual([
      { tick: 0, duration: 480, channel: 9, note: 36, velocity: 110 },
      { tick: 240, duration: 240, channel: 9, note: 38, velocity: 90 },
    ]);
  });

  it('rejects non-MIDI data', () => {
    expect(() => parseSmf(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a MIDI file/);
  });
});
