# Third-party notices

## Groove MIDI Dataset

The drum parts of the "Live Drums" styles in `packages/styles/live/` are derived from the
**Groove MIDI Dataset** by Google LLC (Magenta), licensed under the
[Creative Commons Attribution 4.0 International licence (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).

- Source: https://magenta.tensorflow.org/datasets/groove
- Paper: Gillick, Roberts, Engel, Eck, Bamman. "Learning to Groove with Inverse Sequence
  Transformations." ICML 2019.
- Changes made: selected bars and fills were cut from the performances, note timing rescaled to
  480 ticks per quarter note, and Roland TD-11 edge/rim notes mapped to General MIDI drum notes.
  Velocities and the drummers' timing are unchanged.

Each derived style names the dataset, drummer and source performance in its `credits` field.
The dataset itself is not committed; rebuild with `pnpm build:groove` after downloading it to
`third_party/groove/`.
