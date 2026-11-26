import { describe, expect, it } from 'vitest';
import { analyzeOnsets, detectOnsets } from '../src/onsets.ts';

const SR = 48000;

/** Synthetic recording: decaying clicks at the given times (seconds) plus low noise. */
function synth(times: number[], lengthSec: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.ceil(lengthSec * SR));
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < out.length; i++) out[i] = rand() * 0.01;
  for (const t of times) {
    const start = Math.round(t * SR);
    for (let k = 0; k < 0.04 * SR && start + k < out.length; k++) {
      out[start + k] = (out[start + k] ?? 0) + Math.sin(k * 0.3) * Math.exp(-k / (0.006 * SR)) * 0.8;
    }
  }
  return out;
}

describe('detectOnsets + analyzeOnsets', () => {
  it('finds perfectly even clicks with ~0 jitter', () => {
    const times = Array.from({ length: 40 }, (_, i) => 0.5 + i * 0.125);
    const onsets = detectOnsets(synth(times, 6), SR, { minGapMs: 60 });
    const st = analyzeOnsets(onsets, 125, 40);
    expect(st.missing).toBe(0);
    expect(st.extra).toBe(0);
    expect(st.intervalMs).toBeCloseTo(125, 1);
    expect(st.jitterP95Ms).toBeLessThan(0.2);
  });

  it('measures known jitter', () => {
    // alternate +3 ms / -3 ms around the grid -> SD close to 3 ms
    const times = Array.from({ length: 40 }, (_, i) => 0.5 + i * 0.125 + (i % 2 ? 0.003 : -0.003));
    const st = analyzeOnsets(detectOnsets(synth(times, 6), SR, { minGapMs: 60 }), 125, 40);
    expect(st.jitterStdMs).toBeGreaterThan(2.7);
    expect(st.jitterStdMs).toBeLessThan(3.3);
    expect(st.maxAbsMs).toBeLessThan(3.5);
  });

  it('counts missing clicks without shifting the grid', () => {
    const times = Array.from({ length: 40 }, (_, i) => 0.5 + i * 0.125).filter((_, i) => i !== 10 && i !== 20);
    const st = analyzeOnsets(detectOnsets(synth(times, 6), SR, { minGapMs: 60 }), 125, 40);
    expect(st.missing).toBe(2);
    expect(st.jitterP95Ms).toBeLessThan(0.2);
  });

  it('returns no onsets for silence', () => {
    expect(detectOnsets(new Float32Array(1000), SR)).toEqual([]);
  });
});
