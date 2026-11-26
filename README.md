# EkidongoMIDI

An arranger (auto-accompaniment) app for MIDI keyboards: play chords with your left hand and a full band follows — drums, bass, guitars, keys — in styles from Afrobeat, Kadongo Kamu, Kiganda and Soukous to Gospel, Reggae and Ballroom.

Status: **Phase 0 (foundations)**. See the [product & engineering plan](https://claude.ai/artifact/4hcfCtMMnR3v3gsdsgnS6N).

## Repository layout

| Path | What |
| --- | --- |
| `packages/engine` | Platform-free TypeScript engine: chord recognition, style format v1, grid compiler. GPL-3.0. |
| `packages/styles` | Style library (JSON, format v1). **Not GPL — all rights reserved**, see its LICENSE. |
| `apps/timing-lab` | Phase 0 spike: measures real MIDI timing by recording the keyboard's audio. |
| `tools/` | Prototype style converter, native (WinMM) timing baseline. |
| `docs/` | Style format spec, architecture decision records, Phase 0 report. |

## Getting started

Requires Node 24+ and pnpm 12 (`npm install -g pnpm`).

```sh
pnpm install
pnpm check           # lint + typecheck + tests + build (same as CI)
pnpm test            # tests only
pnpm lab             # Timing Lab at http://localhost:5174 (Chrome or Edge)
```

## Licence

- Code: [GPL-3.0-or-later](LICENSE).
- Styles in `packages/styles`: all rights reserved, not covered by the GPL.
- Contributions require agreeing to the contributor licence agreement — see [CONTRIBUTING.md](CONTRIBUTING.md).
- Never commit Yamaha, Korg or Roland style files: they are copyrighted. Keep importer test files in `private-test-styles/` (git-ignored).
