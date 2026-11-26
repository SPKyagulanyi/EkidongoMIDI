# Contributing

Thanks for helping build EkidongoMIDI.

## Before your first pull request

EkidongoMIDI is open core: the code is GPL-3.0, and the project may also sell style packs and premium features. To keep that possible, every contributor signs the [contributor licence agreement](CLA.md) (CLA), which lets the project relicense contributions while you keep your copyright.

To sign, post this comment on your first pull request:

> I have read the CLA and I agree to its terms.

The **CLA** check on your pull request turns green once you have signed; you only sign once. Pull requests without a signature can't be merged.

## Workflow

1. Branch from `main`.
2. `pnpm check` must pass (lint, typecheck, tests, build) — CI runs the same.
3. Engine changes need tests. Timing-sensitive changes need a Timing Lab run on real hardware, with results in the pull request.
4. Styles: follow the review process in the plan (reference recordings, capture, build, musician review, licence form). Never commit vendor style files.

## Code rules

- `packages/engine` must stay platform-free: no DOM, no Node APIs, no Web MIDI.
- TypeScript strict mode; no `any` without a comment explaining why.
- Record significant decisions as an ADR in `docs/adr/`.
