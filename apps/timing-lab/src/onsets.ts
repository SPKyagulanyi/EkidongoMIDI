/**
 * Onset detection and timing statistics for click recordings. Pure functions, unit-tested.
 */

export interface OnsetOptions {
  /** Threshold as a fraction of the loudest sample. */
  thresholdRatio?: number;
  /** Ignore new onsets this soon after the previous one (ms). */
  minGapMs?: number;
}

/** Times (seconds) where the signal first crosses the threshold after a quiet gap. */
export function detectOnsets(samples: Float32Array, sampleRate: number, opts: OnsetOptions = {}): number[] {
  const ratio = opts.thresholdRatio ?? 0.25;
  const gap = Math.round(((opts.minGapMs ?? 50) / 1000) * sampleRate);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i] ?? 0));
  if (peak === 0) return [];
  const threshold = peak * ratio;
  const onsets: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i] ?? 0) >= threshold && i - last >= gap) {
      onsets.push(i / sampleRate);
      last = i;
    } else if (Math.abs(samples[i] ?? 0) >= threshold) {
      last = i; // still ringing: extend the quiet-gap requirement
    }
  }
  return onsets;
}

export interface TimingStats {
  onsets: number;
  expected: number;
  missing: number;
  extra: number;
  /** Mean measured interval (ms) from the line fit. */
  intervalMs: number;
  /** Standard deviation of deviations from the ideal grid (ms). */
  jitterStdMs: number;
  /** 95th percentile of absolute deviation (ms). */
  jitterP95Ms: number;
  maxAbsMs: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

/**
 * Fits onset times to an even grid (least squares on grid index) and reports deviations.
 * Grid indices come from the nominal interval, so missing clicks do not shift later ones.
 */
export function analyzeOnsets(onsetsSec: number[], nominalIntervalMs: number, expected: number): TimingStats {
  const empty: TimingStats = { onsets: onsetsSec.length, expected, missing: expected, extra: 0, intervalMs: 0, jitterStdMs: 0, jitterP95Ms: 0, maxAbsMs: 0 };
  if (onsetsSec.length < 3) return empty;
  const t0 = onsetsSec[0] ?? 0;
  const step = nominalIntervalMs / 1000;
  const idx = onsetsSec.map((t) => Math.round((t - t0) / step));
  // drop duplicates on the same grid slot (keep the first)
  const pts: [number, number][] = [];
  const seen = new Set<number>();
  idx.forEach((k, i) => {
    if (!seen.has(k)) {
      seen.add(k);
      pts.push([k, onsetsSec[i] ?? 0]);
    }
  });
  const n = pts.length;
  const mx = pts.reduce((s, [k]) => s + k, 0) / n;
  const my = pts.reduce((s, [, t]) => s + t, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const [k, t] of pts) {
    sxy += (k - mx) * (t - my);
    sxx += (k - mx) ** 2;
  }
  const b = sxx ? sxy / sxx : step;
  const a = my - b * mx;
  const dev = pts.map(([k, t]) => (t - (a + b * k)) * 1000);
  const abs = dev.map(Math.abs).sort((x, y) => x - y);
  const std = Math.sqrt(dev.reduce((s, d) => s + d * d, 0) / n);
  return {
    onsets: onsetsSec.length,
    expected,
    missing: Math.max(0, expected - n),
    extra: onsetsSec.length - n,
    intervalMs: b * 1000,
    jitterStdMs: std,
    jitterP95Ms: percentile(abs, 0.95),
    maxAbsMs: abs.at(-1) ?? 0,
  };
}
