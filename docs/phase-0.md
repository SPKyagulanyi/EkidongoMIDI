# Phase 0 — Foundations

Gate to Phase 1: **timing targets met** (jitter p95 < 5 ms, no missed notes) on the chosen platform path.

## Checklist

- [x] Monorepo, TypeScript strict, ESLint, Vitest, CI workflow (`.github/workflows/ci.yml`)
- [x] Engine: chord recognition ported from the prototype, 500+ voicings tested
- [x] Style format v1 + schema validation + docs
- [x] Grid compiler; 24 prototype styles converted and validated
- [x] Timing Lab (Web MIDI, end-to-end audio measurement) + native WinMM baseline
- [x] Timing measurements on the FP-30X (results below)
- [x] Decision: desktop (Tauri + native MIDI) moves into Phase 1 on Windows
- [ ] Rust + MSVC Build Tools installed; Tauri "hello MIDI" spike plays a click
- [ ] Error reporting (Sentry): needs an account and DSN from the owner
- [ ] UI wireframes for the performance screen
- [x] GitHub repository created (private) and CI green

## Timing method

Clicks (GM hi wood block, channel 10, every 125 ms = 16th notes at 120 BPM) are played on the keyboard, and the keyboard's own audio is recorded over USB. Onsets are detected in the recording and fitted to an even grid; deviations from the grid are the jitter the musician actually hears. Constant latency doesn't count, only unevenness.

Runs:

1. Browser, timestamped sends, 40 ms lookahead (the planned design)
2. Same with a busy UI (main thread blocked 30 ms every 100 ms)
3. Browser, immediate sends (naive)
4. Native WinMM via Python (`tools/native-timing/native_click.py`), standing in for a Tauri/midir backend (midir uses WinMM on Windows)

## Results (2026-11-26, Roland FP-30X, Chrome 158, Windows 11)

| Run | Heard / sent | Jitter SD (ms) | p95 (ms) | Max (ms) | Pass |
| --- | --- | --- | --- | --- | --- |
| Browser timestamped, 40 ms lookahead | 114 / 160 | 5.94 | 13.57 | 18.29 | No: 0.9 s timer stall, 54 late sends |
| Browser timestamped + busy UI | 160 / 160 | 4.82 | 8.58 | 9.96 | No: all sends on time, jitter added in delivery |
| Native WinMM (Python) | 123 / 160* | 0.19 | 0.32 | 1.56 | Timing yes |

\* The 25 s recording ended before the native script finished; the missing clicks are outside the recording, not dropped.

Not yet run: browser "immediate" mode, a native rerun with a longer recording, Android.

## Decision

Native MIDI on Windows moves into Phase 1 — see [ADR 0004](adr/0004-native-midi-on-windows.md).
