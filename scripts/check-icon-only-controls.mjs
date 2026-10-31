#!/usr/bin/env node
// Static guard (#1468): icon-only controls must be IconButton (label = tooltip = aria-label), not a
// hand-built Button size="icon*". Existing uses are baselined per file and may shrink, never grow.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rendererTsxFiles } from './renderer-tsx-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'icon-only-controls-baseline.json');
// A conditional size (`size={cond ? 'icon-sm' : 'sm'}`) counts too.
const TOKEN = /<Button\b[^<]*?\bsize=(?:\{[^}]*?)?["']icon[^"']*["']/g;
const EXEMPT_FILES = new Set(['src/renderer/components/IconButton.tsx', 'src/renderer/components/ui/button.tsx']);

export function countHandBuiltIconButtons(text) {
  return [...text.matchAll(TOKEN)].length;
}

function scan() {
  const out = {};
  for (const file of rendererTsxFiles(path.join(repoRoot, 'src', 'renderer'))) {
    const rel = path.relative(repoRoot, file).split(path.sep).join('/');
    if (EXEMPT_FILES.has(rel)) continue;
    const count = countHandBuiltIconButtons(readFileSync(file, 'utf8'));
    if (count > 0) out[rel] = count;
  }
  return out;
}

function main() {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const failures = [];
  for (const [rel, count] of Object.entries(scan())) {
    const allowed = baseline[rel] ?? 0;
    if (count > allowed) failures.push(`${rel}: ${count} hand-built icon buttons (baseline ${allowed}); use IconButton`);
  }
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log('check:icon-only-controls passed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write-baseline')) {
    writeFileSync(BASELINE_PATH, JSON.stringify(scan(), null, 2) + '\n');
  } else main();
}
