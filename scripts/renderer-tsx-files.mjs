// Shared directory walk for the renderer lint scripts (check:hit-targets, check:icon-only-controls).

import { readdirSync } from 'node:fs';
import path from 'node:path';

const EXCLUDED_DIRS = new Set(['node_modules', 'out', 'dist', '.git', 'target', 'assets']);

/** Sorted absolute paths of every non-test `.tsx` file under `dir`. */
export function rendererTsxFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(path.join(current, entry.name));
      } else if (/\.tsx$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
        files.push(path.join(current, entry.name));
      }
    }
  };
  walk(dir);
  return files.sort();
}
