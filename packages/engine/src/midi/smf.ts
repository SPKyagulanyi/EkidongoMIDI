/**
 * Minimal Standard MIDI File reader (formats 0 and 1): notes with absolute ticks, tempo and meter.
 * Pure and platform-free; used to import phrases and drum performances.
 */

export interface SmfNote {
  /** Absolute start in the file's ticks. */
  tick: number;
  /** Length in ticks (0 when the file never ends the note). */
  duration: number;
  channel: number; // 0-15
  note: number;
  velocity: number;
}

export interface SmfFile {
  format: number;
  ppq: number;
  /** Microseconds per quarter note at tick 0 (default 120 BPM). */
  tempoUsPerQuarter: number;
  timeSignature: [number, number] | null;
  notes: SmfNote[];
}

class Reader {
  pos = 0;
  private readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  get done() { return this.pos >= this.b.length; }
  u8(): number {
    if (this.pos >= this.b.length) throw new Error('unexpected end of MIDI data');
    return this.b[this.pos++]!;
  }
  u16(): number { return (this.u8() << 8) | this.u8(); }
  u32(): number { return ((this.u8() << 24) >>> 0) + (this.u8() << 16) + (this.u8() << 8) + this.u8(); }
  str(n: number): string { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8()); return s; }
  vlq(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const c = this.u8();
      v = (v << 7) | (c & 0x7f);
      if (!(c & 0x80)) return v;
    }
    throw new Error('variable-length number too long');
  }
  skip(n: number) { this.pos += n; }
}

export function parseSmf(bytes: Uint8Array): SmfFile {
  const r = new Reader(bytes);
  if (r.str(4) !== 'MThd') throw new Error('not a MIDI file (missing MThd)');
  const hlen = r.u32();
  const format = r.u16();
  const ntracks = r.u16();
  const division = r.u16();
  r.skip(hlen - 6);
  if (division & 0x8000) throw new Error('SMPTE time division is not supported');
  const out: SmfFile = { format, ppq: division, tempoUsPerQuarter: 500000, timeSignature: null, notes: [] };
  let tempoSeen = false;

  for (let t = 0; t < ntracks && !r.done; t++) {
    const id = r.str(4);
    const len = r.u32();
    const end = r.pos + len;
    if (id !== 'MTrk') { r.skip(len); continue; }
    let tick = 0;
    let running = 0;
    const open = new Map<number, SmfNote[]>(); // key channel*128+note -> stack
    while (r.pos < end) {
      tick += r.vlq();
      let status = r.u8();
      if (status < 0x80) { // running status
        r.pos--;
        status = running;
      } else if (status < 0xf0) running = status;
      if (status === 0xff) {
        const type = r.u8();
        const l = r.vlq();
        if (type === 0x51 && l === 3 && !tempoSeen) {
          out.tempoUsPerQuarter = (r.u8() << 16) | (r.u8() << 8) | r.u8();
          tempoSeen = true;
        } else if (type === 0x58 && l >= 2 && !out.timeSignature) {
          const num = r.u8();
          const den = 2 ** r.u8();
          out.timeSignature = [num, den];
          r.skip(l - 2);
        } else r.skip(l);
        continue;
      }
      if (status === 0xf0 || status === 0xf7) { r.skip(r.vlq()); continue; }
      const kind = status & 0xf0;
      const ch = status & 0x0f;
      const d1 = r.u8();
      const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : r.u8();
      if (kind === 0x90 && d2 > 0) {
        const n: SmfNote = { tick, duration: 0, channel: ch, note: d1, velocity: d2 };
        out.notes.push(n);
        const k = ch * 128 + d1;
        (open.get(k) ?? open.set(k, []).get(k)!).push(n);
      } else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) {
        const n = open.get(ch * 128 + d1)?.shift();
        if (n) n.duration = tick - n.tick;
      }
    }
    r.pos = end;
  }
  out.notes.sort((a, b) => a.tick - b.tick || a.note - b.note);
  return out;
}

/** Quarter-note BPM from the file's first tempo. */
export const smfBpm = (f: SmfFile): number => 60_000_000 / f.tempoUsPerQuarter;
