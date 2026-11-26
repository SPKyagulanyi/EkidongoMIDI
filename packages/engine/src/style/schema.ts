/**
 * Style format v1 ("ekidongo-style").
 *
 * A style is a set of sections (intro, main, fill, break, ending). Each section holds recorded
 * MIDI phrases, one per part, written over a known SOURCE CHORD (default C major 7). At playback
 * the engine re-pitches each phrase to the chord the player holds, using the part's NTR/NTT rules
 * (the same idea as Yamaha's style files, so imported Yamaha styles map onto this model).
 *
 * See docs/style-format-v1.md for the full description.
 */
import { z } from 'zod';
import { CHORD_QUALITIES } from '../chords.ts';

export const STYLE_FORMAT = 'ekidongo-style';
export const STYLE_SCHEMA_VERSION = 1;
export const PPQ = 480;

export const SECTION_IDS = [
  'intro1', 'intro2', 'intro3',
  'mainA', 'mainB', 'mainC', 'mainD',
  'fillA', 'fillB', 'fillC', 'fillD',
  'break',
  'ending1', 'ending2', 'ending3',
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export const PART_ROLES = ['drums', 'bass', 'chord', 'pad', 'phrase'] as const;

/** Note Transposition Rule: how the phrase follows the chord root. */
export const NTR = ['root-transpose', 'root-fixed', 'guitar'] as const;
/** Note Transposition Table: how notes are mapped onto the new chord's tones/scale. */
export const NTT = ['bypass', 'melody', 'chord', 'bass', 'melodic-minor', 'dorian'] as const;

/** Channels 1-8 are reserved for the player's own voices; style parts use 9-16 (drums on 10). */
export const STYLE_CHANNELS = [9, 10, 11, 12, 13, 14, 15, 16] as const;
export const DRUM_CHANNEL = 10;

const midi7 = z.number().int().min(0).max(127);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes');

export const NoteEventSchema = z.object({
  /** Start, in ticks from the start of the section (PPQ = 480 per quarter note). */
  t: z.number().int().min(0),
  /** MIDI note number, written over the source chord. */
  n: midi7,
  /** Velocity 1-127. */
  v: z.number().int().min(1).max(127),
  /** Duration in ticks. */
  d: z.number().int().min(1),
});
export type NoteEvent = z.infer<typeof NoteEventSchema>;

export const PartSchema = z.object({
  id: slug,
  name: z.string().min(1),
  role: z.enum(PART_ROLES),
  channel: z.number().int().refine((c) => (STYLE_CHANNELS as readonly number[]).includes(c), {
    message: 'style parts use channels 9-16',
  }),
  program: midi7,
  bankMsb: midi7.default(0),
  bankLsb: midi7.default(0),
  volume: midi7.default(100),
  pan: midi7.default(64),
  reverb: midi7.default(40),
  chorus: midi7.default(0),
  ntr: z.enum(NTR).default('root-transpose'),
  ntt: z.enum(NTT).default('bypass'),
  /** Optional range the re-pitched notes are folded into. */
  noteRange: z.object({ low: midi7, high: midi7 }).optional(),
});
export type Part = z.infer<typeof PartSchema>;

export const SectionSchema = z.object({
  bars: z.number().int().min(1).max(16),
  /** Phrases keyed by part id. A part missing here is silent in this section. */
  phrases: z.record(z.string(), z.array(NoteEventSchema)),
});
export type Section = z.infer<typeof SectionSchema>;

export const StyleSchema = z
  .object({
    format: z.literal(STYLE_FORMAT),
    schemaVersion: z.literal(STYLE_SCHEMA_VERSION),
    id: slug,
    name: z.string().min(1),
    category: z.string().min(1),
    /** Quarter-note beats per minute. */
    tempo: z.number().min(20).max(400),
    timeSignature: z.tuple([
      z.number().int().min(1).max(16),
      z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(16)]),
    ]),
    ppq: z.literal(PPQ),
    /** 0 = straight; up to 0.5 delays every second 16th by that fraction of a 16th. */
    swing: z.number().min(0).max(0.5).default(0),
    sourceChord: z
      .object({ root: z.number().int().min(0).max(11), quality: z.string() })
      .default({ root: 0, quality: 'maj7' }),
    status: z.enum(['prototype', 'in-review', 'reviewed']),
    credits: z.array(z.object({ name: z.string(), role: z.string() })).default([]),
    license: z.string().min(1),
    parts: z.array(PartSchema).min(1),
    sections: z.partialRecord(z.enum(SECTION_IDS), SectionSchema),
  })
  .superRefine((s, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', message, path });

    if (!CHORD_QUALITIES.has(s.sourceChord.quality)) {
      issue(`unknown chord quality "${s.sourceChord.quality}"`, ['sourceChord', 'quality']);
    }
    const ids = new Set<string>();
    const channels = new Set<number>();
    s.parts.forEach((p, i) => {
      if (ids.has(p.id)) issue(`duplicate part id "${p.id}"`, ['parts', i, 'id']);
      if (channels.has(p.channel)) issue(`channel ${p.channel} used twice`, ['parts', i, 'channel']);
      if (p.role === 'drums' && p.channel !== DRUM_CHANNEL) issue('drums must use channel 10', ['parts', i, 'channel']);
      if (p.role !== 'drums' && p.channel === DRUM_CHANNEL) issue('channel 10 is for drums only', ['parts', i, 'channel']);
      if (p.noteRange && p.noteRange.low > p.noteRange.high) issue('noteRange low > high', ['parts', i, 'noteRange']);
      ids.add(p.id);
      channels.add(p.channel);
    });

    if (!s.sections.mainA) issue('a style needs at least a mainA section', ['sections']);

    const barTicks = (s.ppq * 4 * s.timeSignature[0]) / s.timeSignature[1];
    for (const [sid, sec] of Object.entries(s.sections)) {
      if (!sec) continue;
      const len = sec.bars * barTicks;
      for (const [pid, events] of Object.entries(sec.phrases)) {
        if (!ids.has(pid)) issue(`phrase for unknown part "${pid}"`, ['sections', sid, 'phrases', pid]);
        events.forEach((e, i) => {
          if (e.t >= len) issue(`event starts after the section ends (${e.t} >= ${len})`, ['sections', sid, 'phrases', pid, i]);
        });
      }
    }
  });
export type Style = z.infer<typeof StyleSchema>;

/** Ticks in one bar of a style. */
export function barTicks(style: Pick<Style, 'ppq' | 'timeSignature'>): number {
  return (style.ppq * 4 * style.timeSignature[0]) / style.timeSignature[1];
}

export type ValidationResult = { ok: true; style: Style } | { ok: false; errors: string[] };

/** Validate unknown JSON as a style, with readable error messages. */
export function validateStyle(json: unknown): ValidationResult {
  const r = StyleSchema.safeParse(json);
  if (r.success) return { ok: true, style: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.join('.') || '(style)'}: ${i.message}`),
  };
}
