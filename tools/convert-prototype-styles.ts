/**
 * Converts the Python prototype's grid styles (PianoArranger/styles.json) into v1 phrase styles
 * in packages/styles/prototype. Usage:
 *   npm run convert:prototype -- [path/to/styles.json]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compileGridStyle, deriveMissingSections, validateStyle, type GridStyle } from '../packages/engine/src/index.ts';
import { mixPass } from './style-mix.ts';

/** Browser categories (Genos-style: pick a category, then a style). */
const CATEGORY: Record<string, string> = {
  'afrobeat': 'African', 'amapiano': 'African', 'highlife': 'African', 'kwaito': 'African', 'rumba-soukous': 'African',
  'kadongo-kamu': 'East African', 'ganda-kiganda': 'East African', 'kinyankole': 'East African', 'bongo-flava': 'East African',
  'gospel-12-8': 'Church', 'praise-worship': 'Church',
  'reggae-one-drop': 'Caribbean', 'reggae-rockers': 'Caribbean', 'lovers-rock': 'Caribbean', 'dancehall': 'Caribbean', 'zouk': 'Caribbean',
  'reggaeton': 'Latin',
  'pop-8-beat': 'Pop & RnB', 'ballad': 'Pop & RnB', 'rnb': 'Pop & RnB',
  'waltz-3-4': 'Ballroom & March', 'foxtrot': 'Ballroom & March', 'march': 'Ballroom & March', 'march-6-8': 'Ballroom & March',
};
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const src = process.argv[2] ?? join(homedir(), 'Documents', 'PianoArranger', 'styles.json');
const outDir = join(import.meta.dirname, '..', 'packages', 'styles', 'prototype');
mkdirSync(outDir, { recursive: true });

const grids = (JSON.parse(readFileSync(src, 'utf8')) as { styles: GridStyle[] }).styles;
let failed = 0;
for (const grid of grids) {
  // Programmed (grid) styles: every part gets the professional balance and subtle human variation.
  const compiled = compileGridStyle(grid, CATEGORY[slug(grid.name)] ?? 'Other');
  const style = deriveMissingSections(mixPass(compiled, { humanizeParts: () => true, keepVelocity: () => false }));
  const r = validateStyle(style);
  if (!r.ok) {
    failed++;
    console.error(`x ${grid.name}\n  ${r.errors.join('\n  ')}`);
    continue;
  }
  writeFileSync(join(outDir, `${style.id}.json`), JSON.stringify(style, null, 1) + '\n');
  const sections = Object.keys(style.sections).join(', ');
  console.log(`ok ${style.id}  (${style.timeSignature.join('/')}, ${style.tempo} bpm, ${sections})`);
}
console.log(`\n${grids.length - failed}/${grids.length} styles converted into ${outDir}`);
process.exitCode = failed ? 1 : 0;
