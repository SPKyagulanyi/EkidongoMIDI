# Style format v1

Source of truth: `packages/engine/src/style/schema.ts` (Zod). This page explains it.

```jsonc
{
  "format": "ekidongo-style",
  "schemaVersion": 1,
  "id": "afrobeat",                 // lowercase, digits, dashes; file name = <id>.json
  "name": "Afrobeat",
  "category": "African",
  "tempo": 106,                     // quarter-note BPM
  "timeSignature": [4, 4],          // 12/8 = [12, 8]
  "ppq": 480,                       // ticks per quarter note (fixed)
  "swing": 0.08,                    // 0-0.5: delay of every 2nd 16th, as a fraction of a 16th
  "sourceChord": { "root": 0, "quality": "maj7" },   // phrases are written over C major 7
  "status": "prototype",            // prototype | in-review | reviewed
  "credits": [{ "name": "...", "role": "drums" }],
  "license": "All rights reserved",
  "parts": [
    { "id": "drums", "name": "Drums", "role": "drums", "channel": 10, "program": 0 },
    { "id": "bass", "name": "Bass", "role": "bass", "channel": 11, "program": 33,
      "ntr": "root-fixed", "ntt": "bass", "volume": 105 }
  ],
  "sections": {
    "mainA": { "bars": 1, "phrases": {
      "drums": [{ "t": 0, "n": 36, "v": 118, "d": 60 }],
      "bass":  [{ "t": 0, "n": 36, "v": 95, "d": 240 }]
    }}
  }
}
```

## Sections

`intro1-3`, `mainA-D`, `fillA-D`, `break`, `ending1-3`. Only `mainA` is required. A part missing from a section is silent there.

## Parts

| Field | Meaning |
| --- | --- |
| `role` | `drums`, `bass`, `chord`, `pad`, `phrase` |
| `channel` | 9–16. Drums must be 10; nothing else may use 10. Channels 1–8 belong to the player. |
| `program`, `bankMsb`, `bankLsb` | General MIDI / GM2 sound |
| `volume`, `pan`, `reverb`, `chorus` | Mixer, 0–127 |
| `ntr` | Note transposition rule: `root-transpose` (moves with the root, keeps shape), `root-fixed` (stays near its written range), `guitar` (guitar-style voicings) |
| `ntt` | Note transposition table: `bypass` (drums), `melody`, `chord`, `bass`, `melodic-minor`, `dorian` |
| `noteRange` | Optional low/high limit that re-pitched notes fold into |

## Events

`t` start tick in the section, `n` MIDI note (over the source chord), `v` velocity 1–127, `d` duration in ticks. A bar is `ppq * 4 * num / den` ticks (1920 in 4/4, 2880 in 12/8).

## Validation

`validateStyle(json)` returns `{ ok: true, style }` or `{ ok: false, errors: [...] }` with readable paths, e.g. `sections.mainA.phrases.bass.0.v: Too small`.
