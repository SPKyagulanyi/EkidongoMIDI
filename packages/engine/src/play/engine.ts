/**
 * ArrangerEngine: the whole arranger behind one small API, for every platform.
 *
 *   engine.input(bytes, now)   - MIDI from the keyboard; returns pass-through events (right hand etc.)
 *   engine.command(cmd, now)   - panel buttons
 *   engine.tick(now)           - call every ~10 ms; returns events up to now + lookahead
 *   engine.status(now)         - what the screen shows
 *
 * The platform sends every returned event at its timestamp. Nothing here touches a clock or a port.
 */
import { detectChord, type Chord } from '../chords.ts';
import type { Style } from '../style/schema.ts';
import type { MainId } from './arrangement.ts';
import { StylePlayer, type MidiEvent } from './player.ts';

export interface EngineConfig {
  /** Keys below this note are the chord (left-hand) zone. */
  splitPoint: number;
  splitEnabled: boolean;
  /** Player channels (1-16). */
  rightChannel: number;
  layerChannel: number;
  leftChannel: number;
  layerOn: boolean;
  leftVoiceOn: boolean;
  syncStart: boolean;
  /** Set false when the platform passes the right hand through itself (desktop does, in Rust). */
  thruInEngine: boolean;
  lookaheadMs: number;
  /** Wait this long after a left-hand key so a rolled chord is read as one chord. */
  chordGatherMs: number;
}

export const DEFAULT_CONFIG: EngineConfig = {
  splitPoint: 54,
  splitEnabled: true,
  rightChannel: 1,
  layerChannel: 2,
  leftChannel: 3,
  layerOn: false,
  leftVoiceOn: false,
  syncStart: true,
  thruInEngine: true,
  lookaheadMs: 40,
  chordGatherMs: 20,
};

export type EngineCommand =
  /** Start now, or at a future time `at` (tap-tempo start lands on the next downbeat). */
  | { type: 'start'; at?: number }
  | { type: 'stop' }
  | { type: 'toggleStart' }
  | { type: 'main'; id: MainId }
  | { type: 'fill' }
  | { type: 'break' }
  | { type: 'intro'; n: 1 | 2 | 3 }
  | { type: 'ending'; n: 1 | 2 | 3 }
  | { type: 'tempo'; bpm: number }
  | { type: 'mute'; part: string; muted: boolean }
  /** Set the chord directly (on-screen chord pads, tests); same as playing it with the left hand. */
  | { type: 'chord'; chord: Chord }
  | { type: 'config'; config: Partial<EngineConfig> };

export interface EngineStatus {
  styleId: string;
  styleName: string;
  running: boolean;
  section: string;
  lastMain: string;
  queue: string[];
  chord: string;
  tempo: number;
  beat: number;
  beatsPerBar: number;
  /** Quarter notes per counted beat: 1 in 4/4 and 3/4, 1.5 in 6/8 and 12/8 (dotted-quarter beats). */
  quartersPerBeat: number;
  syncStart: boolean;
  muted: string[];
  /** Sections this style has; the panel dims the others. */
  available: string[];
  /** Style parts, for mute buttons. */
  parts: { id: string; name: string; role: string }[];
}

export class ArrangerEngine {
  private player: StylePlayer;
  private config: EngineConfig;
  private readonly leftHeld = new Set<number>();
  private readonly leftSounding = new Set<number>();
  private chordDueAt: number | null = null;
  private pending: MidiEvent[] = [];

