/**
 * Mix pass for EkidongoMIDI's own styles, targeting how professional Yamaha styles are balanced
 * (measured across 107 of them): part faders at 100, balance carried by playing strength, a dry bass,
 * reverb on the rest, a gentle stereo spread, and subtle human variation on programmed parts.
 */
import { humanize, setAverageVelocity, type NoteEvent, type Part, type Style } from '../packages/engine/src/index.ts';

/** Median average velocity per role in Yamaha's Main A phrases. */
const TARGET_VELOCITY: Record<Part['role'], number> = { drums: 76, bass: 100, chord: 73, pad: 66, phrase: 80 };

/** Gentle stereo positions so parts don't all sit in the middle (64 = centre). */
const PAN_ORDER = [50, 78, 58, 70, 64];

export interface MixOptions {
  /** Add human variation to these parts (programmed ones), e.g. all but real drum performances. */
  humanizeParts: (p: Part) => boolean;
  /** Leave these parts' velocities alone (played by people). */
  keepVelocity: (p: Part) => boolean;
}

export function mixPass(style: Style, o: MixOptions): Style {
  const s: Style = JSON.parse(JSON.stringify(style));
  let panIndex = 0;
  s.parts = s.parts.map((p) => {
    const pan = p.role === 'drums' || p.role === 'bass' ? 64 : PAN_ORDER[panIndex++ % PAN_ORDER.length]!;
    return { ...p, volume: 100, pan, reverb: p.role === 'bass' ? 4 : p.role === 'drums' ? 30 : 40, chorus: p.role === 'pad' ? 20 : 0 };
  });
  for (const [sid, sec] of Object.entries(s.sections)) {
    if (!sec) continue;
    for (const p of s.parts) {
      const evs: NoteEvent[] | undefined = sec.phrases[p.id];
      if (!evs?.length) continue;
      let out = o.keepVelocity(p) ? evs : setAverageVelocity(evs, TARGET_VELOCITY[p.role]);
      if (o.humanizeParts(p)) out = humanize(out, { velocity: 8, timing: 6, seed: hash(`${s.id}/${sid}/${p.id}`) });
      sec.phrases[p.id] = out.sort((a, b) => a.t - b.t || a.n - b.n);
    }
  }
  return s;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
