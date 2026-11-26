import { describe, expect, it } from 'vitest';
import { Arrangement, type SectionId } from '../src/index.ts';

const ALL: SectionId[] = ['intro1', 'mainA', 'mainB', 'fillA', 'fillB', 'break', 'ending1'];
const bars: Partial<Record<SectionId, number>> = { intro1: 2, mainA: 2, mainB: 1, ending1: 2 };
const barsOf = (s: SectionId) => bars[s] ?? 1;

/** Section names for the next n bars. */
function run(a: Arrangement, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = a.nextBar(barsOf);
    out.push(s ? s.section : 'STOP');
    if (!s) break;
  }
  return out;
}

describe('Arrangement', () => {
  it('starts on Main A and loops it', () => {
    const a = new Arrangement(new Set(ALL));
    a.start();
    expect(a.snapshot().section).toBe('mainA');
    expect(run(a, 3)).toEqual(['mainA', 'mainA', 'mainA']);
  });

  it('plays the target fill, then switches Main at the next bar line', () => {
    const a = new Arrangement(new Set(ALL));
    a.start();
    a.requestMain('mainB');
    expect(run(a, 3)).toEqual(['fillB', 'mainB', 'mainB']);
  });

  it('falls back to another fill when the target has none', () => {
    const a = new Arrangement(new Set(['mainA', 'mainB', 'fillA'] as SectionId[]));
    a.start();
    a.requestMain('mainB');
    expect(run(a, 2)).toEqual(['fillA', 'mainB']);
  });

  it('plays an intro to its end, then the Main', () => {
    const a = new Arrangement(new Set(ALL));
    a.requestMain('mainB');
    a.requestIntro(1);
    expect(a.snapshot().section).toBe('intro1');
    expect(run(a, 3)).toEqual(['intro1', 'mainB', 'mainB']);
  });

  it('plays the ending to its end, then stops', () => {
    const a = new Arrangement(new Set(ALL));
    a.start();
    a.requestEnding(1);
    expect(run(a, 4)).toEqual(['ending1', 'ending1', 'STOP']);
    expect(a.snapshot().running).toBe(false);
  });

  it('stops at the next bar line when the style has no ending', () => {
    const a = new Arrangement(new Set(['mainA'] as SectionId[]));
    a.start();
    a.requestEnding(1);
    expect(run(a, 2)).toEqual(['STOP']);
  });

  it('lets a fill finish before a newly queued change', () => {
    const a = new Arrangement(new Set(ALL));
    a.start();
    a.requestFill();
    expect(run(a, 1)).toEqual(['fillA']);
    a.requestBreak();
    expect(run(a, 3)).toEqual(['break', 'mainA', 'mainA']);
  });

  it('just selects the Main when stopped', () => {
    const a = new Arrangement(new Set(ALL));
    a.requestMain('mainB');
    expect(a.snapshot()).toMatchObject({ running: false, section: 'mainB', lastMain: 'mainB', queue: [] });
  });

  it('uses the first available Main when Main A is missing', () => {
    const a = new Arrangement(new Set(['mainB'] as SectionId[]));
    a.start();
    expect(a.snapshot().section).toBe('mainB');
  });
});
