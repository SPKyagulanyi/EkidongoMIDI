/**
 * Recorder page: record parts from the keyboard (or import them from MIDI files) into your own copy
 * of a style, section by section, then save it to "My styles".
 *
 * While recording: the chosen section loops with the rest of the band, the chord is fixed to the
 * style's source chord (C major 7), the whole keyboard plays the part's own sound (the Rust
 * pass-through is pointed at the part's channel), and every note is captured with its exact time.
 */
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import {
  addPart, barTicks, captureToPhrase, emptyStyle, GM_VOICES, makeChord, parseSmf, phraseFromMidi, quantize,
  SECTION_IDS, setSectionBars, validateStyle, writePhrase,
  type ArrangerEngine, type MidiEvent, type NoteEvent, type Part, type SectionId, type Style, type TimedMessage,
} from '@ekidongo/engine';
import { readMidiFile, saveUserStyle, writeSetupFile } from './bridge.ts';

export interface RecorderContext {
  engine(): ArrangerEngine | null;
  currentStyle(): Style | undefined;
  styles: Style[];
  selectStyleById(id: string): void;
  rustNow(): number;
  send(evs: MidiEvent[]): void;
  pushThru(): Promise<void>;
  report(e: unknown, context?: Record<string, unknown>): void;
}

const SECTION_LABELS: Record<SectionId, string> = {
  intro1: 'Intro 1', intro2: 'Intro 2', intro3: 'Intro 3', mainA: 'Main A', mainB: 'Main B', mainC: 'Main C', mainD: 'Main D',
  fillA: 'Fill A', fillB: 'Fill B', fillC: 'Fill C', fillD: 'Fill D', break: 'Break', ending1: 'Ending 1', ending2: 'Ending 2', ending3: 'Ending 3',
};
const ROLE_LABELS: Record<Part['role'], string> = { drums: 'drums', bass: 'bass', chord: 'chords', pad: 'pad', phrase: 'melody' };
const NEW_PART = '__new';

