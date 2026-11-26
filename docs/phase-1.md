# Phase 1 — Band and church MVP

Gate to Phase 2: **used at 2 services (or rehearsals) with no blocking issue**.

## Milestones

| # | Milestone | Done when |
| --- | --- | --- |
| M1 | Engine core (TypeScript) | Phrases re-pitch to any chord; sections, fills, intros, endings and sync start behave like an arranger; deterministic tests incl. "no stuck notes" |
| M2 | Desktop shell (Tauri 2 + Rust MIDI) | App lists ports, plays a style on the FP-30X with native timing; right hand passes through with no added latency; Panic works |
| M3 | Performance screen | The wireframe's screen wired to the engine: sections, tempo, chord display, voices, layer, split, mutes |
| M4 | Registrations and setlists | Saved setups and service setlists, stored locally, exportable as files |
| M5 | First reviewed styles | 12 MVP styles recorded or approved by the owner (see plan); phrase import from MIDI files |
| M6 | Release pipeline | Signed Windows installer from CI, beta/stable channels, Sentry in the desktop app |

## Architecture (ADR 0005)

The engine runs in TypeScript inside the app window; a Rust thread owns the MIDI ports and delivers every
event at its timestamp on a native clock. Right-hand notes are passed through in Rust, so the melody never
waits for JavaScript.

## Status

- [x] M1 engine core
- [x] M2 desktop shell
- [x] M3 performance screen
- [x] M4 registrations and set lists (incl. export/import)
- [ ] M5 first reviewed styles
- [~] M6 release pipeline: signed installer, CI releases, auto-update, desktop error reporting done; installer code signing (certificate) pending
