#!/usr/bin/env node
// Gate for #1322: source comments stay short "why" comments (AGENTS.md "Comments").
// A file fails when comment lines exceed 25% of its non-blank lines (40+ lines) or any comment
// block exceeds 6 lines. Existing offenders sit in scripts/comment-density-baseline.json and
// may shrink but never grow.
// Usage: node scripts/check-comment-density.mjs [--write-baseline]
// --write-baseline records current offenders and prunes stale entries; it is the only way to add one.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureFile } from './comment-density-scan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'comment-density-baseline.json');

export const MAX_BLOCK = 6;
export const MAX_RATIO = 0.25;
export const MIN_LINES_FOR_RATIO = 40;

const EXTS = ['.ts', '.tsx', '.rs', '.mjs'];
const ROOTS = ['src/renderer', 'src/shared', 'src-tauri/src', 'scripts'];
const EXCLUDED_DIRS = new Set(['node_modules', 'out', 'dist', '.git', 'target']);
const GENERATED_MARKER_RE = /AUTO-GENERATED|@generated/;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name) && entry.name !== 'gen') yield* walk(full);
    } else if (entry.isFile() && EXTS.includes(path.extname(entry.name))) {
      yield full;
    }
  }
}

export function isViolation({ nonBlank, commentLines, maxBlock }) {
  if (maxBlock > MAX_BLOCK) return true;
  return nonBlank >= MIN_LINES_FOR_RATIO && commentLines / nonBlank > MAX_RATIO;
}

export function scanFiles(baseDir = repoRoot) {
  const results = [];
  for (const root of ROOTS) {
    for (const file of walk(path.join(baseDir, root))) {
      const text = readFileSync(file, 'utf-8');
      if (text.split('\n', 5).some((line) => GENERATED_MARKER_RE.test(line))) continue;
      const relative = path.relative(baseDir, file).split(path.sep).join('/');
      results.push({ relative, ...measureFile(text, path.extname(file)) });
    }
  }
  return results;
}

// A baselined file passes while neither number exceeds its recorded value, even if it still
// violates the caps. An unbaselined violator fails.
export function checkAgainstBaseline(files, baseline) {
  const offenders = [];
  for (const f of files) {
    if (!isViolation(f)) continue;
    const base = Object.hasOwn(baseline, f.relative) ? baseline[f.relative] : null;
    const failing = base === null || f.commentLines > base.commentLines || f.maxBlock > base.maxBlock;
    offenders.push({ ...f, base, failing });
  }
  return offenders;
}

export function findStaleEntries(files, baseline) {
  const current = new Map(files.map((f) => [f.relative, f]));
  return Object.keys(baseline).filter((relative) => {
    const f = current.get(relative);
    return f === undefined || !isViolation(f);
  });
}

export function buildBaseline(files) {
  const entries = files
    .filter(isViolation)
    .sort((a, b) => a.relative.localeCompare(b.relative))
    .map((f) => [f.relative, { commentLines: f.commentLines, maxBlock: f.maxBlock }]);
  return Object.fromEntries(entries);
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  } catch (err) {
    // A corrupt baseline must fail loudly: resetting to {} would silently drop the ratchet.
    throw new Error(`check-comment-density: cannot parse ${BASELINE_PATH}: ${err.message}`);
  }
}

const isMain = process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const files = scanFiles();
  if (files.length === 0) {
    console.log(`no matching files found under ${repoRoot}`);
    process.exit(2);
  }

  if (process.argv.includes('--write-baseline')) {
    const baseline = buildBaseline(files);
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`baseline written: ${Object.keys(baseline).length} offenders across ${files.length} files`);
    process.exit(0);
  }

  const baseline = loadBaseline();
  const offenders = checkAgainstBaseline(files, baseline);
  const failures = offenders.filter((o) => o.failing);
  const stale = findStaleEntries(files, baseline);

  for (const o of failures) {
    const was = o.base ? ` (baseline ${o.base.commentLines} lines, block ${o.base.maxBlock})` : ' (not in baseline)';
    console.log(`FAIL ${o.relative}: ${o.commentLines}/${o.nonBlank} comment lines, largest block ${o.maxBlock}${was}`);
  }
  if (stale.length > 0) {
    console.log(`${stale.length} stale baseline entr${stale.length === 1 ? 'y' : 'ies'} (file gone or now within the caps); run --write-baseline to prune:`);
    for (const relative of stale) console.log(`  ${relative}`);
  }
  if (failures.length > 0) {
    console.log(`${failures.length} file(s) over the comment caps (${MAX_RATIO * 100}% of lines, blocks over ${MAX_BLOCK} lines); see AGENTS.md "Comments"`);
    process.exit(1);
  }
  console.log(`0 comment-density violations across ${files.length} files (${offenders.length} baselined offenders, ${stale.length} stale entries)`);
}
