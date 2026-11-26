import { initObservability, reportError } from './observability.ts';
import { analyzeOnsets, detectOnsets, type TimingStats } from './onsets.ts';
import { listAudioInputs, startRecording } from './recorder.ts';
import { runClicks, summarizeSends, type ClickPlan, type SendMode, type SendSummary } from './scheduler.ts';

const JITTER_TARGET_MS = 5;

initObservability();

interface RunResult {
  label: string;
  at: string;
  userAgent: string;
  plan: ClickPlan;
  lookaheadMs: number | null;
  stress: boolean;
  send: SendSummary | null;
  audio: TimingStats;
  pass: boolean;
}

declare global {
  interface Window {
    ekidongoResults: RunResult[];
  }
}
window.ekidongoResults = [];

const el = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing`);
  return e as T;
};
const num = (id: string) => Number(el<HTMLInputElement>(id).value);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const status = (s: string) => {
  el('status').textContent = s;
  console.log(`[timing] ${s}`);
};

let midi: MIDIAccess | null = null;
const runButtons = ['runTs', 'runIm', 'runNative'].map((id) => el<HTMLButtonElement>(id));

function plan(): ClickPlan {
  // Hi wood block on the GM drum channel: short, sharp attack = precise onsets.
  return { count: num('count'), intervalMs: num('interval'), note: 76, channel: 10, velocity: 110 };
}

function fillSelect(sel: HTMLSelectElement, items: { id: string; name: string }[], prefer: RegExp) {
  sel.innerHTML = '';
  for (const it of items) sel.add(new Option(it.name, it.id, false, prefer.test(it.name)));
}

el('connect').addEventListener('click', async () => {
  try {
    status('Asking for MIDI access...');
    midi = await navigator.requestMIDIAccess({ sysex: false });
    fillSelect(el('midiOut'), [...midi.outputs.values()].map((o) => ({ id: o.id, name: o.name ?? o.id })), /roland|piano/i);
    status('Asking for microphone access (to record the keyboard over USB)...');
    const inputs = await listAudioInputs();
    fillSelect(el('audioIn'), inputs.map((d) => ({ id: d.deviceId, name: d.label || d.deviceId })), /roland|piano/i);
    runButtons.forEach((b) => (b.disabled = false));
    status(`Connected. ${midi.outputs.size} MIDI output(s), ${inputs.length} audio input(s).`);
  } catch (e) {
    status(`Connect failed: ${(e as Error).message}`);
    reportError(e, { step: 'connect' });
  }
});

function report(r: RunResult) {
  window.ekidongoResults.push(r);
  console.log(`[timing] RESULT ${JSON.stringify(r)}`);
  const a = r.audio;
  const row = document.createElement('tr');
  const cells = [
    r.label,
    `${a.expected - a.missing} / ${a.expected}`,
    a.intervalMs.toFixed(2),
    a.jitterStdMs.toFixed(2),
    a.jitterP95Ms.toFixed(2),
    a.maxAbsMs.toFixed(2),
    r.send ? String(r.send.late) : '-',
  ];
  for (const c of cells) row.insertCell().textContent = c;
  const res = row.insertCell();
  res.textContent = r.pass ? 'PASS' : 'FAIL';
  res.className = r.pass ? 'pass' : 'fail';
  el('results').append(row);
  el<HTMLButtonElement>('download').disabled = false;
}

function judge(a: TimingStats): boolean {
  return a.missing === 0 && a.extra === 0 && a.jitterP95Ms < JITTER_TARGET_MS;
}

async function browserRun(mode: SendMode) {
  if (!midi) return;
  const out = midi.outputs.get(el<HTMLSelectElement>('midiOut').value);
  const deviceId = el<HTMLSelectElement>('audioIn').value;
  if (!out || !deviceId) return status('Pick a MIDI output and an audio input first.');
  const p = plan();
  const stress = el<HTMLInputElement>('stress').checked;
  const lookahead = num('lookahead');
  runButtons.forEach((b) => (b.disabled = true));
  try {
    await out.open();
    const rec = await startRecording(deviceId);
    status(`Playing ${p.count} clicks (${mode}${stress ? ', busy UI' : ''})...`);
    await sleep(300);
    const log = await runClicks(out, p, { mode, lookaheadMs: lookahead, stress });
    await sleep(500);
    const audio = await rec.stop();
    await out.close(); // release the port so the native test can use it
    const onsets = detectOnsets(audio.samples, audio.sampleRate, { minGapMs: p.intervalMs * 0.5 });
    const stats = analyzeOnsets(onsets, p.intervalMs, p.count);
    report({
      label: `Browser ${mode}${mode === 'timestamped' ? ` ${lookahead} ms` : ''}${stress ? ' + busy UI' : ''}`,
      at: new Date().toISOString(),
      userAgent: navigator.userAgent,
      plan: p,
      lookaheadMs: mode === 'timestamped' ? lookahead : null,
      stress,
      send: summarizeSends(log, mode),
      audio: stats,
      pass: judge(stats),
    });
    status('Done.');
  } catch (e) {
    status(`Run failed: ${(e as Error).message}`);
    reportError(e, { step: 'browser-run', mode, stress, lookahead });
  } finally {
    runButtons.forEach((b) => (b.disabled = false));
  }
}

async function nativeRun() {
  const deviceId = el<HTMLSelectElement>('audioIn').value;
  if (!deviceId) return status('Pick an audio input first.');
  const p = plan();
  const secs = num('nativeSec');
  runButtons.forEach((b) => (b.disabled = true));
  try {
    const rec = await startRecording(deviceId);
    for (let s = secs; s > 0; s--) {
      status(`Recording native test... ${s}s left (run native_click.py now)`);
      await sleep(1000);
    }
    const audio = await rec.stop();
    const onsets = detectOnsets(audio.samples, audio.sampleRate, { minGapMs: p.intervalMs * 0.5 });
    const stats = analyzeOnsets(onsets, p.intervalMs, p.count);
    report({
      label: 'Native (WinMM via Python)',
      at: new Date().toISOString(),
      userAgent: navigator.userAgent,
      plan: p,
      lookaheadMs: null,
      stress: false,
      send: null,
      audio: stats,
      pass: judge(stats),
    });
    status('Done.');
  } catch (e) {
    status(`Recording failed: ${(e as Error).message}`);
    reportError(e, { step: 'native-recording' });
  } finally {
    runButtons.forEach((b) => (b.disabled = false));
  }
}

el('runTs').addEventListener('click', () => void browserRun('timestamped'));
el('runIm').addEventListener('click', () => void browserRun('immediate'));
el('runNative').addEventListener('click', () => void nativeRun());
el('download').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(window.ekidongoResults, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `timing-results-${Date.now()}.json`;
  a.click();
});
