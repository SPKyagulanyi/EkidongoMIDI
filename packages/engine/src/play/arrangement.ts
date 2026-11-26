/**
 * The section state machine: which section plays in each bar, like an arranger keyboard's panel.
 *
 * - Changes are queued and happen at the next bar line.
 * - Pressing another Main while playing queues its fill, then the Main.
 * - Fills, intros and breaks play to their end, then return to the current Main.
 * - An ending plays to its end, then playback stops.
 */
import type { SectionId } from '../style/schema.ts';

export type MainId = 'mainA' | 'mainB' | 'mainC' | 'mainD';
const MAINS: readonly MainId[] = ['mainA', 'mainB', 'mainC', 'mainD'];

export interface ArrangementSnapshot {
  running: boolean;
  section: SectionId;
  barInSection: number;
  lastMain: MainId;
  queue: readonly SectionId[];
}

const isMain = (s: SectionId): s is MainId => (MAINS as readonly string[]).includes(s);
const letter = (m: MainId) => m.slice(4); // 'A'..'D'

export class Arrangement {
  private running = false;
  private section: SectionId = 'mainA';
  private barInSection = 0;
  private lastMain: MainId = 'mainA';
  private queue: SectionId[] = [];
  private readonly available: ReadonlySet<SectionId>;
  /** When set, this one section repeats and panel requests are ignored (recording / auditioning). */
  private loop: SectionId | null = null;

  setLoop(section: SectionId | null): void {
    this.loop = section;
  }

  /** Start playback directly on a section (any kind), e.g. to record or audition it. */
  startSection(section: SectionId): void {
    this.running = true;
    this.section = section;
    this.barInSection = 0;
    this.queue = [];
  }

  constructor(available: ReadonlySet<SectionId>) {
    this.available = available;
    this.lastMain = this.resolveMain('mainA');
    this.section = this.lastMain;
  }

  snapshot(): ArrangementSnapshot {
    return { running: this.running, section: this.section, barInSection: this.barInSection, lastMain: this.lastMain, queue: [...this.queue] };
  }

  /** Nearest available Main (A falls back to B, C, D and so on). */
  private resolveMain(m: MainId): MainId {
    if (this.available.has(m)) return m;
    return MAINS.find((x) => this.available.has(x)) ?? 'mainA';
  }

  private fillFor(m: MainId): SectionId | null {
    const own = `fill${letter(m)}` as SectionId;
    if (this.available.has(own)) return own;
    for (const f of ['fillA', 'fillB', 'fillC', 'fillD'] as SectionId[]) if (this.available.has(f)) return f;
    return null;
  }

  private firstOf(ids: SectionId[]): SectionId | null {
    return ids.find((s) => this.available.has(s)) ?? null;
  }

  start(intro?: 'intro1' | 'intro2' | 'intro3'): void {
    this.running = true;
    this.barInSection = 0;
    const i = intro ? this.firstOf([intro, 'intro1', 'intro2', 'intro3']) : null;
    this.section = i ?? this.lastMain;
    this.queue = [];
  }

  stop(): void {
    this.running = false;
    this.queue = [];
    this.section = this.lastMain;
    this.barInSection = 0;
  }

  requestMain(id: MainId): void {
    const m = this.resolveMain(id);
    if (!this.running) {
      this.lastMain = m;
      this.section = m;
      return;
    }
    const fill = this.fillFor(m);
    this.queue = fill ? [fill, m] : [m];
  }

  requestFill(): void {
    if (!this.running) return;
    const fill = this.fillFor(this.lastMain);
    if (fill) this.queue = [fill, this.lastMain];
  }

  requestBreak(): void {
    if (this.running && this.available.has('break')) this.queue = ['break', this.lastMain];
  }

  requestIntro(n: 1 | 2 | 3): void {
    const id = `intro${n}` as 'intro1' | 'intro2' | 'intro3';
    if (!this.running) this.start(id);
    else {
      const i = this.firstOf([id, 'intro1', 'intro2', 'intro3']);
      if (i) this.queue = [i, this.lastMain];
    }
  }

  /** Queue an ending; with no ending section, playback stops at the next bar line. */
  requestEnding(n: 1 | 2 | 3): void {
    if (!this.running) return;
    const e = this.firstOf([`ending${n}` as SectionId, 'ending1', 'ending2', 'ending3']);
    this.queue = e ? [e] : ['__stop' as SectionId];
  }

  /**
   * Advance one bar. Returns the section to play in the new bar, or null when playback ends.
   * `barsOf` gives each section's length in bars.
   */
  nextBar(barsOf: (s: SectionId) => number): ArrangementSnapshot | null {
    if (!this.running) return null;
    if (this.loop) {
      this.section = this.loop;
      this.barInSection = (this.barInSection + 1) % Math.max(1, barsOf(this.loop));
      return this.snapshot();
    }
    const bar = this.barInSection + 1;
    const finished = bar >= barsOf(this.section);
    const head = this.queue[0];
    // Queued changes interrupt a Main at any bar line; other sections finish first.
    if (head && (isMain(this.section) || finished)) {
      this.queue.shift();
      if ((head as string) === '__stop') {
        this.stop();
        return null;
      }
      this.section = head;
      this.barInSection = 0;
      if (isMain(head)) this.lastMain = head;
      return this.snapshot();
    }
    if (!finished) {
      this.barInSection = bar;
      return this.snapshot();
    }
    if (this.section.startsWith('ending')) {
      this.stop();
      return null;
    }
    this.section = this.lastMain;
    this.barInSection = 0;
    return this.snapshot();
  }
}
