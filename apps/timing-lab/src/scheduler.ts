/**
 * Two ways of sending clicks over Web MIDI, to compare:
 *  - "timestamped": a 10 ms timer queues events up to `lookaheadMs` ahead with send(data, time),
 *    so the browser/OS delivers them on time even when JavaScript wakes late (the plan's design).
 *  - "immediate": setTimeout fires at each click time and sends right away (the naive approach).
 */

export interface ClickPlan {
  count: number;
  intervalMs: number;
  note: number;
  /** MIDI channel 1-16. */
  channel: number;
  velocity: number;
}

export type SendMode = 'timestamped' | 'immediate';

export interface SendLog {
  /** Intended time (performance.now() clock, ms). */
  target: number;
  /** When send() was called. */
  sentAt: number;
}

export interface RunOptions {
  mode: SendMode;
  lookaheadMs?: number;
  tickMs?: number;
  /** Simulate a busy UI: block the main thread for 30 ms every 100 ms. */
  stress?: boolean;
  startDelayMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runClicks(out: MIDIOutput, plan: ClickPlan, opts: RunOptions): Promise<SendLog[]> {
  const on = 0x90 | (plan.channel - 1);
  const off = 0x80 | (plan.channel - 1);
  const start = performance.now() + (opts.startDelayMs ?? 500);
  const times = Array.from({ length: plan.count }, (_, i) => start + i * plan.intervalMs);
  const log: SendLog[] = [];

  let stressTimer: ReturnType<typeof setInterval> | undefined;
  if (opts.stress) {
    stressTimer = setInterval(() => {
      const end = performance.now() + 30;
      while (performance.now() < end) {
        /* busy */
      }
    }, 100);
  }

  try {
    if (opts.mode === 'timestamped') {
      const lookahead = opts.lookaheadMs ?? 40;
      let next = 0;
      await new Promise<void>((resolve) => {
        const tick = setInterval(() => {
          const now = performance.now();
          while (next < times.length && (times[next] ?? 0) <= now + lookahead) {
            const t = times[next] ?? now;
            out.send([on, plan.note, plan.velocity], t);
            out.send([off, plan.note, 0], t + 30);
            log.push({ target: t, sentAt: performance.now() });
            next++;
          }
          if (next >= times.length) {
            clearInterval(tick);
            resolve();
          }
        }, opts.tickMs ?? 10);
      });
    } else {
      for (const t of times) {
        const wait = t - performance.now();
        if (wait > 0) await sleep(wait);
        const sentAt = performance.now();
        out.send([on, plan.note, plan.velocity]);
        setTimeout(() => out.send([off, plan.note, 0]), 30);
        log.push({ target: t, sentAt });
      }
    }
    await sleep(100);
  } finally {
    if (stressTimer) clearInterval(stressTimer);
    out.send([0xb0 | (plan.channel - 1), 123, 0]); // all notes off
  }
  return log;
}

export interface SendSummary {
  /** Timestamped: smallest headroom (target - sentAt) in ms; negative = late. Immediate: worst lateness. */
  worstMs: number;
  /** Count of events handed over after their target time. */
  late: number;
  medianMs: number;
}

export function summarizeSends(log: SendLog[], mode: SendMode): SendSummary {
  const vals = log.map((l) => (mode === 'timestamped' ? l.target - l.sentAt : l.sentAt - l.target)).sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)] ?? 0;
  if (mode === 'timestamped') {
    return { worstMs: vals[0] ?? 0, late: vals.filter((v) => v < 0).length, medianMs: median };
  }
  return { worstMs: vals.at(-1) ?? 0, late: vals.filter((v) => v > 1).length, medianMs: median };
}
