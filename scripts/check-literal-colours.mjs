#!/usr/bin/env node
// Static guard (#1473, ADR 0001): src/renderer code must not use hex literals or Tailwind palette
// colour classes (text-green-600, bg-black); colour comes from theme tokens. Existing uses are
// baselined per file in literal-colours-baseline.json and may shrink, never grow.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanTypeScriptComments } from './comment-density-scan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'literal-colours-baseline.json');
const PALETTE =
  /(?<![\w-])(?:bg|text|ring|ring-offset|border|border-[xytrblse]|fill|stroke|shadow|drop-shadow|inset-ring|outline|from|via|to|divide|decoration|caret|accent|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d{2,3})?(?![\w-])/g;
// Quoted hex, minus SVG refs (url(#id), url("#id"), href="#id") and DOM selector arguments. Inline hex after a space, comma or colon
// needs 6 or 8 digits, a digit plus a letter, or one repeated letter (#fff), so "PR #123" and "#bad" are not colours.
const HEX_QUOTED =
  /(?<!url\(["']?|href=["']|(?:querySelector(?:All)?|closest|matches)\(["'`])(?<=["'`[(])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const HEX_INLINE =
  /(?<=[\s,:])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|(?=[0-9a-fA-F]*[0-9])(?=[0-9]*[a-fA-F])[0-9a-fA-F]{3,4}|([a-fA-F])\1{2,3})(?![\w-])/g;
const FUNCTIONAL = /(?<![\w-])(?:rgba?|hsla?|hwb|ok?lab|ok?lch)\(\s*[\d.]/g;
const EXCLUDED_DIRS = new Set(['node_modules', 'out', 'dist', '.git', 'target']);

// Blanks comments with the TypeScript scanner so `//` inside a string is code and issue refs such as `(#1001)` are not colours.
function blankComments(text, ext) {
  let out = '';
  let last = 0;
  for (const [start, end] of scanTypeScriptComments(text, ext)) {
    out += text.slice(last, start) + text.slice(start, end).replace(/[^\n]/g, ' ');
    last = end;
  }
  return out + text.slice(last);
}

export function countLiteralColours(text, ext = '.tsx') {
  const code = blankComments(text, ext);
  return [PALETTE, HEX_QUOTED, HEX_INLINE, FUNCTIONAL].reduce((n, re) => n + [...code.matchAll(re)].length, 0);
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
    let count;
    try {
      count = countLiteralColours(readFileSync(file, 'utf8'), path.extname(file));
    } catch (err) {
      throw new Error(`check-literal-colours: cannot scan ${file}: ${err.message}`);
    }
    if (count > 0) out[path.relative(repoRoot, file).split(path.sep).join('/')] = count;
  }
  return out;
}

/** Failures for counts above the baseline, and for stale allowances (the baseline must shrink with the code). */
export function findFailures(counts, baseline) {
  const failures = [];
  for (const [rel, count] of Object.entries(counts)) {
    const allowed = baseline[rel] ?? 0;
    if (count > allowed) failures.push(`${rel}: ${count} literal colours (baseline ${allowed}); use a theme token`);
  }
  for (const [rel, allowed] of Object.entries(baseline)) {
    const count = counts[rel] ?? 0;
    if (count < allowed) failures.push(`${rel}: ${count} literal colours, baseline ${allowed}; run pnpm check:literal-colours --write-baseline`);
  }
  return failures;
}

function main() {
  const failures = findFailures(scan(), JSON.parse(readFileSync(BASELINE_PATH, 'utf8')));
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
