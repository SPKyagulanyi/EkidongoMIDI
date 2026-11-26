import {
  ArrangerEngine, GM_GROUPS, gmName, noteName,
  type ChordMode, type EngineCommand, type EngineStatus, type MainId, type Style, type VoiceSlot,
} from '@ekidongo/engine';
import { connectPorts, listPorts, panicNow, pushThru, runEngine, rustNow, send, syncClock } from './bridge.ts';
import {
  activeSetlist, BANK_SIZE, capture, loadLibrary, moveEntry, newId, recallPlan, saveLibrary, step,
  type Registration, type Setlist,
} from './library.ts';
import { loadStyles } from './styles.ts';

const $ = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing`);
  return e as T;
};
/** Create an element with properties and children. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids);
  return e;
}

const SAVED_PORTS = 'ekidongo.ports';
const SAVED_STYLE = 'ekidongo.style';
const SAVED_SETTINGS = 'ekidongo.settings';
const CATEGORY_ORDER = ['African', 'East African', 'Church', 'Caribbean', 'Latin', 'Pop & RnB', 'Ballroom & March'];
const MODE_NAMES: Record<ChordMode, string> = { fingered: 'Fingered', multi: 'Multi Finger', single: 'Single Finger' };

const { styles, errors } = loadStyles();
if (errors.length) console.warn('[styles] skipped invalid styles', errors);
let styleIndex = Math.max(0, styles.findIndex((s) => s.id === (localStorage.getItem(SAVED_STYLE) ?? 'afrobeat-live')));
let engine: ArrangerEngine | null = null;
let engineRunning = false;
let connectedPort = '';
const lib = loadLibrary();
let freeze = false;
let saving = false;

const SECTION_NAMES: Record<string, string> = { fillA: 'Fill', fillB: 'Fill', fillC: 'Fill', fillD: 'Fill', break: 'Break' };
const sectionName = (id: string) =>
  SECTION_NAMES[id] ?? id.replace(/^main/, 'Main ').replace(/^intro/, 'Intro ').replace(/^ending/, 'Ending ');

const status = (): EngineStatus | null => (engine ? engine.status(rustNow()) : null);
function command(cmd: EngineCommand) {
  engine?.command(cmd, rustNow());
}
function persist() {
  saveLibrary(lib);
}

// ---------- Pages ----------

type Page = 'settings' | 'perform' | 'mixer' | 'voices' | 'lists';
const PAGES: Page[] = ['settings', 'perform', 'mixer', 'voices', 'lists'];
function showPage(p: Page) {
  for (const id of PAGES) $(id).hidden = id !== p;
  if (p === 'mixer') renderMixer();
  if (p === 'lists') renderLists();
}
document.querySelectorAll<HTMLButtonElement>('[data-back]').forEach((b) =>
  b.addEventListener('click', () => (connectedPort ? showPage('perform') : showPage('settings'))),
);
$('mixerBtn').addEventListener('click', () => showPage('mixer'));
$('listsBtn').addEventListener('click', () => showPage('lists'));
$('settingsBtn').addEventListener('click', () => {
  void refreshPorts();
  syncSettingsForm();
  showPage('settings');
});

// ---------- Settings: devices ----------

async function refreshPorts(): Promise<{ inputs: string[]; outputs: string[] }> {
  const msg = $('connectMsg');
  try {
    const ports = await listPorts();
    const saved = savedPorts();
    fill($('inPort'), ports.inputs, saved?.input);
    fill($('outPort'), ports.outputs, saved?.output);
    msg.className = 'msg';
    msg.textContent = ports.outputs.length ? (connectedPort ? `Connected to ${connectedPort}.` : '') : 'No MIDI devices found. Is the keyboard on and plugged in?';
    if (connectedPort) msg.className = 'msg ok';
    return ports;
  } catch (e) {
    msg.textContent = `Could not list MIDI devices: ${String(e)}`;
    return { inputs: [], outputs: [] };
  }
}

function savedPorts(): { input: string; output: string } | null {
  try {
    return JSON.parse(localStorage.getItem(SAVED_PORTS) ?? 'null');
  } catch {
    return null;
  }
}

function fill(sel: HTMLSelectElement, names: string[], preferred?: string) {
  sel.innerHTML = '';
  for (const n of names) sel.add(new Option(n, n, false, preferred ? n === preferred : /roland|piano|keyboard/i.test(n)));
}

async function connect(input: string, output: string) {
  const msg = $('connectMsg');
  msg.className = 'msg';
  msg.textContent = 'Connecting…';
  try {
    await connectPorts(input, output);
    const { rttMs } = await syncClock();
    console.info(`[clock] synced, round trip ${rttMs.toFixed(2)} ms`);
    localStorage.setItem(SAVED_PORTS, JSON.stringify({ input, output }));
    connectedPort = output;
    msg.className = 'msg ok';
    msg.textContent = `Connected to ${output}.`;
    await startEngine();
    $('portName').textContent = output;
    showPage('perform');
  } catch (e) {
    msg.textContent = String(e);
  }
}

$('refresh').addEventListener('click', () => void refreshPorts());
$('connectBtn').addEventListener('click', () => {
  const input = $<HTMLSelectElement>('inPort').value;
  const output = $<HTMLSelectElement>('outPort').value;
  if (!input || !output) return void ($('connectMsg').textContent = 'Choose the keyboard for both.');
  void connect(input, output);
});

// ---------- Settings: playing options ----------

interface SavedSettings { chordMode?: ChordMode; splitPoint?: number; fadeMs?: number; syncStop?: boolean }
const savedSettings = (): SavedSettings => {
  try {
    return JSON.parse(localStorage.getItem(SAVED_SETTINGS) ?? '{}');
  } catch {
    return {};
  }
};
function storeSettings() {
  if (!engine) return;
  const c = engine.settings;
  localStorage.setItem(SAVED_SETTINGS, JSON.stringify({ chordMode: c.chordMode, splitPoint: c.splitPoint, fadeMs: c.fadeMs, syncStop: c.syncStop }));
}

const splitSel = $<HTMLSelectElement>('splitPoint');
for (let n = 36; n <= 72; n++) splitSel.add(new Option(noteName(n), String(n)));

function syncSettingsForm() {
  if (!engine) return;
  const c = engine.settings;
  $<HTMLSelectElement>('chordMode').value = c.chordMode;
  splitSel.value = String(c.splitPoint);
  $<HTMLSelectElement>('fadeMs').value = String(c.fadeMs);
  $<HTMLInputElement>('syncStopSetting').checked = c.syncStop;
}

function applyConfig(config: Parameters<ArrangerEngine['command']>[0] & { type: 'config' }) {
  if (!engine) return;
  command(config);
  void pushThru(engine.settings);
  storeSettings();
}
$('chordMode').addEventListener('change', (e) => applyConfig({ type: 'config', config: { chordMode: (e.target as HTMLSelectElement).value as ChordMode } }));
splitSel.addEventListener('change', () => applyConfig({ type: 'config', config: { splitPoint: Number(splitSel.value) } }));
$('fadeMs').addEventListener('change', (e) => applyConfig({ type: 'config', config: { fadeMs: Number((e.target as HTMLSelectElement).value) } }));
$('syncStopSetting').addEventListener('change', (e) => applyConfig({ type: 'config', config: { syncStop: (e.target as HTMLInputElement).checked } }));

// ---------- Engine ----------

async function startEngine() {
  const style = styles[styleIndex];
  if (!style) throw new Error('No styles available.');
  if (!engine) {
    const s = savedSettings();
    engine = new ArrangerEngine(style, {
      thruInEngine: false,
      ...(s.chordMode && { chordMode: s.chordMode }),
      ...(s.splitPoint && { splitPoint: s.splitPoint }),
      ...(s.fadeMs && { fadeMs: s.fadeMs }),
      ...(s.syncStop !== undefined && { syncStop: s.syncStop }),
    }, rustNow());
  } else send(engine.panic(rustNow())); // reconnecting: start clean
  await pushThru(engine.settings);
  if (!engineRunning) {
    await runEngine(() => engine!);
    engineRunning = true;
  }
  showStyle(styles[styleIndex]!);
}

/** "live drums" for styles with real drummer performances, "draft" for the programmed prototypes. */
function kindOf(s: Style): string {
  if (s.credits.some((c) => c.name.startsWith('Groove MIDI Dataset'))) return 'live drums';
  return s.status === 'prototype' ? 'draft' : s.status;
}
/** Attribution required by the drum licence (CC BY 4.0), shown wherever the style is described. */
function creditOf(s: Style): string {
  return s.credits.some((c) => c.name.startsWith('Groove MIDI Dataset')) ? 'Drums: Groove MIDI Dataset (Google, CC BY 4.0)' : '';
}

function showStyle(s: Style) {
  $('styleName').textContent = s.name;
  $('styleMeta').textContent = [s.category, s.timeSignature.join('/'), kindOf(s)].join(' · ');
  $('styleMeta').title = creditOf(s);
}

function selectStyle(i: number) {
  if (!engine || !styles[i]) return;
  styleIndex = i;
  engine.loadStyle(styles[i], rustNow());
  localStorage.setItem(SAVED_STYLE, styles[i].id);
  showStyle(styles[i]);
}

// ---------- Style browser ----------

let category = 'All';
function openBrowser() {
  category = styles[styleIndex]?.category ?? 'All';
  renderBrowser();
  $('browser').hidden = false;
  $('styleList').querySelector<HTMLButtonElement>('.current')?.focus();
}
function closeBrowser() {
  $('browser').hidden = true;
  $('styleBtn').focus();
}
function renderBrowser() {
  const cats = ['All', ...CATEGORY_ORDER.filter((c) => styles.some((s) => s.category === c)),
    ...[...new Set(styles.map((s) => s.category))].filter((c) => !CATEGORY_ORDER.includes(c))];
  $('categories').replaceChildren(...cats.map((c) => {
    const b = el('button', { textContent: c });
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(c === category));
    b.addEventListener('click', () => { category = c; renderBrowser(); });
    return b;
  }));
  const items: HTMLElement[] = [];
  styles.forEach((s, i) => {
    if (category !== 'All' && s.category !== category) return;
    const b = el('button', { className: i === styleIndex ? 'current' : '' },
      el('span', { className: 'name', textContent: s.name }),
      el('span', { className: 'muted small', textContent: `${s.timeSignature.join('/')} · ${Math.round(s.tempo)} BPM · ${kindOf(s)}` }));
    const credit = creditOf(s);
    if (credit) b.append(el('span', { className: 'muted small', textContent: credit }));
    b.addEventListener('click', () => { selectStyle(i); closeBrowser(); });
    items.push(el('li', {}, b));
  });
  $('styleList').replaceChildren(...items);
}
$('styleBtn').addEventListener('click', openBrowser);
$('browserClose').addEventListener('click', closeBrowser);

// ---------- Tempo: type it, +/-, or tap ----------

const tempoInput = $<HTMLInputElement>('tempoInput');
function setTempo(bpm: number) {
  if (!Number.isFinite(bpm)) return;
  command({ type: 'tempo', bpm: Math.max(20, Math.min(300, Math.round(bpm))) });
}
tempoInput.addEventListener('change', () => setTempo(Number(tempoInput.value)));
tempoInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { setTempo(Number(tempoInput.value)); tempoInput.blur(); }
  e.stopPropagation(); // typing digits must not trigger shortcuts
});
const currentTempo = () => status()?.tempo ?? 120;
$('tempoDown').addEventListener('click', () => setTempo(currentTempo() - 1));
$('tempoUp').addEventListener('click', () => setTempo(currentTempo() + 1));

/**
 * Tap tempo (arranger-keyboard behaviour):
 * - Stopped: tap one bar of beats; the tempo is set from the taps and the band starts on the next
 *   downbeat, exactly where the next tap would fall.
 * - Playing: every tap from the 3rd on adjusts the tempo to the average of the recent taps.
 */
let taps: number[] = [];
const tapBtn = $('tapBtn');
function tap() {
  if (!engine) return;
  const t = rustNow();
  if (taps.length && t - taps[taps.length - 1]! > 2000) taps = [];
  taps = [...taps, t].slice(-8);
  const s = engine.status(t);
  const gaps = taps.slice(1).map((x, i) => x - taps[i]!);
  const avg = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const bpm = avg ? (60000 / avg) * s.quartersPerBeat : 0;
  if (s.running) {
    if (taps.length >= 3) setTempo(bpm);
    tapBtn.textContent = 'Tap';
    return;
  }
  tapBtn.textContent = `${taps.length} / ${s.beatsPerBar}`;
  if (taps.length >= s.beatsPerBar) {
    setTempo(bpm);
    command({ type: 'start', at: t + avg });
    taps = [];
    setTimeout(() => (tapBtn.textContent = 'Tap'), 400);
  }
}
tapBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); tap(); });
tapBtn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); tap(); }
});

// ---------- Sections, transport, reset sound ----------

document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((b) => {
  b.addEventListener('click', () => {
    const c = b.dataset.cmd;
    const n = Number(b.dataset.n) as 1 | 2 | 3;
    if (c === 'main') command({ type: 'main', id: b.dataset.id as MainId });
    else if (c === 'intro') command({ type: 'intro', n });
    else if (c === 'ending') command({ type: 'ending', n });
    else if (c === 'fill') command({ type: 'fill' });
    else if (c === 'break') command({ type: 'break' });
  });
});

let lastStopPress = 0;
function startStop() {
  const s = status();
  if (!s) return;
  const t = performance.now();
  if (!s.running && t - lastStopPress < 600) { // Logic Pro convention: Stop twice resets sound
    resetSound();
    lastStopPress = 0;
    return;
  }
  if (s.running) lastStopPress = t;
  command({ type: 'toggleStart' });
}
$('startStop').addEventListener('click', startStop);
$('sync').addEventListener('click', () => command({ type: 'config', config: { syncStart: !engine?.settings.syncStart } }));
$('syncStop').addEventListener('click', () => applyConfig({ type: 'config', config: { syncStop: !engine?.settings.syncStop } }));
$('fadeBtn').addEventListener('click', () => command({ type: status()?.running ? 'fadeOut' : 'fadeIn' }));
$('resetBtn').addEventListener('click', resetSound);
function resetSound() {
  if (!engine) return;
  send(engine.panic(rustNow()));
  void panicNow();
}

// ---------- Voices ----------

let voiceSlot: VoiceSlot = 'right';
let voiceGroup = 0;
function openVoices(slot: VoiceSlot) {
  voiceSlot = slot;
  voiceGroup = Math.floor((engine?.settings.voices[slot].program ?? 0) / 8);
  $('voicesTitle').textContent = slot === 'right' ? 'Right-hand voice' : slot === 'layer' ? 'Layer voice' : 'Left-hand voice';
  renderVoices();
  showPage('voices');
}
function renderVoices() {
  const current = engine?.settings.voices[voiceSlot].program ?? 0;
  $('voiceGroups').replaceChildren(...GM_GROUPS.map((g, i) => {
    const b = el('button', { textContent: g });
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(i === voiceGroup));
    b.addEventListener('click', () => { voiceGroup = i; renderVoices(); });
    return b;
  }));
  const items: HTMLElement[] = [];
  for (let p = voiceGroup * 8; p < voiceGroup * 8 + 8; p++) {
    const b = el('button', { className: p === current ? 'current' : '', textContent: gmName(p) });
    b.addEventListener('click', () => {
      command({ type: 'voice', slot: voiceSlot, program: p });
      if (voiceSlot === 'layer' && !engine?.settings.layerOn) applyConfig({ type: 'config', config: { layerOn: true } });
      renderVoices();
    });
    items.push(el('li', {}, b));
  }
  $('voiceList').replaceChildren(...items);
}
$('rightVoice').addEventListener('click', () => openVoices('right'));
$('layerChange').addEventListener('click', () => openVoices('layer'));
$('layerToggle').addEventListener('click', () => applyConfig({ type: 'config', config: { layerOn: !engine?.settings.layerOn } }));

// ---------- Mixer ----------

function renderMixer() {
  const s = status();
  if (!s) return;
  const rows: HTMLElement[] = [];
  const row = (label: string, role: string, volume: number, onVolume: (v: number) => void, mute?: { muted: boolean; toggle: () => void }) => {
    const val = el('span', { className: 'val', textContent: String(volume) });
    const range = el('input', { type: 'range', min: '0', max: '127', value: String(volume) });
    range.setAttribute('aria-label', `${label} volume`);
    range.addEventListener('input', () => { val.textContent = range.value; onVolume(Number(range.value)); });
    const m = el('button', { textContent: mute ? (mute.muted ? 'Muted' : 'Mute') : '—', disabled: !mute });
    if (mute) {
      m.setAttribute('aria-pressed', String(mute.muted));
      m.addEventListener('click', () => { mute.toggle(); renderMixer(); });
    }
    rows.push(el('div', { className: 'mix-row' }, el('div', {}, el('div', { textContent: label }), el('div', { className: 'muted small', textContent: role })), m, range, val));
  };
  for (const p of s.parts) {
    row(p.name, `${p.role} part`, p.volume, (v) => command({ type: 'partVolume', part: p.id, volume: v }),
      { muted: p.muted, toggle: () => command({ type: 'mute', part: p.id, muted: !p.muted }) });
  }
  for (const slot of ['right', 'layer', 'left'] as const) {
    row(`${slot === 'right' ? 'Right hand' : slot === 'layer' ? 'Layer' : 'Left hand'}: ${gmName(s.voices[slot].program)}`, 'your voice',
      s.voices[slot].volume, (v) => command({ type: 'voice', slot, volume: v }));
  }
  $('mixerRows').replaceChildren(...rows);
}

// ---------- Registrations (bank of 8, Save, Freeze) ----------

function recall(reg: Registration) {
  const s = status();
  if (!s || !engine) return;
  const plan = recallPlan(reg, s, freeze);
  if (plan.styleId) {
    const i = styles.findIndex((x) => x.id === plan.styleId);
    if (i >= 0) selectStyle(i);
    else console.warn(`[registration] style ${plan.styleId} is no longer installed`);
  }
  for (const c of plan.commands) command(c);
  void pushThru(engine.settings);
  storeSettings();
}

function renderRegs() {
  const buttons = lib.bank.map((reg, i) => {
    const b = el('button', { className: [reg ? 'filled' : '', saving ? 'saving' : ''].join(' ') },
      el('b', { textContent: String(i + 1) }), el('span', { textContent: reg ? reg.name : 'empty' }));
    b.title = reg ? `${reg.name} · ${reg.tempo} BPM` : 'Empty: press Save, then this button';
    b.addEventListener('click', () => pressReg(i));
    return b;
  });
  $('regButtons').replaceChildren(...buttons);
  $('saveReg').setAttribute('aria-pressed', String(saving));
  $('freeze').setAttribute('aria-pressed', String(freeze));
}
function pressReg(i: number) {
  const s = status();
  if (!s || !engine) return;
  const reg = lib.bank[i];
  if (saving || !reg) {
    const style = styles[styleIndex];
    lib.bank[i] = capture(`${style?.name.replace(' · Live Drums', '') ?? 'Setup'} ${Math.round(s.tempo)}`, s, engine.settings.splitPoint);
    saving = false;
    persist();
  } else recall(reg);
  renderRegs();
}
$('saveReg').addEventListener('click', () => { saving = !saving; renderRegs(); });
$('freeze').addEventListener('click', () => { freeze = !freeze; renderRegs(); });

// ---------- Set lists ----------

let editing: string | null = null;
let confirmDelete = false;
function renderLists() {
  const items = lib.setlists.map((l) => {
    const b = el('button', { className: l.id === editing ? 'current' : '' },
      el('span', { textContent: l.name }), el('span', { className: 'muted small', textContent: ` · ${l.entries.length} songs${l.id === lib.activeSetlist ? ' · on stage' : ''}` }));
    b.addEventListener('click', () => { editing = l.id; confirmDelete = false; renderLists(); });
    return el('li', {}, b);
  });
  $('listNames').replaceChildren(...items);
  const list = lib.setlists.find((l) => l.id === editing);
  $('listDetail').hidden = !list;
  if (!list) return;
  $<HTMLInputElement>('listName').value = list.name;
  $('deleteList').textContent = confirmDelete ? 'Tap again to delete' : 'Delete list';
  $('useList').textContent = list.id === lib.activeSetlist ? 'Stop using' : 'Use on stage';
  $('entries').replaceChildren(...list.entries.map((e, i) => {
    const btn = (label: string, aria: string, fn: () => void) => {
      const b = el('button', { textContent: label });
      b.setAttribute('aria-label', aria);
      b.addEventListener('click', () => { fn(); persist(); renderLists(); });
      return b;
    };
    const styleName = styles.find((s) => s.id === e.reg.styleId)?.name ?? e.reg.styleId;
    return el('li', {},
      el('div', { className: 'etitle' }, el('span', { textContent: e.title }), el('span', { className: 'muted small', textContent: `${styleName} · ${e.reg.tempo} BPM` })),
      btn('↑', `Move ${e.title} up`, () => moveEntry(list, i, i - 1)),
      btn('↓', `Move ${e.title} down`, () => moveEntry(list, i, i + 1)),
      btn('Update', `Replace ${e.title} with the current setup`, () => { const s = status(); if (s && engine) e.reg = capture(e.title, s, engine.settings.splitPoint); }),
      btn('✕', `Remove ${e.title}`, () => list.entries.splice(i, 1)));
  }));
}
$('newList').addEventListener('click', () => {
  const name = $<HTMLInputElement>('newListName').value.trim() || `Set list ${lib.setlists.length + 1}`;
  const list: Setlist = { id: newId(), name, entries: [] };
  lib.setlists.push(list);
  editing = list.id;
  $<HTMLInputElement>('newListName').value = '';
  persist();
  renderLists();
});
$('listName').addEventListener('change', () => {
  const list = lib.setlists.find((l) => l.id === editing);
  if (list) { list.name = $<HTMLInputElement>('listName').value.trim() || list.name; persist(); renderLists(); }
});
$('addEntry').addEventListener('click', () => {
  const list = lib.setlists.find((l) => l.id === editing);
  const s = status();
  if (!list || !s || !engine) return;
  const title = $<HTMLInputElement>('entryTitle').value.trim() || `Song ${list.entries.length + 1}`;
  list.entries.push({ title, reg: capture(title, s, engine.settings.splitPoint) });
  $<HTMLInputElement>('entryTitle').value = '';
  persist();
  renderLists();
});
$('useList').addEventListener('click', () => {
  const list = lib.setlists.find((l) => l.id === editing);
  if (!list) return;
  if (lib.activeSetlist === list.id) lib.activeSetlist = null;
  else {
    lib.activeSetlist = list.id;
    lib.position = 0;
    const first = list.entries[0];
    if (first) recall(first.reg);
  }
  persist();
  renderLists();
});
$('deleteList').addEventListener('click', () => {
  if (!confirmDelete) { confirmDelete = true; renderLists(); return; }
  lib.setlists = lib.setlists.filter((l) => l.id !== editing);
  if (lib.activeSetlist === editing) lib.activeSetlist = null;
  editing = null;
  confirmDelete = false;
  persist();
  renderLists();
});
function songStep(delta: number) {
  const e = step(lib, delta);
  if (e) { recall(e.reg); persist(); }
}
$('prevSong').addEventListener('click', () => songStep(-1));
$('nextSong').addEventListener('click', () => songStep(1));

// ---------- Keyboard ----------

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
  if (!$('browser').hidden) {
    if (e.key === 'Escape') closeBrowser();
    return;
  }
  if (!engine || $('perform').hidden) return;
  const k = e.key.toLowerCase();
  const mains: Record<string, MainId> = { a: 'mainA', b: 'mainB', c: 'mainC', d: 'mainD' };
  if (k === ' ') startStop();
  else if (mains[k]) command({ type: 'main', id: mains[k] });
  else if (k === 'f') command({ type: 'fill' });
  else if (k === 'e') command({ type: 'ending', n: 1 });
  else if (k === 's') openBrowser();
  else if (k >= '1' && k <= String(BANK_SIZE)) pressReg(Number(k) - 1);
  else if (k === 'pagedown') songStep(1);
  else if (k === 'pageup') songStep(-1);
  else if (k === 'arrowup') setTempo(currentTempo() + 1);
  else if (k === 'arrowdown') setTempo(currentTempo() - 1);
  else if (k === 'escape') resetSound();
  else return;
  e.preventDefault();
});

// ---------- Screen refresh ----------

function sectionIdOf(b: HTMLButtonElement): string {
  const c = b.dataset.cmd;
  if (c === 'main') return b.dataset.id!;
  if (c === 'fill' || c === 'break') return c;
  return `${c}${b.dataset.n ?? ''}`;
}

function render() {
  const s = !$('perform').hidden ? status() : null;
  if (s && engine) {
    $('chord').textContent = s.chord;
    $('modeName').textContent = MODE_NAMES[s.chordMode];
    $('splitName').textContent = noteName(engine.settings.splitPoint);
    if (document.activeElement !== tempoInput) tempoInput.value = String(Math.round(s.tempo));
    $('nowLabel').textContent = s.fading ? `Fading ${s.fading}` : s.running ? 'Now playing' : s.syncStart ? 'Waiting for your left hand' : 'Stopped';
    $('section').textContent = sectionName(s.running ? s.section : s.lastMain);
    $('next').textContent = s.queue.length
      ? `Next at the bar line: ${s.queue.map(sectionName).join(' → ')}`
      : s.running ? 'Press Main A–D for a fill and change' : 'Press Start, an Intro, or play a chord';
    const beats = $('beats');
    if (beats.childElementCount !== s.beatsPerBar) beats.innerHTML = '<span></span>'.repeat(s.beatsPerBar);
    [...beats.children].forEach((d, i) => (d.className = s.running && s.beat === i ? (i === 0 ? 'on first' : 'on') : ''));
    const has = new Set(s.available);
    document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((b) => {
      const id = sectionIdOf(b);
      const isFill = id === 'fill';
      const available = isFill ? s.available.some((x) => x.startsWith('fill')) : has.has(id);
      b.disabled = !available;
      b.title = available ? '' : 'This style has no such section';
      const playing = s.running && (isFill ? s.section.startsWith('fill') : s.section === id);
      const queued = isFill ? s.queue.some((q) => q.startsWith('fill')) : s.queue.includes(id);
      b.classList.toggle('active', playing);
      b.classList.toggle('queued', !playing && queued);
      b.classList.toggle('selected', !s.running && b.dataset.id === s.lastMain);
    });
    $('sync').setAttribute('aria-pressed', String(s.syncStart));
    $('syncStop').setAttribute('aria-pressed', String(s.syncStop));
    $('fadeBtn').textContent = s.running ? 'Fade Out' : 'Fade In';
    $('fadeBtn').classList.toggle('active', s.fading !== null);
    const ss = $('startStop');
    ss.textContent = s.running ? 'Stop' : 'Start';
    ss.classList.toggle('running', s.running);
    $('rightName').textContent = gmName(s.voices.right.program);
    $('layerName').textContent = gmName(s.voices.layer.program);
    $('layerState').textContent = `Layer · ${s.layerOn ? 'on' : 'off'}`;
    $('layerToggle').setAttribute('aria-pressed', String(s.layerOn));
    const list = activeSetlist(lib);
    $('setlistStrip').hidden = !list || list.entries.length === 0;
    if (list && list.entries.length) {
      $('setlistName').textContent = `${list.name} · song ${lib.position + 1} of ${list.entries.length}`;
      $('songTitle').textContent = list.entries[lib.position]?.title ?? '';
      $<HTMLButtonElement>('prevSong').disabled = lib.position <= 0;
      $<HTMLButtonElement>('nextSong').disabled = lib.position >= list.entries.length - 1;
    }
  }
  requestAnimationFrame(render);
}

// ---------- Startup: reconnect to the last keyboard automatically ----------

window.addEventListener('beforeunload', () => void panicNow());
renderRegs();
requestAnimationFrame(render);
void (async () => {
  const ports = await refreshPorts();
  const saved = savedPorts();
  if (saved && ports.inputs.includes(saved.input) && ports.outputs.includes(saved.output)) {
    await connect(saved.input, saved.output);
    if (connectedPort) return;
  }
  showPage('settings');
})();

// Keep the mixer in sync while it is open (e.g. a registration recalled with a key).
setInterval(() => { if (!$('mixer').hidden && document.activeElement?.tagName !== 'INPUT') renderMixer(); }, 1000);
