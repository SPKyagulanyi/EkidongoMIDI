# ADR 0004: Native MIDI backend on Windows from Phase 1

- Status: accepted
- Date: 2026-11-26
- Evidence: `docs/phase-0.md` (Timing Lab, Roland FP-30X, Chrome 158, Windows 11)

## Context

The plan assumed a web app (Web MIDI in Chrome) could meet the timing target: jitter p95 under 5 ms, as heard from the keyboard. Phase 0 measured it end to end.

## Findings

- Chrome with timestamped sends: p95 8.6 ms, SD 4.8 ms, even though every event was handed to the browser 18+ ms early. The jitter is in the browser/OS delivery path, not our scheduler. An SD of about 4.5 ms is what Windows' default 15.6 ms timer granularity would produce.
- One Chrome run also had a ~0.9 s timer stall (54 late sends, 46 lost clicks).
- Native WinMM (the API Rust's `midir` uses on Windows): p95 0.32 ms, SD 0.19 ms.

## Decision

- Phase 1 ships the **Windows desktop app (Tauri 2 + Rust MIDI backend)** as the main Windows experience; the scheduler and MIDI output run natively, and the engine logic stays shared TypeScript.
- The web app remains for setup, editing and non-timing-critical use. On Windows it shows a "use the desktop app for live playing" notice.
- Android timing is unmeasured: run the Timing Lab on an Android tablet before committing to the PWA there.

## Consequences

- Rust toolchain and MSVC Build Tools become required for desktop builds (CI adds a Windows job).
- The engine's scheduler must be an interface with two implementations: Web (Worker + Web MIDI) and native (Rust thread).
- Tauri moves from Phase 2 to Phase 1; the roadmap gains about 2 weeks.
