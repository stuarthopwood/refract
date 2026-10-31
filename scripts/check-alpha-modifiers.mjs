#!/usr/bin/env node
// Static guard (#579): colour utilities in src/renderer must not use Tailwind opacity modifiers;
// translucent surfaces are tokens in globals.css. Baselined per file, may shrink, never grow.
// Not detected: concatenated class fragments, `opacity-50`, `color-mix()` values, files outside src/renderer.
// A modifier after a trailing `//` comment is counted (false positive).

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'alpha-modifiers-baseline.json');
const TOKEN = /(?<![\w/-])(?:bg|text|ring|border|fill|stroke|shadow|outline|from|via|to|divide|decoration|caret|accent|placeholder|inset-ring|ring-offset|drop-shadow|text-shadow)-[a-z][a-z0-9-]*\/(?:\d+(?:\.\d+)?|\[[^\]\s]+\])(?![\w/])/g;
const EXCLUDED_DIRS = new Set(['node_modules', 'out', 'dist', '.git', 'target', 'assets']);

export function countAlphaModifiers(text) {
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;
    count += [...line.matchAll(TOKEN)].length;
  }
  return count;
}

function walk(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) walk(path.join(dir, entry.name), files);
    } else if (/\.(tsx?|css)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      files.push(path.join(dir, entry.name));
    }
  }
}

function main() {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const files = [];
  walk(path.join(repoRoot, 'src', 'renderer'), files);
  const failures = [];
  for (const file of files) {
    const rel = path.relative(repoRoot, file).split(path.sep).join('/');
    const count = countAlphaModifiers(readFileSync(file, 'utf8'));
    const allowed = baseline[rel] ?? 0;
    if (count > allowed) failures.push(`${rel}: ${count} opacity modifiers (baseline ${allowed}); add a token in globals.css instead`);
  }
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log('check:alpha-modifiers passed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write-baseline')) {
    const files = [];
    walk(path.join(repoRoot, 'src', 'renderer'), files);
    const out = {};
    for (const file of files.sort()) {
      const count = countAlphaModifiers(readFileSync(file, 'utf8'));
      if (count > 0) out[path.relative(repoRoot, file).split(path.sep).join('/')] = count;
    }
    writeFileSync(BASELINE_PATH, JSON.stringify(out, null, 2) + '\n');
  } else main();
}
