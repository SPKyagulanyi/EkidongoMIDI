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
import { detectChordWithMode, type ChordMode } from '../chordModes.ts';
import type { Chord } from '../chords.ts';
import type { Style } from '../style/schema.ts';
import type { MainId } from './arrangement.ts';
import { StylePlayer, type MidiEvent } from './player.ts';

export type VoiceSlot = 'right' | 'layer' | 'left';
export interface VoiceSetting {
  program: number; // GM program 0-127
  volume: number; // 0-127
}

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
  voices: Record<VoiceSlot, VoiceSetting>;
  chordMode: ChordMode;
  syncStart: boolean;
  /** Stop the band when every left-hand key is released (and restart on the next chord). */
  syncStop: boolean;
  /** Length of Fade In / Fade Out. */
  fadeMs: number;
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
  voices: {
    right: { program: 0, volume: 110 },
    layer: { program: 48, volume: 80 },
    left: { program: 0, volume: 90 },
  },
  chordMode: 'fingered',
  syncStart: true,
  syncStop: false,
  fadeMs: 4000,
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
  | { type: 'fadeIn' }
  | { type: 'fadeOut' }
  | { type: 'tempo'; bpm: number }
  | { type: 'mute'; part: string; muted: boolean }
  | { type: 'partVolume'; part: string; volume: number }
  | { type: 'voice'; slot: VoiceSlot; program?: number; volume?: number }
  /** Set the chord directly (on-screen chord pads, tests); same as playing it with the left hand. */
  | { type: 'chord'; chord: Chord }
  | { type: 'config'; config: Partial<Omit<EngineConfig, 'voices'>> };

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
  syncStop: boolean;
  chordMode: ChordMode;
  fading: 'in' | 'out' | null;
  muted: string[];
  /** Sections this style has; the panel dims the others. */
  available: string[];
  /** Style parts with their current volume, for the mixer. */
  parts: { id: string; name: string; role: string; volume: number; muted: boolean }[];
  voices: Record<VoiceSlot, VoiceSetting>;
  layerOn: boolean;
}

interface Fade {
  dir: 'in' | 'out';
  start: number;
  end: number;
  emittedUntil: number;
}

const FADE_STEP_MS = 50;

export class ArrangerEngine {
  private player: StylePlayer;
  private config: EngineConfig;
  private readonly leftHeld = new Set<number>();
  private readonly leftSounding = new Set<number>();
  private chordDueAt: number | null = null;
  private pending: MidiEvent[] = [];
  private partVolumes = new Map<string, number>();
  private fade: Fade | null = null;

  constructor(style: Style, config: Partial<EngineConfig> = {}, now = 0) {
    this.config = { ...DEFAULT_CONFIG, ...config, voices: { ...DEFAULT_CONFIG.voices, ...config.voices } };
    this.player = new StylePlayer(style);
    this.pending.push(...this.player.setupEvents(now), ...this.expression(now, 127));
    for (const slot of ['right', 'layer', 'left'] as const) this.pending.push(...this.voiceEvents(slot, now));
  }

  get settings(): Readonly<EngineConfig> {
    return this.config;
  }

  private channelOf(slot: VoiceSlot): number {
    return (slot === 'right' ? this.config.rightChannel : slot === 'layer' ? this.config.layerChannel : this.config.leftChannel) - 1;
  }

  private voiceEvents(slot: VoiceSlot, t: number): MidiEvent[] {
    const ch = this.channelOf(slot);
    const v = this.config.voices[slot];
    return [
      { t, data: [0xb0 | ch, 0, 0] },
      { t, data: [0xb0 | ch, 32, 0] },
      { t, data: [0xc0 | ch, v.program] },
      { t, data: [0xb0 | ch, 7, v.volume] },
    ];
  }

  /** Expression (CC11) on every style channel: used for fades. */
  private expression(t: number, value: number): MidiEvent[] {
    return this.player.style.parts.map((p) => ({ t, data: [0xb0 | (p.channel - 1), 11, value] }));
  }

  private stopNow(now: number): void {
    this.pending.push(...this.player.stop(now));
    if (this.fade) this.pending.push(...this.expression(now + 1, 127));
    this.fade = null;
  }

