/**
 * StylePlayer: renders a style into timestamped MIDI events for a time window.
 *
 * Clock-agnostic: every call takes `now` / a horizon in ms on the caller's clock, and every returned
 * event carries an absolute time on that clock. The platform sends them with those timestamps.
 *
 * Invariants (tested): every note-on gets exactly one note-off; stop() silences everything it started.
 */
import { makeChord, type Chord } from '../chords.ts';
import { barTicks, type NoteEvent, type Part, type SectionId, type Style } from '../style/schema.ts';
import { Arrangement, type ArrangementSnapshot } from './arrangement.ts';
import { repitchNote, type SourceChord } from './repitch.ts';

export interface MidiEvent {
  /** Absolute time in ms on the caller's clock. */
  t: number;
  data: number[];
}

interface Sounding {
  ch: number;
  note: number;
  /** When its note-on is (or was) sent; may be in the lookahead future. */
  onAt: number;
  offAt: number;
  part: Part;
  srcNote: number;
  vel: number;
}

/** Sustained notes with less than this left are not re-pitched on a chord change. */
const RETRIGGER_MIN_MS = 120;

export class StylePlayer {
  readonly arrangement: Arrangement;
  private readonly parts: Map<string, Part>;
  private readonly src: SourceChord;
  private chord: Chord = makeChord(0, '');
  private tempo: number;
  private running = false;
  private barStart = 0;
  private renderedUntil = 0;
  private sounding: Sounding[] = [];
  private immediate: MidiEvent[] = [];
  private readonly muted = new Set<string>();
  readonly style: Style;

  constructor(style: Style) {
    this.style = style;
    this.parts = new Map(style.parts.map((p) => [p.id, p]));
    const q = makeChord(style.sourceChord.root, style.sourceChord.quality);
    this.src = { root: q.root, intervals: q.intervals };
    this.tempo = style.tempo;
    this.arrangement = new Arrangement(new Set(Object.keys(style.sections) as SectionId[]));
  }

  get isRunning(): boolean {
    return this.running;
  }
  get currentChord(): Chord {
    return this.chord;
  }
  get bpm(): number {
    return this.tempo;
  }
  private get msPerTick(): number {
    return 60000 / (this.tempo * this.style.ppq);
  }
  /** Ticks to ms with one division, so whole-number results stay exact. */
  private ms(ticks: number): number {
    return (ticks * 60000) / (this.tempo * this.style.ppq);
  }
  private get barLen(): number {
    return barTicks(this.style);
  }

  /** Bank, program and mixer messages for every part, to send when the style is loaded. */
  setupEvents(t: number): MidiEvent[] {
    const out: MidiEvent[] = [];
    for (const p of this.style.parts) {
      const cc = 0xb0 | (p.channel - 1);
      out.push(
        { t, data: [cc, 0, p.bankMsb] },
        { t, data: [cc, 32, p.bankLsb] },
        { t, data: [0xc0 | (p.channel - 1), p.program] },
        { t, data: [cc, 7, p.volume] },
        { t, data: [cc, 10, p.pan] },
        { t, data: [cc, 91, p.reverb] },
        { t, data: [cc, 93, p.chorus] },
      );
    }
    return out;
  }

  setTempo(bpm: number, now: number): void {
    const clamped = Math.max(20, Math.min(400, bpm));
    if (this.running) {
      const pos = (now - this.barStart) / this.msPerTick;
      this.tempo = clamped;
      this.barStart = now - this.ms(pos);
    } else this.tempo = clamped;
  }

  /**
   * Change chord. Sustained notes are re-pitched from `now`; notes already queued in the lookahead
   * are re-pitched 1 ms after they start (their note-on is already with the platform, so the swap
   * must come after it, or the old note would never get its note-off).
   */
  setChord(chord: Chord, now: number): void {
    this.chord = chord;
    if (!this.running) return;
    for (const s of [...this.sounding]) {
      if (!this.sounding.includes(s)) continue; // already ended by an earlier swap in this loop
      const at = Math.max(now, s.onAt + 1);
      if (s.part.role === 'drums' || s.offAt - at < RETRIGGER_MIN_MS) continue;
      const n = repitchNote(s.srcNote, s.part, this.src, chord);
      if (n === s.note) continue;
      this.immediate.push({ t: at, data: [0x80 | s.ch, s.note, 0] });
      this.endSame(s.ch, n, at, this.immediate, s);
      this.immediate.push({ t: at, data: [0x90 | s.ch, n, s.vel] });
      s.note = n;
      s.onAt = at;
    }
  }

  setMuted(partId: string, muted: boolean, now: number): void {
    if (muted) {
      this.muted.add(partId);
      this.sounding = this.sounding.filter((s) => {
        if (s.part.id !== partId) return true;
        this.immediate.push({ t: now, data: [0x80 | s.ch, s.note, 0] });
        return false;
      });
    } else this.muted.delete(partId);
  }

  isMuted(partId: string): boolean {
    return this.muted.has(partId);
  }

  /** Start on a given section at time `at` (recording, auditioning). */
  startSection(at: number, section: SectionId): void {
    if (this.running) return;
    this.arrangement.startSection(section);
    this.running = true;
    this.barStart = at;
    this.renderedUntil = at;
  }

