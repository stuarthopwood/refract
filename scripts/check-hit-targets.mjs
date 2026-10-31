#!/usr/bin/env node
// Static guard (#1468): interactive elements must hit the 24px minimum target and buttons come from
// Button/IconButton. Flags raw <button>/role="button" and Button/IconButton sized under 24px
// (size-1..5, h-1..5). Existing uses are baselined per file and may shrink, never grow.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rendererTsxFiles } from './renderer-tsx-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'hit-targets-baseline.json');
const RAW_BUTTON = /<button\b|role=["']button["']/g;
// size-1..5, fractional (size-4.5) and arbitrary px under 24 (h-[20px]).
const SMALL_TARGET = /<(?:Button|IconButton)\b[^<]*?(?<![\w-])(?:size|h)-(?:[1-5](?:\.5)?|\[(?:[0-9]|1[0-9]|2[0-3])px\]|\[(?:0?\.\d+|1(?:\.[0-4]\d*)?)rem\])(?![\w.[/-])/g;
const EXEMPT_FILES = new Set(['src/renderer/components/IconButton.tsx', 'src/renderer/components/ui/button.tsx']);

export function countHitTargetIssues(text) {
  return [...text.matchAll(RAW_BUTTON)].length + [...text.matchAll(SMALL_TARGET)].length;
}

function scan() {
  const out = {};
  for (const file of rendererTsxFiles(path.join(repoRoot, 'src', 'renderer'))) {
    const rel = path.relative(repoRoot, file).split(path.sep).join('/');
    if (EXEMPT_FILES.has(rel)) continue;
    const count = countHitTargetIssues(readFileSync(file, 'utf8'));
    if (count > 0) out[rel] = count;
  }
  return out;
}

function main() {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const failures = [];
  for (const [rel, count] of Object.entries(scan())) {
    const allowed = baseline[rel] ?? 0;
    if (count > allowed) failures.push(`${rel}: ${count} hit-target problems (baseline ${allowed}); use Button/IconButton at 24px or larger`);
  }
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log('check:hit-targets passed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write-baseline')) {
    writeFileSync(BASELINE_PATH, JSON.stringify(scan(), null, 2) + '\n');
  } else main();
}