  /** Switch style. Stops playback first; keeps the current chord. */
  loadStyle(style: Style, now: number): void {
    const chord = this.player.currentChord;
    this.stopNow(now);
    this.player = new StylePlayer(style);
    this.partVolumes = new Map();
    this.player.setChord(chord, now);
    this.pending.push(...this.player.setupEvents(now), ...this.expression(now, 127));
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
          if (c.syncStop && this.leftHeld.size === 0 && this.player.isRunning) {
            this.chordDueAt = null;
            this.stopNow(now);
          }
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
      case 'stop': this.stopNow(now); break;
      case 'toggleStart':
        if (p.isRunning) this.stopNow(now);
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
      case 'fadeIn':
        if (p.isRunning) break;
        this.pending.push(...this.expression(now, 0));
        p.start(now);
        this.fade = { dir: 'in', start: now, end: now + this.config.fadeMs, emittedUntil: now };
        break;
      case 'fadeOut':
        if (p.isRunning) this.fade = { dir: 'out', start: now, end: now + this.config.fadeMs, emittedUntil: now };
        break;
      case 'tempo': p.setTempo(cmd.bpm, now); break;
      case 'mute': p.setMuted(cmd.part, cmd.muted, now); break;
      case 'partVolume': {
        const part = p.style.parts.find((x) => x.id === cmd.part);
        if (!part) break;
        const v = Math.max(0, Math.min(127, Math.round(cmd.volume)));
        this.partVolumes.set(part.id, v);
        this.pending.push({ t: now, data: [0xb0 | (part.channel - 1), 7, v] });
        break;
      }
      case 'voice': {
        const cur = this.config.voices[cmd.slot];
        const next = {
          program: cmd.program === undefined ? cur.program : Math.max(0, Math.min(127, cmd.program)),
          volume: cmd.volume === undefined ? cur.volume : Math.max(0, Math.min(127, Math.round(cmd.volume))),
        };
        this.config = { ...this.config, voices: { ...this.config.voices, [cmd.slot]: next } };
        this.pending.push(...this.voiceEvents(cmd.slot, now));
        break;
      }
      case 'chord': this.applyChord(cmd.chord, now); break;
      case 'config': this.config = { ...this.config, ...cmd.config }; break;
    }
  }

  /** Call every ~10 ms. Returns every event due up to now + lookahead. */
  tick(now: number): MidiEvent[] {
    if (this.chordDueAt !== null && now >= this.chordDueAt) {
      this.chordDueAt = null;
      const chord = detectChordWithMode(this.leftHeld, this.config.chordMode);
      if (chord) this.applyChord(chord, now);
    }
    const horizon = now + this.config.lookaheadMs;
    this.runFade(now, horizon);
    const out = this.pending.splice(0);
    out.push(...this.player.render(horizon));
    return out.sort((a, b) => a.t - b.t);
  }

  private runFade(now: number, horizon: number): void {
    const f = this.fade;
    if (!f) return;
    if (!this.player.isRunning) {
      this.pending.push(...this.expression(now, 127));
      this.fade = null;
      return;
    }
    const until = Math.min(horizon, f.end);
    // Inclusive of the end time, so a fade reaches exactly 0 (out) or 127 (in).
    while (f.emittedUntil <= until) {
      const t = f.emittedUntil;
      const p = (t - f.start) / (f.end - f.start);
      const v = Math.round(127 * (f.dir === 'in' ? p : 1 - p));
      this.pending.push(...this.expression(t, Math.max(0, Math.min(127, v))));
      f.emittedUntil += FADE_STEP_MS;
    }
    if (f.dir === 'in' && horizon >= f.end) {
      this.pending.push(...this.expression(f.end, 127));
      this.fade = null;
    } else if (f.dir === 'out' && now >= f.end) {
      // Stop at the real time (not the lookahead horizon) so no queued note is left without its note-off.
      this.stopNow(now);
    }
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
    this.fade = null;
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
      syncStop: this.config.syncStop,
      chordMode: this.config.chordMode,
      fading: this.fade?.dir ?? null,
      muted: style.parts.filter((p) => this.player.isMuted(p.id)).map((p) => p.id),
      available: Object.keys(style.sections),
      parts: style.parts.map((p) => ({
        id: p.id, name: p.name, role: p.role,
        volume: this.partVolumes.get(p.id) ?? p.volume,
        muted: this.player.isMuted(p.id),
      })),
      voices: this.config.voices,
      layerOn: this.config.layerOn,
    };
  }
}
