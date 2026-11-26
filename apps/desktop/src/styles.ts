/** Loads and validates the bundled style library at startup. */
import { validateStyle, type Style } from '@ekidongo/engine';

const files = import.meta.glob('../../../packages/styles/prototype/*.json', { eager: true, import: 'default' });

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
  // Keep the order the prototype used (it was curated), falling back to name.
  const order = ['pop-8-beat', 'ballad', 'afrobeat', 'gospel-12-8', 'reggae-one-drop', 'rumba-soukous', 'waltz-3-4'];
  styles.sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.name.localeCompare(b.name);
  });
  return { styles, errors };
}
