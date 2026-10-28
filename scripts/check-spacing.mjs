#!/usr/bin/env node
// Static guard for issue #1252 (8px spacing grid with a 4px half-step): every padding, margin,
// gap and space-x/y utility in src/renderer must use an allowed step, so spacing cannot drift
// back to 6px, 10px, 2px and friends.
//
// Allowed steps: 0, 4, 8, 16, 24, 32, 40, 48 px (Tailwind 0, 1, 2, 4, 6, 8, 10, 12), plus any
// multiple of 8px above 48 for large reserved offsets (for example space for a trailing button).
// Sizing utilities (size-*, w-*, h-*) are not gated. Arbitrary values such as p-[6px] are checked when
// they are a plain px or rem length; var()/calc() values are left alone.
//
// Exceptions live in scripts/spacing-allowlist.json as { file, text, reason, count? } entries
// (file is repo-relative with forward slashes, text is the exact offending token). An entry that
// no longer matches anything is a failure, so exceptions cannot rot.
//
// Usage: node scripts/check-spacing.mjs
// Exits 1 on any violation or stale allowlist entry, 0 otherwise.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const ALLOWLIST_PATH = path.join(__dirname, 'spacing-allowlist.json');

const ALLOWED_PX = new Set([0, 4, 8, 16, 24, 32, 40, 48]);
const PROPS =
  'p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y';
const TOKEN = new RegExp(`(?<=^|[\\s"'\`:!(])(-?)(${PROPS})-(\\[[^\\]\\s]+\\]|[0-9][0-9.]*)(?![\\w.-])`, 'g');
const EXTS = new Set(['.ts', '.tsx', '.css']);
const EXCLUDED_DIRS = new Set(['node_modules', 'out', 'dist', '.git', 'target', 'assets']);

function pxOf(value) {
  if (value.startsWith('[')) {
    const m = /^\[(-?\d+(?:\.\d+)?)(px|rem)\]$/.exec(value);
    if (!m) return null;
    return Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
  }
  return Number(value) * 4;
}

function allowed(px) {
  const abs = Math.abs(px);
  return ALLOWED_PX.has(abs) || (abs > 48 && abs % 8 === 0);
}

export function findViolations(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(TOKEN)) {
      const px = pxOf(m[3]);
      if (px === null || allowed(px)) continue;
      out.push({ line: i + 1, text: m[0] });
    }
  });
  return out;
}

function walk(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) walk(path.join(dir, entry.name), files);
    } else if (EXTS.has(path.extname(entry.name)) && !/\.(test|spec)\./.test(entry.name)) {
      files.push(path.join(dir, entry.name));
    }
  }
}

function main() {
  const files = [];
  walk(path.join(repoRoot, 'src', 'renderer'), files);
  const allow = existsSync(ALLOWLIST_PATH) ? JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) : [];
  const budget = new Map(allow.map((a) => [`${a.file}|${a.text}`, a.count ?? 1]));
  const used = new Map();
  const failures = [];
  for (const file of files) {
    const rel = path.relative(repoRoot, file).split(path.sep).join('/');
    for (const v of findViolations(readFileSync(file, 'utf8'))) {
      const key = `${rel}|${v.text}`;
      const left = budget.get(key) ?? 0;
      const taken = used.get(key) ?? 0;
      if (taken < left) used.set(key, taken + 1);
      else failures.push(`${rel}:${v.line}  ${v.text}`);
    }
  }
  for (const a of allow) {
    const key = `${a.file}|${a.text}`;
    if ((used.get(key) ?? 0) < (a.count ?? 1)) {
      failures.push(`stale allowlist entry: ${a.file} "${a.text}"`);
    }
  }
  if (failures.length > 0) {
    console.error(`check:spacing: ${failures.length} problem(s). Use 0, 4, 8, 16, 24, 32, 40 or 48 px (Tailwind 0, 1, 2, 4, 6, 8, 10, 12).`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`check:spacing: ${files.length} files scanned, all spacing on the 8px grid.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
