#!/usr/bin/env node
// Static guard (#1473, ADR 0001): src/renderer code must not use hex literals or Tailwind palette
// colour classes (text-green-600, bg-black); colour comes from theme tokens. Existing uses are
// baselined per file in literal-colours-baseline.json and may shrink, never grow.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'literal-colours-baseline.json');
const PALETTE =
  /(?<![\w-])(?:bg|text|ring|border|fill|stroke|shadow|outline|from|via|to|divide|decoration|caret|accent)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d{2,3})?(?![\w-])/g;
const HEX = /(?<=["'`[(])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const EXCLUDED_DIRS = new Set(['node_modules', 'out', 'dist', '.git', 'target', 'assets']);

export function countLiteralColours(text) {
  // Comments are blanked first: issue refs such as `(#1001)` otherwise read as short hex colours.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  return [...code.matchAll(PALETTE)].length + [...code.matchAll(HEX)].length;
}

function walk(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) walk(path.join(dir, entry.name), files);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
      files.push(path.join(dir, entry.name));
    }
  }
}

function scan() {
  const files = [];
  walk(path.join(repoRoot, 'src', 'renderer'), files);
  const out = {};
  for (const file of files.sort()) {
    const count = countLiteralColours(readFileSync(file, 'utf8'));
    if (count > 0) out[path.relative(repoRoot, file).split(path.sep).join('/')] = count;
  }
  return out;
}

function main() {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const failures = [];
  for (const [rel, count] of Object.entries(scan())) {
    const allowed = baseline[rel] ?? 0;
    if (count > allowed) failures.push(`${rel}: ${count} literal colours (baseline ${allowed}); use a theme token`);
  }
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log('check:literal-colours passed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write-baseline')) {
    writeFileSync(BASELINE_PATH, JSON.stringify(scan(), null, 2) + '\n');
  } else main();
}
