import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateStyle } from '@ekidongo/engine';

const dir = join(import.meta.dirname, '..', 'prototype');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

describe('style library', () => {
  it('has styles', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s is a valid v1 style named after its id', (file) => {
    const r = validateStyle(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (r.ok) expect(`${r.style.id}.json`).toBe(file);
  });

  it('has unique style ids', () => {
    const ids = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).id as string);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
