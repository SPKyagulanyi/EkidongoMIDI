/**
 * App updates (Tauri updater). Releases are signed; the app only installs updates signed with the
 * project's key (public key in tauri.conf.json). Never installs on its own: the player chooses when,
 * and never while the band is playing.
 */
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';

let available: Update | null = null;

export async function checkForUpdate(): Promise<{ version: string; notes?: string } | null> {
  available = await check();
  return available ? { version: available.version, notes: available.body } : null;
}

export const hasUpdate = () => available !== null;

/** Download, install and restart. `before` runs first (e.g. hand the keyboard back). */
export async function installUpdate(onProgress: (percent: number | null) => void, before: () => Promise<void>): Promise<void> {
  if (!available) return;
  let total = 0;
  let done = 0;
  await before();
  await available.downloadAndInstall((ev) => {
    if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
    else if (ev.event === 'Progress') {
      done += ev.data.chunkLength;
      onProgress(total ? Math.round((done / total) * 100) : null);
    }
  });
  await relaunch();
}
