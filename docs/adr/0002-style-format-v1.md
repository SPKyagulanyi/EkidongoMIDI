# ADR 0002: Phrase-based style format, modelled on Yamaha's

- Status: accepted
- Date: 2026-11-26

## Context

The Python prototype stored styles as one-character-per-step grids. Professional arranger styles are recorded MIDI phrases plus rules for re-pitching them to the played chord; grids can't express feel, ghost notes, slides or real guitar voicings. We also want to import Yamaha style files the user owns.

## Decision

Style format v1 (`docs/style-format-v1.md`): sections hold per-part MIDI phrases written over a source chord (default C major 7); each part declares NTR/NTT re-pitching rules like Yamaha's CASM data. Parts use channels 9–16 (drums on 10); channels 1–8 are reserved for the player. Validated with a Zod schema; versioned by `schemaVersion`.

Grids remain as an authoring shorthand that compiles into phrases (`compileGridStyle`); the 24 prototype styles were converted this way and are marked `status: prototype`.

## Consequences

- Yamaha imports and our styles share one player.
- Real styles need recording tools (Phase 2 phrase recorder) or MIDI files from a DAW.
- The re-pitching engine (Phase 1) must implement the NTR/NTT rules.
