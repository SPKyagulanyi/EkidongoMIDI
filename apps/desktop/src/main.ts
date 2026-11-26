import { ArrangerEngine, noteName, type EngineCommand, type MainId, type Style } from '@ekidongo/engine';
import { connectPorts, listPorts, panicNow, pushThru, runEngine, rustNow, send, syncClock } from './bridge.ts';
import { loadStyles } from './styles.ts';

const $ = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing`);
  return e as T;
};

const { styles, errors } = loadStyles();
if (errors.length) console.warn('[styles] skipped invalid styles', errors);
let styleIndex = Math.max(0, styles.findIndex((s) => s.id === 'afrobeat'));
let engine: ArrangerEngine | null = null;

const SECTION_NAMES: Record<string, string> = { fillA: 'Fill', fillB: 'Fill', fillC: 'Fill', fillD: 'Fill', break: 'Break' };
const sectionName = (id: string) =>
  SECTION_NAMES[id] ?? id.replace(/^main/, 'Main ').replace(/^intro/, 'Intro ').replace(/^ending/, 'Ending ');

// ---------- Connect screen ----------

async function refreshPorts() {
  const msg = $('connectMsg');
  try {
    const ports = await listPorts();
    fill($('inPort'), ports.inputs);
    fill($('outPort'), ports.outputs);
    msg.textContent = ports.outputs.length ? '' : 'No MIDI devices found. Is the keyboard on and plugged in?';
  } catch (e) {
    msg.textContent = `Could not list MIDI devices: ${String(e)}`;
  }
}

function fill(sel: HTMLSelectElement, names: string[]) {
  sel.innerHTML = '';
  for (const n of names) sel.add(new Option(n, n, false, /roland|piano|keyboard/i.test(n)));
}

$('refresh').addEventListener('click', () => void refreshPorts());
$('connectBtn').addEventListener('click', async () => {
  const input = $<HTMLSelectElement>('inPort').value;
  const output = $<HTMLSelectElement>('outPort').value;
  const msg = $('connectMsg');
  if (!input || !output) return void (msg.textContent = 'Choose the keyboard for both.');
  try {
    msg.textContent = 'Connecting…';
    await connectPorts(input, output);
    const { rttMs } = await syncClock();
    console.info(`[clock] synced, round trip ${rttMs.toFixed(2)} ms`);
    startPerforming(output);
  } catch (e) {
    msg.textContent = String(e);
  }
});

// ---------- Performance screen ----------

async function startPerforming(portName: string) {
  const style = styles[styleIndex];
  if (!style) return void ($('connectMsg').textContent = 'No styles available.');
  engine = new ArrangerEngine(style, { thruInEngine: false }, rustNow());
  await pushThru(engine.settings);
  await runEngine(() => engine!);
  $('portName').textContent = portName;
  $('splitName').textContent = noteName(engine.settings.splitPoint);
  $('connect').hidden = true;
  $('perform').hidden = false;
  showStyle(style);
  requestAnimationFrame(render);
}

function command(cmd: EngineCommand) {
  engine?.command(cmd, rustNow());
}

function showStyle(s: Style) {
  $('styleName').textContent = s.name;
  $('styleMeta').textContent = `${s.category} · ${s.status} · ${styleIndex + 1} of ${styles.length}`;
}

function changeStyle(delta: number) {
  if (!engine || styles.length === 0) return;
  styleIndex = (styleIndex + delta + styles.length) % styles.length;
  const s = styles[styleIndex]!;
  engine.loadStyle(s, rustNow());
  showStyle(s);
}

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
$('startStop').addEventListener('click', () => command({ type: 'toggleStart' }));
$('sync').addEventListener('click', () => command({ type: 'config', config: { syncStart: !engine?.settings.syncStart } }));
$('prevStyle').addEventListener('click', () => changeStyle(-1));
$('nextStyle').addEventListener('click', () => changeStyle(1));
$('tempoDown').addEventListener('click', () => engine && command({ type: 'tempo', bpm: engine.status(rustNow()).tempo - 2 }));
$('tempoUp').addEventListener('click', () => engine && command({ type: 'tempo', bpm: engine.status(rustNow()).tempo + 2 }));
$('panic').addEventListener('click', panic);

function panic() {
  if (!engine) return;
  send(engine.panic(rustNow()));
  void panicNow();
}

document.addEventListener('keydown', (e) => {
  if (!engine || e.target instanceof HTMLSelectElement) return;
  const k = e.key.toLowerCase();
  const mains: Record<string, MainId> = { a: 'mainA', b: 'mainB', c: 'mainC', d: 'mainD' };
  if (k === ' ') command({ type: 'toggleStart' });
  else if (mains[k]) command({ type: 'main', id: mains[k] });
  else if (k === 'f') command({ type: 'fill' });
  else if (k === 'e') command({ type: 'ending', n: 1 });
  else if (k === 'arrowright') changeStyle(1);
  else if (k === 'arrowleft') changeStyle(-1);
  else if (k === 'arrowup') command({ type: 'tempo', bpm: engine.status(rustNow()).tempo + 2 });
  else if (k === 'arrowdown') command({ type: 'tempo', bpm: engine.status(rustNow()).tempo - 2 });
  else if (k === 'escape') panic();
  else return;
  e.preventDefault();
});

function render() {
  if (engine) {
    const s = engine.status(rustNow());
    $('chord').textContent = s.chord;
    $('tempo').textContent = String(Math.round(s.tempo));
    $('nowLabel').textContent = s.running ? 'Now playing' : s.syncStart ? 'Waiting for your left hand' : 'Stopped';
    $('section').textContent = sectionName(s.running ? s.section : s.lastMain);
    $('next').textContent = s.queue.length
      ? `Next at the bar line: ${s.queue.map(sectionName).join(' → ')}`
      : s.running ? 'Press Main A–D for a fill and change' : 'Press Start, an Intro, or play a chord';
    const beats = $('beats');
    if (beats.childElementCount !== s.beatsPerBar) beats.innerHTML = '<span></span>'.repeat(s.beatsPerBar);
    [...beats.children].forEach((d, i) => d.className = s.running && s.beat === i ? (i === 0 ? 'on first' : 'on') : '');
    document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((b) => {
      const id = b.dataset.cmd === 'main' ? b.dataset.id! : b.dataset.cmd === 'fill' ? 'fill' : `${b.dataset.cmd}${b.dataset.n ?? ''}`;
      const playing = s.running && (s.section === id || (id === 'fill' && s.section.startsWith('fill')));
      const queued = s.queue.includes(id) || (id === 'fill' && s.queue.some((q) => q.startsWith('fill')));
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

window.addEventListener('beforeunload', () => void panicNow());
void refreshPorts();
