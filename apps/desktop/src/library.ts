/**
 * Registrations (saved setups, one press to recall) and set lists, stored on this computer.
 * Pure logic + storage; the screens live in main.ts. Modelled on Genos Registration Memory + Freeze,
 * and on Pa5X / MainStage set lists (see the benchmark doc).
 */
import type { ChordMode, EngineCommand, EngineStatus, MainId, VoiceSetting, VoiceSlot } from '@ekidongo/engine';

export interface Registration {
  name: string;
  styleId: string;
  tempo: number;
  main: MainId;
  voices: Record<VoiceSlot, VoiceSetting>;
  layerOn: boolean;
  splitPoint: number;
  chordMode: ChordMode;
  syncStart: boolean;
  syncStop: boolean;
  muted: string[];
  partVolumes: Record<string, number>;
}

export interface SetlistEntry {
  title: string;
  reg: Registration;
}

export interface Setlist {
  id: string;
  name: string;
  entries: SetlistEntry[];
}

export interface Library {
  version: 1;
  /** Bank of 8 registration buttons on the performance screen. */
  bank: (Registration | null)[];
  setlists: Setlist[];
  activeSetlist: string | null;
  position: number;
}

export const BANK_SIZE = 8;
const KEY = 'ekidongo.library';

export function emptyLibrary(): Library {
  return { version: 1, bank: Array.from({ length: BANK_SIZE }, () => null), setlists: [], activeSetlist: null, position: 0 };
}

export function loadLibrary(storage: Pick<Storage, 'getItem'> = localStorage): Library {
  try {
    const raw = JSON.parse(storage.getItem(KEY) ?? 'null') as Partial<Library> | null;
    if (!raw || raw.version !== 1) return emptyLibrary();
    const bank = Array.from({ length: BANK_SIZE }, (_, i) => raw.bank?.[i] ?? null);
    return { version: 1, bank, setlists: raw.setlists ?? [], activeSetlist: raw.activeSetlist ?? null, position: raw.position ?? 0 };
  } catch {
    return emptyLibrary();
  }
}

export function saveLibrary(lib: Library, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(KEY, JSON.stringify(lib));
}

/** Snapshot of everything a registration remembers. */
export function capture(name: string, s: EngineStatus, splitPoint: number): Registration {
  return {
    name,
    styleId: s.styleId,
    tempo: Math.round(s.tempo),
    main: s.lastMain as MainId,
    voices: structuredClone(s.voices),
    layerOn: s.layerOn,
    splitPoint,
    chordMode: s.chordMode,
    syncStart: s.syncStart,
    syncStop: s.syncStop,
    muted: [...s.muted],
    partVolumes: Object.fromEntries(s.parts.map((p) => [p.id, p.volume])),
  };
}

export interface RecallPlan {
  /** Style to load first (undefined: keep the current one). */
  styleId?: string;
  /** Commands to send after the style is loaded. */
  commands: EngineCommand[];
}

/**
 * What recalling a registration does. With Freeze on, the accompaniment (style, tempo, section,
 * mixer) is left alone and only voices and playing settings change - so a song can change sounds
 * without disturbing the band.
 */
export function recallPlan(reg: Registration, current: EngineStatus, freeze: boolean): RecallPlan {
  const commands: EngineCommand[] = [];
  for (const slot of ['right', 'layer', 'left'] as const) {
    commands.push({ type: 'voice', slot, program: reg.voices[slot].program, volume: reg.voices[slot].volume });
  }
  commands.push({
    type: 'config',
    config: { layerOn: reg.layerOn, splitPoint: reg.splitPoint, chordMode: reg.chordMode, syncStart: reg.syncStart, syncStop: reg.syncStop },
  });
  if (freeze) return { commands };

  const styleId = reg.styleId !== current.styleId ? reg.styleId : undefined;
  commands.push({ type: 'tempo', bpm: reg.tempo }, { type: 'main', id: reg.main });
  for (const [part, volume] of Object.entries(reg.partVolumes)) commands.push({ type: 'partVolume', part, volume });
  const partIds = styleId ? Object.keys(reg.partVolumes) : current.parts.map((p) => p.id);
  for (const part of partIds) commands.push({ type: 'mute', part, muted: reg.muted.includes(part) });
  return { styleId, commands };
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function activeSetlist(lib: Library): Setlist | null {
  return lib.setlists.find((s) => s.id === lib.activeSetlist) ?? null;
}

/** Move within the active set list; returns the entry to recall, or null at either end. */
export function step(lib: Library, delta: number): SetlistEntry | null {
  const list = activeSetlist(lib);
  if (!list || list.entries.length === 0) return null;
  const next = lib.position + delta;
  if (next < 0 || next >= list.entries.length) return null;
  lib.position = next;
  return list.entries[next] ?? null;
}

export function moveEntry(list: Setlist, from: number, to: number): void {
  if (to < 0 || to >= list.entries.length) return;
  const [e] = list.entries.splice(from, 1);
  if (e) list.entries.splice(to, 0, e);
}
