/** Loads and validates the bundled style library at startup. */
import { validateStyle, type Style } from '@ekidongo/engine';

const files = import.meta.glob(['../../../packages/styles/live/*.json', '../../../packages/styles/prototype/*.json'], {
  eager: true,
  import: 'default',
});

export interface LoadedStyles {
  styles: Style[];
  errors: string[];
}

export function loadStyles(): LoadedStyles {
  const styles: Style[] = [];
  const errors: string[] = [];
  for (const [path, json] of Object.entries(files)) {
    const r = validateStyle(json);
    if (r.ok) styles.push(r.style);
    else errors.push(`${path}: ${r.errors.join('; ')}`);
  }
  // Within the browser: styles with real drummers first, then by name.
  const rank = (s: Style) => (s.status === 'prototype' ? 1 : 0);
  styles.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return { styles, errors };
}