  start(now: number, intro?: 'intro1' | 'intro2' | 'intro3'): void {
    if (this.running) return;
    this.arrangement.start(intro);
    this.running = true;
    this.barStart = now;
    this.renderedUntil = now;
  }

  /** Stop now: note-offs for everything sounding plus All Notes Off on every style channel. */
  stop(now: number): MidiEvent[] {
    const out = this.immediate.splice(0);
    for (const s of this.sounding) out.push({ t: now, data: [0x80 | s.ch, s.note, 0] });
    this.sounding = [];
    for (const p of this.style.parts) out.push({ t: now, data: [0xb0 | (p.channel - 1), 123, 0] });
    if (this.running) this.arrangement.stop();
    this.running = false;
    return out;
  }

  /** Position for the UI: bar start time and beat within the bar. */
  position(now: number): { beat: number; beatsPerBar: number; snapshot: ArrangementSnapshot } {
    const [num, den] = this.style.timeSignature;
    const beatsPerBar = den === 8 && num % 3 === 0 ? num / 3 : num;
    const beatMs = this.ms(this.barLen) / beatsPerBar;
    const beat = this.running ? Math.max(0, Math.floor((now - this.barStart) / beatMs)) % beatsPerBar : -1;
    return { beat, beatsPerBar, snapshot: this.arrangement.snapshot() };
  }

  /** All events from the last render up to `horizon` (ms), sorted by time. */
  render(horizon: number): MidiEvent[] {
    const out = this.immediate.splice(0);
    while (this.running) {
      const barEnd = this.barStart + this.ms(this.barLen);
      const to = Math.min(horizon, barEnd);
      if (to > this.renderedUntil) {
        this.renderBar(this.renderedUntil, to, out);
        this.renderedUntil = to;
      }
      if (horizon < barEnd) break;
      const next = this.arrangement.nextBar((s) => this.style.sections[s]?.bars ?? 1);
      this.barStart = barEnd;
      if (!next) this.running = false;
    }
    this.flushOffs(horizon, out);
    return out.sort((a, b) => a.t - b.t || offFirst(a, b));
  }

  private swingTicks(tick: number): number {
    const swing = this.style.swing;
    if (!swing || this.style.timeSignature[1] !== 4) return 0;
    const sixteenth = this.style.ppq / 4;
    return tick % (2 * sixteenth) === sixteenth ? swing * sixteenth : 0;
  }

  private renderBar(from: number, to: number, out: MidiEvent[]): void {
    const snap = this.arrangement.snapshot();
    const sec = this.style.sections[snap.section];
    if (!sec) return;
    const bar = snap.barInSection % sec.bars;
    const lo = bar * this.barLen;
    const hi = lo + this.barLen;
    for (const [partId, events] of Object.entries(sec.phrases)) {
      const part = this.parts.get(partId);
      if (!part || this.muted.has(partId)) continue;
      for (const e of events) {
        if (e.t < lo || e.t >= hi) continue;
        const time = this.barStart + this.ms(e.t - lo + this.swingTicks(e.t));
        if (time < from || time >= to) continue;
        this.play(part, e, time, out);
      }
    }
  }

  private play(part: Part, e: NoteEvent, time: number, out: MidiEvent[]): void {
    const note = part.role === 'drums' ? e.n : repitchNote(e.n, part, this.src, this.chord);
    const ch = part.channel - 1;
    // Two source notes can land on one pitch (e.g. a missing 7th doubles the root): merge them.
    const twin = this.sounding.find((s) => s.ch === ch && s.note === note && s.onAt === time);
    if (twin) {
      twin.offAt = Math.max(twin.offAt, time + this.ms(e.d));
      return;
    }
    this.endSame(ch, note, time, out);
    out.push({ t: time, data: [0x90 | ch, note, e.v] });
    this.sounding.push({ ch, note, onAt: time, offAt: time + this.ms(e.d), part, srcNote: e.n, vel: e.v });
  }

  /** End an earlier copy of the same channel+note so it never overlaps (which would leave it stuck). */
  private endSame(ch: number, note: number, time: number, out: MidiEvent[], except?: Sounding): void {
    this.sounding = this.sounding.filter((s) => {
      if (s === except || s.ch !== ch || s.note !== note) return true;
      // Never before (or at) its own note-on, which may be a retrigger queued slightly ahead.
      out.push({ t: Math.max(s.onAt + 0.5, Math.min(s.offAt, time)), data: [0x80 | ch, note, 0] });
      return false;
    });
  }

  private flushOffs(horizon: number, out: MidiEvent[]): void {
    this.sounding = this.sounding.filter((s) => {
      if (s.offAt >= horizon) return true;
      out.push({ t: s.offAt, data: [0x80 | s.ch, s.note, 0] });
      return false;
    });
  }
}

/** At equal times, note-offs go before note-ons so a repeated note is re-struck, not cut. */
function offFirst(a: MidiEvent, b: MidiEvent): number {
  const ka = (a.data[0] ?? 0) & 0xf0;
  const kb = (b.data[0] ?? 0) & 0xf0;
  return (ka === 0x80 ? 0 : 1) - (kb === 0x80 ? 0 : 1);
}
