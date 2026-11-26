/**
 * Converts the Python prototype's grid styles (PianoArranger/styles.json) into v1 phrase styles
 * in packages/styles/prototype. Usage:
 *   npm run convert:prototype -- [path/to/styles.json]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compileGridStyle, validateStyle, type GridStyle } from '../packages/engine/src/index.ts';

const src = process.argv[2] ?? join(homedir(), 'Documents', 'PianoArranger', 'styles.json');
const outDir = join(import.meta.dirname, '..', 'packages', 'styles', 'prototype');
mkdirSync(outDir, { recursive: true });

const grids = (JSON.parse(readFileSync(src, 'utf8')) as { styles: GridStyle[] }).styles;
let failed = 0;
for (const grid of grids) {
  const style = compileGridStyle(grid);
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
