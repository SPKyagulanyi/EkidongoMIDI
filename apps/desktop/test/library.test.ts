import { describe, expect, it } from 'vitest';
import { ArrangerEngine, compileGridStyle } from '@ekidongo/engine';
import { capture, emptyLibrary, loadLibrary, moveEntry, recallPlan, saveLibrary, step, type Library } from '../src/library.ts';

const style = compileGridStyle({
  name: 'Lib Test',
  tempo: 100,
  tracks: { bass: { type: 'bass', channel: 2, program: 33 } },
  sections: { main_a: { drums: { kick: 'X...............' }, bass: '1---------------' }, main_b: { bass: '1-------5-------' } },
});

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('registrations', () => {
  it('captures and recalls a full setup', () => {
    const e = new ArrangerEngine(style);
    e.command({ type: 'tempo', bpm: 132 }, 0);
    e.command({ type: 'main', id: 'mainB' }, 0);
    e.command({ type: 'voice', slot: 'right', program: 65 }, 0);
    e.command({ type: 'partVolume', part: 'bass', volume: 70 }, 0);
    e.command({ type: 'mute', part: 'drums', muted: true }, 0);
    const reg = capture('Praise 2', e.status(0), 54);
    expect(reg).toMatchObject({ name: 'Praise 2', tempo: 132, main: 'mainB', partVolumes: { bass: 70 }, muted: ['drums'] });
    expect(reg.voices.right.program).toBe(65);

    const fresh = new ArrangerEngine(style);
    const plan = recallPlan(reg, fresh.status(0), false);
    expect(plan.styleId).toBeUndefined(); // same style: no reload
    for (const c of plan.commands) fresh.command(c, 0);
    expect(capture('Praise 2', fresh.status(0), 54)).toEqual(reg);
  });

  it('with Freeze, changes voices but leaves style, tempo, section and mixer alone', () => {
    const reg = capture('X', new ArrangerEngine(style).status(0), 54);
    const plan = recallPlan({ ...reg, styleId: 'other', tempo: 60 }, new ArrangerEngine(style).status(0), true);
    expect(plan.styleId).toBeUndefined();
    expect(plan.commands.map((c) => c.type)).toEqual(['voice', 'voice', 'voice', 'config']);
  });

  it('asks for a style change when the registration uses another style', () => {
    const reg = capture('X', new ArrangerEngine(style).status(0), 54);
    expect(recallPlan({ ...reg, styleId: 'afrobeat-live' }, new ArrangerEngine(style).status(0), false).styleId).toBe('afrobeat-live');
  });
});

describe('library storage and set lists', () => {
  it('round-trips through storage and survives garbage', () => {
    const s = memoryStorage();
    const lib = emptyLibrary();
    lib.setlists.push({ id: 'a', name: 'Sunday', entries: [] });
    saveLibrary(lib, s);
    expect(loadLibrary(s)).toEqual(lib);
    s.setItem('ekidongo.library', '{not json');
    expect(loadLibrary(s)).toEqual(emptyLibrary());
  });

  it('steps through the active set list and stops at the ends', () => {
    const reg = capture('X', new ArrangerEngine(style).status(0), 54);
    const lib: Library = { ...emptyLibrary(), activeSetlist: 'a', setlists: [{ id: 'a', name: 'Sunday', entries: [{ title: '1', reg }, { title: '2', reg }] }] };
    expect(step(lib, 1)?.title).toBe('2');
    expect(step(lib, 1)).toBeNull();
    expect(step(lib, -1)?.title).toBe('1');
    expect(step(lib, -1)).toBeNull();
  });

  it('reorders entries', () => {
    const reg = capture('X', new ArrangerEngine(style).status(0), 54);
    const list = { id: 'a', name: 'S', entries: ['a', 'b', 'c'].map((title) => ({ title, reg })) };
    moveEntry(list, 2, 0);
    expect(list.entries.map((e) => e.title)).toEqual(['c', 'a', 'b']);
    moveEntry(list, 0, -1);
    expect(list.entries.map((e) => e.title)).toEqual(['c', 'a', 'b']);
  });
});
