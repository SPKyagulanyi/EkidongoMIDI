import { ArrangerEngine, noteName, type EngineCommand, type MainId, type Style } from '@ekidongo/engine';
import { connectPorts, listPorts, panicNow, pushThru, runEngine, rustNow, send, syncClock } from './bridge.ts';
import { loadStyles } from './styles.ts';

const $ = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing`);
  return e as T;
};

const SAVED_PORTS = 'ekidongo.ports';
const SAVED_STYLE = 'ekidongo.style';
const CATEGORY_ORDER = ['African', 'East African', 'Church', 'Caribbean', 'Latin', 'Pop & RnB', 'Ballroom & March'];

const { styles, errors } = loadStyles();
if (errors.length) console.warn('[styles] skipped invalid styles', errors);
let styleIndex = Math.max(0, styles.findIndex((s) => s.id === (localStorage.getItem(SAVED_STYLE) ?? 'afrobeat')));
let engine: ArrangerEngine | null = null;
let engineRunning = false;
let connectedPort = '';

const SECTION_NAMES: Record<string, string> = { fillA: 'Fill', fillB: 'Fill', fillC: 'Fill', fillD: 'Fill', break: 'Break' };
const sectionName = (id: string) =>
  SECTION_NAMES[id] ?? id.replace(/^main/, 'Main ').replace(/^intro/, 'Intro ').replace(/^ending/, 'Ending ');

// ---------- Pages ----------

type Page = 'devices' | 'perform';
function showPage(p: Page) {
  $('devices').hidden = p !== 'devices';
  $('perform').hidden = p !== 'perform';
  $('backBtn').hidden = !connectedPort;
}

// ---------- Devices page ----------

async function refreshPorts(): Promise<{ inputs: string[]; outputs: string[] }> {
  const msg = $('connectMsg');
  try {
    const ports = await listPorts();
    const saved = savedPorts();
    fill($('inPort'), ports.inputs, saved?.input);
    fill($('outPort'), ports.outputs, saved?.output);
    msg.className = 'msg';
    msg.textContent = ports.outputs.length ? '' : 'No MIDI devices found. Is the keyboard on and plugged in?';
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
$('backBtn').addEventListener('click', () => showPage('perform'));
$('devicesBtn').addEventListener('click', () => {
  void refreshPorts();
  showPage('devices');
});

// ---------- Engine ----------

async function startEngine() {
  const style = styles[styleIndex];
  if (!style) throw new Error('No styles available.');
  if (!engine) engine = new ArrangerEngine(style, { thruInEngine: false }, rustNow());
  else send(engine.panic(rustNow())); // reconnecting: start clean
  await pushThru(engine.settings);
  if (!engineRunning) {
    await runEngine(() => engine!);
    engineRunning = true;
  }
  $('splitName').textContent = noteName(engine.settings.splitPoint);
  showStyle(styles[styleIndex]!);
}

function command(cmd: EngineCommand) {
  engine?.command(cmd, rustNow());
}

function showStyle(s: Style) {
  $('styleName').textContent = s.name;
  $('styleMeta').textContent = `${s.category} · ${s.timeSignature.join('/')} · ${s.status === 'prototype' ? 'draft style' : s.status}`;
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
  const tabs = $('categories');
  tabs.innerHTML = '';
  for (const c of cats) {
    const b = document.createElement('button');
    b.textContent = c;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(c === category));
    b.addEventListener('click', () => {
      category = c;
      renderBrowser();
    });
    tabs.append(b);
  }
  const list = $('styleList');
  list.innerHTML = '';
  styles.forEach((s, i) => {
    if (category !== 'All' && s.category !== category) return;
    const li = document.createElement('li');
    const b = document.createElement('button');
    if (i === styleIndex) b.className = 'current';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.name;
    const meta = document.createElement('span');
    meta.className = 'muted small';
    meta.textContent = `${s.category} · ${s.timeSignature.join('/')} · ${Math.round(s.tempo)} BPM`;
    b.append(name, meta);
    b.addEventListener('click', () => {
      selectStyle(i);
      closeBrowser();
    });
    li.append(b);
    list.append(li);
  });
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
  if (e.key === 'Enter') {
    setTempo(Number(tempoInput.value));
    tempoInput.blur();
  }
  e.stopPropagation(); // typing digits must not trigger shortcuts
});
const currentTempo = () => (engine ? engine.status(rustNow()).tempo : 120);
$('tempoDown').addEventListener('click', () => setTempo(currentTempo() - 1));
$('tempoUp').addEventListener('click', () => setTempo(currentTempo() + 1));

let taps: number[] = [];
$('tapBtn').addEventListener('click', () => {
  const t = performance.now();
  if (taps.length && t - taps[taps.length - 1]! > 2000) taps = [];
  taps = [...taps, t].slice(-5);
  if (taps.length >= 3) {
    const gaps = taps.slice(1).map((x, i) => x - taps[i]!);
    setTempo(60000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length));
  }
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
  if (!engine) return;
  const running = engine.status(rustNow()).running;
  const t = performance.now();
  // Logic Pro convention: pressing Stop twice quickly resets sound.
  if (!running && t - lastStopPress < 600) {
    resetSound();
    lastStopPress = 0;
    return;
  }
  if (running) lastStopPress = t;
  command({ type: 'toggleStart' });
}
$('startStop').addEventListener('click', startStop);
$('sync').addEventListener('click', () => command({ type: 'config', config: { syncStart: !engine?.settings.syncStart } }));
$('resetBtn').addEventListener('click', resetSound);

function resetSound() {
  if (!engine) return;
  send(engine.panic(rustNow()));
  void panicNow();
}

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
  if (engine && !$('perform').hidden) {
    const s = engine.status(rustNow());
    $('chord').textContent = s.chord;
    if (document.activeElement !== tempoInput) tempoInput.value = String(Math.round(s.tempo));
    $('nowLabel').textContent = s.running ? 'Now playing' : s.syncStart ? 'Waiting for your left hand' : 'Stopped';
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
      const available = id === 'fill' ? s.available.some((x) => x.startsWith('fill')) : has.has(id);
      b.disabled = !available;
      b.title = available ? '' : 'This style has no such section';
      const isFill = id === 'fill';
      const playing = s.running && (isFill ? s.section.startsWith('fill') : s.section === id);
      const queued = isFill ? s.queue.some((q) => q.startsWith('fill')) : s.queue.includes(id);
      b.classList.toggle('active', playing);
      b.classList.toggle('queued', !playing && queued);
      b.classList.toggle('selected', !s.running && b.dataset.id === s.lastMain);
    });
    $('sync').setAttribute('aria-pressed', String(s.syncStart));
    const ss = $('startStop');
    ss.textContent = s.running ? 'Stop' : 'Start';
    ss.classList.toggle('running', s.running);
  }
  requestAnimationFrame(render);
}

// ---------- Startup: reconnect to the last keyboard automatically ----------

window.addEventListener('beforeunload', () => void panicNow());
requestAnimationFrame(render);
void (async () => {
  const ports = await refreshPorts();
  const saved = savedPorts();
  if (saved && ports.inputs.includes(saved.input) && ports.outputs.includes(saved.output)) {
    await connect(saved.input, saved.output);
    if (connectedPort) return;
  }
  showPage('devices');
})();