  constructor(style: Style, config: Partial<EngineConfig> = {}, now = 0) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.player = new StylePlayer(style);
    this.pending.push(...this.player.setupEvents(now));
  }

  get settings(): Readonly<EngineConfig> {
    return this.config;
  }

  /** Switch style. Stops playback first; keeps the current chord. */
  loadStyle(style: Style, now: number): void {
    const chord = this.player.currentChord;
    this.pending.push(...this.player.stop(now));
    this.player = new StylePlayer(style);
    this.player.setChord(chord, now);
    this.pending.push(...this.player.setupEvents(now));
  }

  /** Handle one MIDI message from the keyboard. Returns events to send now (pass-through). */
  input(data: readonly number[], now: number): MidiEvent[] {
    const [status = 0, d1 = 0, d2 = 0] = data;
    const type = status & 0xf0;
    const out: MidiEvent[] = [];
    const c = this.config;
    if (type === 0x90 || type === 0x80) {
      const on = type === 0x90 && d2 > 0;
      if (c.splitEnabled && d1 < c.splitPoint) {
        if (on) {
          this.leftHeld.add(d1);
          this.chordDueAt = now + c.chordGatherMs;
          if (c.leftVoiceOn) {
            out.push({ t: now, data: [0x90 | (c.leftChannel - 1), d1, d2] });
            this.leftSounding.add(d1);
          }
        } else {
          this.leftHeld.delete(d1);
          if (this.leftSounding.delete(d1)) out.push({ t: now, data: [0x80 | (c.leftChannel - 1), d1, 0] });
        }
      } else if (c.thruInEngine) {
        out.push({ t: now, data: [(on ? 0x90 : 0x80) | (c.rightChannel - 1), d1, on ? d2 : 0] });
        if (c.layerOn || !on) out.push({ t: now, data: [(on ? 0x90 : 0x80) | (c.layerChannel - 1), d1, on ? d2 : 0] });
      }
    } else if (type === 0xb0 && c.thruInEngine && d1 !== 122) {
      // Pedals and controllers follow the right-hand voices.
      out.push({ t: now, data: [0xb0 | (c.rightChannel - 1), d1, d2] });
      out.push({ t: now, data: [0xb0 | (c.layerChannel - 1), d1, d2] });
    }
    return out;
  }

  command(cmd: EngineCommand, now: number): void {
    const p = this.player;
    const a = p.arrangement;
    switch (cmd.type) {
      case 'start': p.start(Math.max(now, cmd.at ?? now)); break;
      case 'stop': this.pending.push(...p.stop(now)); break;
      case 'toggleStart':
        if (p.isRunning) this.pending.push(...p.stop(now));
        else p.start(now);
        break;
      case 'main': a.requestMain(cmd.id); break;
      case 'fill': a.requestFill(); break;
      case 'break': a.requestBreak(); break;
      case 'intro':
        if (p.isRunning) a.requestIntro(cmd.n);
        else p.start(now, `intro${cmd.n}`);
        break;
      case 'ending': a.requestEnding(cmd.n); break;
      case 'tempo': p.setTempo(cmd.bpm, now); break;
      case 'mute': p.setMuted(cmd.part, cmd.muted, now); break;
      case 'chord': this.applyChord(cmd.chord, now); break;
      case 'config': this.config = { ...this.config, ...cmd.config }; break;
    }
  }

  /** Call every ~10 ms. Returns every event due up to now + lookahead. */
  tick(now: number): MidiEvent[] {
    if (this.chordDueAt !== null && now >= this.chordDueAt) {
      this.chordDueAt = null;
      const chord = detectChord(this.leftHeld);
      if (chord) this.applyChord(chord, now);
    }
    const out = this.pending.splice(0);
    out.push(...this.player.render(now + this.config.lookaheadMs));
    return out;
  }

  private applyChord(chord: Chord, now: number): void {
    this.player.setChord(chord, now);
    if (this.config.syncStart && !this.player.isRunning) this.player.start(now);
  }

  /**
   * Reset sound ("panic"): stop the style, then on all 16 channels send sustain off, All Sound Off
   * (cuts even ringing release tails), All Notes Off and Reset All Controllers - the standard set.
   */
  panic(now: number): MidiEvent[] {
    const out = this.pending.splice(0);
    out.push(...this.player.stop(now));
    for (const n of this.leftSounding) out.push({ t: now, data: [0x80 | (this.config.leftChannel - 1), n, 0] });
    this.leftHeld.clear();
    this.leftSounding.clear();
    this.chordDueAt = null;
    for (let ch = 0; ch < 16; ch++) {
      for (const [cc, v] of [[64, 0], [120, 0], [123, 0], [121, 0]] as const) out.push({ t: now, data: [0xb0 | ch, cc, v] });
    }
    return out;
  }

  status(now: number): EngineStatus {
    const { beat, beatsPerBar, snapshot } = this.player.position(now);
    const style = this.player.style;
    return {
      styleId: style.id,
      styleName: style.name,
      running: this.player.isRunning,
      section: snapshot.section,
      lastMain: snapshot.lastMain,
      queue: [...snapshot.queue],
      chord: this.player.currentChord.name,
      tempo: this.player.bpm,
      beat,
      beatsPerBar,
      quartersPerBeat: (4 * style.timeSignature[0]) / style.timeSignature[1] / beatsPerBar,
      syncStart: this.config.syncStart,
      muted: style.parts.filter((p) => this.player.isMuted(p.id)).map((p) => p.id),
      available: Object.keys(style.sections),
      parts: style.parts.map((p) => ({ id: p.id, name: p.name, role: p.role })),
    };
  }
}