const $ = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing`);
  return e as T;
};

interface Take {
  section: SectionId;
  partId: string;
  phrase: NoteEvent[];
  mode: 'replace' | 'add';
}

export function createRecorder(ctx: RecorderContext) {
  let working: Style | null = null;
  let original: string | null = null; // the style that was playing before the recorder opened
  let history: Style[] = [];
  let take: Take | null = null;
  let busy = false;
  let dirty = false;
  let finishRecording: ((cancel: boolean) => void) | null = null;
  let savedSyncStart = true;
  let midi: ReturnType<typeof parseSmf> | null = null;

  const status = (text: string) => ($('recStatus').textContent = text);
  const sel = (id: string) => $<HTMLSelectElement>(id);

  // Instrument list for new parts (all 128 GM voices).
  sel('newPartProgram').replaceChildren(...GM_VOICES.map((v, i) => new Option(v, String(i), false, i === 33)));

  function load() {
    const eng = ctx.engine();
    if (!eng || !working) return;
    eng.loadStyle(working, ctx.rustNow());
    // Record over the source chord, so the part follows every chord later.
    const src = working.sourceChord;
    eng.command({ type: 'chord', chord: makeChord(src.root, src.quality) }, ctx.rustNow());
  }

  function uniqueId(base: string): string {
    let id = base;
    for (let i = 2; ctx.styles.some((s) => s.id === id); i++) id = `${base}-${i}`;
    return id;
  }

  function open() {
    const eng = ctx.engine();
    const cur = ctx.currentStyle();
    if (!eng || !cur) return;
    original = cur.id;
    savedSyncStart = eng.settings.syncStart;
    eng.command({ type: 'config', config: { syncStart: false } }, ctx.rustNow());
    if (cur.category === 'My styles') working = JSON.parse(JSON.stringify(cur)) as Style;
    else {
      working = JSON.parse(JSON.stringify(cur)) as Style;
      working.id = uniqueId(`${cur.id.replace(/-live$/, '')}-mine`);
      working.name = `${cur.name.replace(' · Live Drums', '')} (mine)`;
      working.category = 'My styles';
      working.status = 'in-review';
    }
    history = [];
    take = null;
    dirty = false;
    load();
    render();
    status('Ready.');
  }

  function close() {
    finishRecording?.(true);
    const eng = ctx.engine();
    if (eng) {
      eng.command({ type: 'stop' }, ctx.rustNow());
      eng.command({ type: 'unloop' }, ctx.rustNow());
      eng.command({ type: 'config', config: { syncStart: savedSyncStart } }, ctx.rustNow());
    }
    if (original) ctx.selectStyleById(original);
    working = null;
  }

  function render() {
    if (!working) return;
    const w = working;
    $('recStyleLabel').textContent = `${w.name} · ${w.timeSignature.join('/')} · ${Math.round(w.tempo)} BPM${dirty ? ' · unsaved changes' : ''}`;
    $<HTMLInputElement>('recName').value = w.name;
    const secSel = sel('recSection');
    const keepSec = secSel.value || 'mainA';
    secSel.replaceChildren(...SECTION_IDS.map((id) => {
      const s = w.sections[id];
      return new Option(`${SECTION_LABELS[id]}${s ? ` (${s.bars} bar${s.bars > 1 ? 's' : ''})` : ' (empty)'}`, id, false, id === keepSec);
    }));
    const sec = w.sections[secSel.value as SectionId];
    sel('recBars').value = String(sec?.bars ?? 2);
    const partSel = sel('recPart');
    const keepPart = partSel.value;
    partSel.replaceChildren(
      ...w.parts.map((p) => {
        const n = sec?.phrases[p.id]?.length ?? 0;
        return new Option(`${p.name} (${ROLE_LABELS[p.role]}, ${GM_VOICES[p.program] ?? ''})${n ? ` · ${n} notes here` : ''}`, p.id, false, p.id === keepPart);
      }),
      new Option('+ New part…', NEW_PART),
    );
    if (!w.parts.some((p) => p.id === partSel.value) && partSel.value !== NEW_PART) partSel.value = w.parts[0]?.id ?? NEW_PART;
    $('newPartBox').hidden = partSel.value !== NEW_PART;
    const part = w.parts.find((p) => p.id === partSel.value);
    $('recHint').textContent = !part
      ? 'Add a part first: give it a name, a role and an instrument.'
      : part.role === 'drums'
        ? 'Drums: every key is a drum sound (General MIDI layout): C2 kick, D2 snare, F#2 closed hi-hat, A#2 open hi-hat, C#3 crash, D#3 ride. The whole keyboard plays drums while you record.'
        : `Play in C major 7: chord notes C, E, G, B (melodies in C major). EkidongoMIDI moves your ${ROLE_LABELS[part.role]} to every chord later. The whole keyboard plays this part's sound while you record.`;
    $('recTake').hidden = !take;
    $<HTMLButtonElement>('recUndo').disabled = history.length === 0;
    $('recRecord').textContent = busy ? '■ Stop recording' : '● Record';
    $('recRecord').classList.toggle('recording', busy);
  }

  function change(next: Style) {
    if (!working) return;
    history.push(working);
    working = next;
    dirty = true;
    load();
    render();
  }

  async function record() {
    if (busy) return finishRecording?.(true);
    const eng = ctx.engine();
    if (!eng || !working) return;
    const section = sel('recSection').value as SectionId;
    const bars = Number(sel('recBars').value);
    const part = working.parts.find((p) => p.id === sel('recPart').value);
    if (!part) return status('Choose or add a part to record first.');
    if (working.sections[section]?.bars !== bars) {
      working = setSectionBars(working, section, bars);
      dirty = true;
    }
    load();
    const mode = sel('recMode').value as 'replace' | 'add';
    const tempo = eng.status(ctx.rustNow()).tempo;
    const beatsPerBar = eng.status(ctx.rustNow()).beatsPerBar;
    const ticks = barTicks(working);
    const barMs = (ticks * 60000) / (tempo * working.ppq);
    const beatMs = barMs / beatsPerBar;
    const countIn = $<HTMLInputElement>('recCountIn').checked;
    const metronome = $<HTMLInputElement>('recClick').checked;

    // Hear the part being recorded on its own channel, from the whole keyboard.
    const prev = { splitEnabled: eng.settings.splitEnabled, rightChannel: eng.settings.rightChannel };
    if (mode === 'replace') eng.command({ type: 'mute', part: part.id, muted: true }, ctx.rustNow());
    eng.command({ type: 'config', config: { splitEnabled: false, rightChannel: part.channel } }, ctx.rustNow());
    await ctx.pushThru();

    const t0 = ctx.rustNow() + 200 + (countIn ? barMs : 0);
    const end = t0 + bars * barMs;
    const clicks: MidiEvent[] = [];
    const click = (t: number, accent: boolean) => {
      const n = accent ? 76 : 77;
      clicks.push({ t, data: [0x99, n, accent ? 120 : 85] }, { t: t + 40, data: [0x89, n, 0] });
    };
    if (countIn) for (let b = 0; b < beatsPerBar; b++) click(t0 - barMs + b * beatMs, b === 0);
    if (metronome) for (let b = 0; b < bars * beatsPerBar; b++) click(t0 + b * beatMs, b % beatsPerBar === 0);
    ctx.send(clicks);
    eng.command({ type: 'loop', section, at: t0 }, ctx.rustNow());

    const messages: TimedMessage[] = [];
    const unlisten: UnlistenFn = await listen<{ t: number; data: number[] }>('midi-in', (e) => {
      const k = (e.payload.data[0] ?? 0) & 0xf0;
      if (k === 0x80 || k === 0x90) messages.push({ t: e.payload.t, data: e.payload.data });
    });
    busy = true;
    take = null;
    render();

    let done = false;
    const timer = setInterval(() => {
      const now = ctx.rustNow();
      if (now < t0) status(`Count-in… ${Math.ceil((t0 - now) / beatMs)}`);
      else if (now < end) status(`Recording: bar ${Math.floor((now - t0) / barMs) + 1} of ${bars}`);
      else finish(false);
    }, 40);

    const finish = (cancel: boolean) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      unlisten();
      const now = ctx.rustNow();
      eng.command({ type: 'stop' }, now);
      eng.command({ type: 'unloop' }, now);
      if (mode === 'replace') eng.command({ type: 'mute', part: part.id, muted: false }, now);
      eng.command({ type: 'config', config: prev }, now);
      void ctx.pushThru();
      busy = false;
      finishRecording = null;
      if (cancel) {
        status('Recording cancelled.');
      } else {
        let phrase = captureToPhrase(messages, { startMs: t0, tempo, lengthTicks: bars * ticks });
        const grid = Number(sel('recQuantize').value);
        if (grid > 0) phrase = quantize(phrase, grid, Number(sel('recStrength').value));
        take = { section, partId: part.id, phrase, mode };
        status(phrase.length
          ? `Recorded ${phrase.length} notes. Press ▶ to hear the section as it was, then keep or discard this take.`
          : 'No notes were recorded. Is the keyboard connected? Try again.');
        if (!phrase.length) take = null;
      }
      render();
    };
    finishRecording = finish;
  }

  function play() {
    const eng = ctx.engine();
    if (!eng || !working || busy) return;
    load();
    eng.command({ type: 'loop', section: sel('recSection').value as SectionId, at: ctx.rustNow() + 80 }, ctx.rustNow());
    status('Playing the section. Press ■ Stop to stop.');
  }

  function stop() {
    if (busy) return finishRecording?.(true);
    const eng = ctx.engine();
    if (!eng) return;
    eng.command({ type: 'stop' }, ctx.rustNow());
    eng.command({ type: 'unloop' }, ctx.rustNow());
    status('Stopped.');
  }

  function keep() {
    if (!working || !take) return;
    const t = take;
    take = null;
    change(writePhrase(working, t.section, t.partId, t.phrase, t.mode));
    status(`Kept: ${t.phrase.length} notes in ${SECTION_LABELS[t.section]}. Press ▶ to hear it.`);
  }

  async function save() {
    if (!working) return;
    const name = $<HTMLInputElement>('recName').value.trim();
    if (name) working = { ...working, name };
    const r = validateStyle(working);
    if (!r.ok) return status(`Can't save yet: ${r.errors[0]}`);
    try {
      await saveUserStyle(r.style.id, JSON.stringify(r.style, null, 1));
      const i = ctx.styles.findIndex((s) => s.id === r.style.id);
      if (i >= 0) ctx.styles[i] = r.style;
      else ctx.styles.push(r.style);
      original = r.style.id; // leaving the recorder now plays your saved style
      dirty = false;
      render();
      status(`Saved "${r.style.name}" to My styles.`);
    } catch (e) {
      ctx.report(e, { step: 'save-user-style' });
      status(`Could not save: ${String(e)}`);
    }
  }

  async function exportStyle() {
    if (!working) return;
    const r = validateStyle(working);
    if (!r.ok) return status(`Can't export yet: ${r.errors[0]}`);
    try {
      const path = await saveDialog({ defaultPath: `${r.style.id}.json`, filters: [{ name: 'EkidongoMIDI style', extensions: ['json'] }] });
      if (!path) return;
      await writeSetupFile(path, JSON.stringify(r.style, null, 1));
      status(`Exported to ${path}`);
    } catch (e) {
      ctx.report(e, { step: 'export-style' });
      status(`Could not export: ${String(e)}`);
    }
  }

  async function importMidi() {
    if (!working) return;
    try {
      const path = await openDialog({ multiple: false, directory: false, filters: [{ name: 'MIDI file', extensions: ['mid', 'midi'] }] });
      if (typeof path !== 'string') return;
      midi = parseSmf(await readMidiFile(path));
      const counts = new Map<number, number>();
      for (const n of midi.notes) counts.set(n.channel, (counts.get(n.channel) ?? 0) + 1);
      if (counts.size === 0) return status('That MIDI file has no notes.');
      sel('midiChannel').replaceChildren(...[...counts].sort((a, b) => a[0] - b[0]).map(([c, n]) =>
        new Option(`Channel ${c + 1}${c === 9 ? ' (drums)' : ''}: ${n} notes`, String(c))));
      const fileBar = midi.ppq * 4 * ((midi.timeSignature?.[0] ?? 4) / (midi.timeSignature?.[1] ?? 4));
      const lastBar = Math.max(1, Math.ceil((midi.notes.at(-1)?.tick ?? 0) / fileBar));
      sel('midiFromBar').replaceChildren(...Array.from({ length: lastBar }, (_, i) => new Option(`Bar ${i + 1}`, String(i))));
      $('midiChooser').hidden = false;
      status(`Opened ${path.split(/[\\/]/).pop()}. Choose the track and the bar to start from.`);
    } catch (e) {
      status(`Could not read that MIDI file: ${String(e instanceof Error ? e.message : e)}`);
    }
  }

  function useMidi() {
    if (!working || !midi) return;
    const section = sel('recSection').value as SectionId;
    const bars = Number(sel('recBars').value);
    if (working.sections[section]?.bars !== bars) working = setSectionBars(working, section, bars);
    const partId = sel('recPart').value;
    if (!working.parts.some((p) => p.id === partId)) return status('Choose or add a part first.');
    const phrase = phraseFromMidi(midi.notes, {
      ppq: midi.ppq, channel: Number(sel('midiChannel').value), fromBar: Number(sel('midiFromBar').value), bars, barTicks: barTicks(working),
    });
    take = { section, partId, phrase, mode: sel('recMode').value as 'replace' | 'add' };
    $('midiChooser').hidden = true;
    status(`${phrase.length} notes ready from the MIDI file. Keep or discard them.`);
    render();
  }

  // ----- events -----
  $('recRecord').addEventListener('click', () => void record());
  $('recPlay').addEventListener('click', play);
  $('recStop').addEventListener('click', stop);
  $('recKeep').addEventListener('click', keep);
  $('recDiscard').addEventListener('click', () => { take = null; status('Take discarded.'); render(); });
  $('recUndo').addEventListener('click', () => {
    const prev = history.pop();
    if (!prev) return;
    working = prev;
    dirty = true;
    load();
    render();
    status('Undone.');
  });
  $('recSave').addEventListener('click', () => void save());
  $('recExport').addEventListener('click', () => void exportStyle());
  $('recImport').addEventListener('click', () => void importMidi());
  $('midiUse').addEventListener('click', useMidi);
  sel('recSection').addEventListener('change', render);
  sel('recPart').addEventListener('change', render);
  $<HTMLInputElement>('recName').addEventListener('change', () => {
    if (!working) return;
    working = { ...working, name: $<HTMLInputElement>('recName').value.trim() || working.name };
    dirty = true;
    render();
  });
  $('addPart').addEventListener('click', () => {
    if (!working) return;
    const name = $<HTMLInputElement>('newPartName').value.trim() || 'New part';
    try {
      const r = addPart(working, { name, role: sel('newPartRole').value as Part['role'], program: Number(sel('newPartProgram').value) });
      change(r.style);
      sel('recPart').value = r.partId;
      $<HTMLInputElement>('newPartName').value = '';
      render();
      status(`Added ${name}.`);
    } catch (e) {
      status(String(e instanceof Error ? e.message : e));
    }
  });
  $('newStyle').addEventListener('click', () => {
    const name = $<HTMLInputElement>('newStyleName').value.trim();
    if (!name) return status('Give the new style a name first.');
    const [num, den] = sel('newStyleMeter').value.split('/').map(Number) as [number, 2 | 4 | 8 | 16];
    const tempo = Math.max(20, Math.min(300, Number($<HTMLInputElement>('newStyleTempo').value) || 100));
    const style = emptyStyle({ id: uniqueId(name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-style'), name, tempo, timeSignature: [num, den] });
    if (working) history.push(working);
    working = style;
    dirty = true;
    load();
    render();
    status(`New style "${name}" created. Record its drums first, then bass and chords.`);
  });

  return { open, close, isBusy: () => busy, hasUnsaved: () => dirty };
}
