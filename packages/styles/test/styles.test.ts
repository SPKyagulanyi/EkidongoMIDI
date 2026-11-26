import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateStyle } from '@ekidongo/engine';

const dirs = ['prototype', 'live'].map((d) => join(import.meta.dirname, '..', d));
const paths = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => join(d, f)));
const files = paths.map((p) => basename(p));
const pathOf = (file: string) => paths[files.indexOf(file)]!;

describe('style library', () => {
  it('has styles', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s is a valid v1 style named after its id', (file) => {
    const r = validateStyle(JSON.parse(readFileSync(pathOf(file), 'utf8')));
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (r.ok) expect(`${r.style.id}.json`).toBe(file);
  });

  it('has unique style ids', () => {
    const ids = files.map((f) => JSON.parse(readFileSync(pathOf(f), 'utf8')).id as string);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
