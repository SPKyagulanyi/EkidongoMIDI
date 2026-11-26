/**
 * Bridge between the engine (this window) and the Rust MIDI thread.
 *
 * Clock: Rust stamps time in ms since it started. We estimate the offset from performance.now()
 * with a few round trips (keeping the fastest), so every engine event is sent in Rust time.
 * Loop: every 10 ms, ask the engine for events up to now + lookahead and hand them to Rust.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ArrangerEngine, EngineConfig, MidiEvent } from '@ekidongo/engine';

export interface Ports {
  inputs: string[];
  outputs: string[];
}

export const listPorts = () => invoke<Ports>('list_ports');
export const connectPorts = (input: string, output: string) => invoke<void>('connect', { input, output });
export const disconnectPorts = () => invoke<void>('disconnect');
export const panicNow = () => invoke<void>('panic');
export const writeSetupFile = (path: string, contents: string) => invoke<void>('write_setup_file', { path, contents });
export const readSetupFile = (path: string) => invoke<string>('read_setup_file', { path });

let offset = 0;

/** Estimate Rust-clock minus performance.now(), using the fastest of several round trips. */
export async function syncClock(samples = 8): Promise<{ offset: number; rttMs: number }> {
  let best = { offset: 0, rttMs: Infinity };
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    const rust = await invoke<number>('clock_now');
    const t1 = performance.now();
    if (t1 - t0 < best.rttMs) best = { offset: rust - (t0 + t1) / 2, rttMs: t1 - t0 };
  }
  offset = best.offset;
  return best;
}

/** Current time on the Rust clock. */
export const rustNow = () => performance.now() + offset;

export function pushThru(cfg: Readonly<EngineConfig>): Promise<void> {
  return invoke('set_thru', {
    thru: {
      splitPoint: cfg.splitPoint,
      splitEnabled: cfg.splitEnabled,
      rightChannel: cfg.rightChannel,
      layerChannel: cfg.layerChannel,
      layerOn: cfg.layerOn,
    },
  });
}

export function send(events: MidiEvent[]): void {
  if (events.length === 0) return;
  invoke('schedule', { events }).catch((e) => console.error('[bridge] schedule failed', e));
}

/** Runs the engine against the Rust clock. Returns a stop function. */
export async function runEngine(getEngine: () => ArrangerEngine): Promise<() => void> {
  const unlisten: UnlistenFn = await listen<{ t: number; data: number[] }>('midi-in', (e) => {
    send(getEngine().input(e.payload.data, e.payload.t));
  });
  const timer = setInterval(() => send(getEngine().tick(rustNow())), 10);
  // Re-sync the clock now and then (drift between the two clocks is tiny, but free to correct).
  const resync = setInterval(() => void syncClock(4), 30000);
  return () => {
    clearInterval(timer);
    clearInterval(resync);
    unlisten();
  };
}
