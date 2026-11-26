# ADR 0005: Engine logic in TypeScript, MIDI delivery in Rust (desktop)

- Status: accepted
- Date: 2026-11-26

## Context

ADR 0004 moved the Windows experience to a Tauri desktop app because native MIDI timing is ~90x tighter
than Chrome's. We still want one engine shared with the web app.

## Decision

- The engine (`packages/engine`) stays platform-free TypeScript. It is clock-agnostic: callers pass `now`
  (ms) and receive MIDI events with absolute timestamps for a short lookahead window.
- Desktop: the engine runs in the Tauri window. A Rust thread owns the MIDI ports. The window estimates the
  offset between its clock and Rust's monotonic clock, then sends events stamped in Rust time every ~10 ms
  with a ~40 ms lookahead. Rust sleeps until 2 ms before each event, then spins (the Phase 0 design: p95
  0.09 ms measured).
- Right-hand notes are forwarded to the voice channels by Rust directly (split point and channels pushed
  from the engine), so the melody adds no JavaScript latency. Left-hand notes go to the engine for chord
  recognition.
- Chord changes apply from the next rendered window (worst case ~40 ms plus a 20 ms chord-gather window
  for rolled chords). Sustained chord, pad and bass notes are re-pitched when the chord changes.
- No rewinding of already-queued events: it keeps note-on/note-off pairs consistent (no stuck notes).

## Consequences

- One engine, tested once, used by web and desktop.
- Two scheduler loops to maintain (web Worker, Rust thread), both thin.
- If chord-change latency proves noticeable in use, the lookahead can drop toward 15-20 ms on desktop.
