#!/usr/bin/env node
// Static guard for issue #806 ("No god files"): files keep growing with nobody noticing until a
// review or an agent chokes on them. This enforces a 600-line soft cap on source files while
// tolerating the backlog of existing offenders via a baseline -- a file already in the baseline
// may stay over the cap, but it may never grow past its recorded size, and it is free to shrink
// (or drop out of the baseline entirely) at any time. Any file NOT already in the baseline that
// is over the cap is a hard failure: new god files don't get grandfathered in.
//
// Usage: node scripts/check-file-size.mjs [--update]
//   --update  Rewrite scripts/file-size-baseline.json, but only to record shrinkage: existing
//             entries are lowered to the file's current line count (never raised), and entries
//             for files that no longer exist or have shrunk to <= 600 lines are dropped. It
//             never adds a new entry, so a genuinely new over-cap file still fails even with
//             --update passed -- this flag is for recording progress, not laundering violations.
//
// Scans .ts/.tsx/.mjs files under src/ and scripts/, and .rs files under src-tauri/src/ (skipped
// entirely if that directory doesn't exist). Excludes test/spec files (*.test.*, *.spec.*),
// vendored shadcn components (src/renderer/components/ui/), and generated files (anything under
// a gen/ directory, or carrying an `AUTO-GENERATED`/`@generated` marker in its first 5 lines).
//
// Exits 1 if any new-file-over-cap or baseline-growth violation is found, 2 if no matching files
// were scanned at all, 0 otherwise.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'file-size-baseline.json');

export const SOFT_CAP = 600;

const EXCLUDED_DIRS = new Set(['node_modules', 'out', 'dist', '.git', 'target']);

export const DEFAULT_SCAN_ROOTS = [
  { subdir: 'src', exts: ['.ts', '.tsx', '.mjs'] },
  { subdir: 'scripts', exts: ['.ts', '.tsx', '.mjs'] },
  { subdir: path.join('src-tauri', 'src'), exts: ['.rs'] }
];

const TEST_FILE_RE = /\.(test|spec)\.[^./]+$/;
const VENDORED_UI_RE = /^src\/renderer\/components\/ui\//;
const GENERATED_MARKER_RE = /AUTO-GENERATED|@generated/;

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function* walk(dir, exts) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      yield* walk(full, exts);
    } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
      yield full;
    }
  }
}

// Path-shape exclusions only (no file content involved): test/spec files, vendored shadcn UI
// components, and anything under a `gen/` directory segment.
export function isExcludedPath(relative) {
  if (TEST_FILE_RE.test(relative)) return true;
  if (VENDORED_UI_RE.test(relative)) return true;
  if (relative.split('/').includes('gen')) return true;
  return false;
}

// A file is treated as generated (and excluded) if either of the known markers appears in its
// first 5 lines. Checked separately from isExcludedPath because it needs file content, not just
// the path.
function isGeneratedContent(lines) {
  return lines.slice(0, 5).some((line) => GENERATED_MARKER_RE.test(line));
}

// split() on a trailing-newline-terminated file produces one extra empty element; drop it so the
// count matches a plain line count (e.g. `wc -l`) rather than always being one too high.
function countLines(content) {
  const lines = content.split(/\r\n|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') return lines.length - 1;
  return lines.length;
}

// Walks the configured roots under baseDir and returns [{ relative, lineCount }] for every file
// that matches an extension and isn't excluded by path or content.
export function scanFiles(baseDir = repoRoot, roots = DEFAULT_SCAN_ROOTS) {
  const results = [];
  for (const { subdir, exts } of roots) {
    const dir = path.join(baseDir, subdir);
    if (!isDirectory(dir)) continue;
    for (const file of walk(dir, exts)) {
      const relative = path.relative(baseDir, file).split(path.sep).join('/');
      if (isExcludedPath(relative)) continue;
      const content = readFileSync(file, 'utf-8');
      if (isGeneratedContent(content.split(/\r\n|\n/))) continue;
      results.push({ relative, lineCount: countLines(content) });
    }
  }
  return results;
}

// Checks scanned files against the baseline. A file over SOFT_CAP fails if it isn't in the
// baseline at all (a new god file) or if its current line count exceeds its baseline value
// (growth); it passes -- even if still over the cap -- if it's baselined and at or below that
// recorded value. Files at or under SOFT_CAP never appear here regardless of baseline status.
// Returns both the full offender table (for display) and the failing subset.
export function checkAgainstBaseline(files, baseline) {
  const offenders = [];
  const failures = [];
  for (const { relative, lineCount } of files) {
    if (lineCount <= SOFT_CAP) continue;
    const hasBaseline = Object.prototype.hasOwnProperty.call(baseline, relative);
    const baselineCount = hasBaseline ? baseline[relative] : null;
    const failing = !hasBaseline || lineCount > baselineCount;
    const offender = { relative, lineCount, baselineCount, failing };
    offenders.push(offender);
    if (failing) failures.push(offender);
  }
  return { offenders, failures };
}

// Baseline entries whose file either no longer exists or has shrunk to <= SOFT_CAP: still
// tracked, but no longer earning their keep. Reported, not failed.
export function findRemovableBaselineEntries(files, baseline) {
  const current = new Map(files.map((f) => [f.relative, f.lineCount]));
  const removable = [];
  for (const relative of Object.keys(baseline)) {
    const lineCount = current.get(relative);
    if (lineCount === undefined || lineCount <= SOFT_CAP) removable.push(relative);
  }
  return removable;
}

// The --update rewrite: lower-only, remove stale/shrunk entries, never add. A file that is over
// cap and not already in the baseline is a violation to fix, not a value for --update to invent.
export function computeUpdatedBaseline(files, baseline) {
  const current = new Map(files.map((f) => [f.relative, f.lineCount]));
  const updated = {};
  for (const [relative, baselineCount] of Object.entries(baseline)) {
    const lineCount = current.get(relative);
    if (lineCount === undefined || lineCount <= SOFT_CAP) continue;
    updated[relative] = Math.min(lineCount, baselineCount);
  }
  return updated;
}

function sortObject(obj) {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
}

const isMain = process.argv[1] != null && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const updateMode = process.argv.includes('--update');
  const files = scanFiles();

  // A missing baseline file (first run) is an empty baseline; a baseline file that exists but
  // fails to parse is corrupt and must fail loudly, never silently reset to `{}` -- that would
  // make every current offender look like a brand-new violation and silently drop the ratchet.
  let baseline = {};
  if (existsSync(BASELINE_PATH)) {
    try {
      baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
    } catch (err) {
      throw new Error(`check-file-size: failed to parse baseline file ${BASELINE_PATH}: ${err.message}`);
    }
  }

  if (files.length === 0) {
    console.log(`no matching .ts/.tsx/.mjs/.rs files found under ${repoRoot}`);
    process.exit(2);
  }

  const { offenders, failures } = checkAgainstBaseline(files, baseline);
  const removable = findRemovableBaselineEntries(files, baseline);

  offenders.sort((a, b) => b.lineCount - a.lineCount);

  if (offenders.length > 0) {
    console.log(`files over the ${SOFT_CAP}-line soft cap:`);
    console.log('   lines  baseline  status  path');
    for (const { relative, lineCount, baselineCount, failing } of offenders) {
      const baselineText = baselineCount === null ? '-' : String(baselineCount);
      const status = failing ? 'FAIL' : 'ok';
      console.log(`  ${String(lineCount).padStart(6)}  ${baselineText.padStart(8)}  ${status.padStart(6)}  ${relative}`);
    }
  }

  if (removable.length > 0) {
    console.log(`${removable.length} baseline entr${removable.length === 1 ? 'y is' : 'ies are'} now removable (file gone or shrunk to <= ${SOFT_CAP} lines):`);
    for (const relative of removable) console.log(`  ${relative}`);
  }

  if (updateMode) {
    const updated = computeUpdatedBaseline(files, baseline);
    writeFileSync(BASELINE_PATH, `${JSON.stringify(sortObject(updated), null, 2)}\n`);
    console.log(`baseline updated: ${Object.keys(baseline).length} -> ${Object.keys(updated).length} entries`);
  }

  if (failures.length > 0) {
    console.log(`${failures.length} file${failures.length === 1 ? '' : 's'} over the ${SOFT_CAP}-line cap (new file over cap, or grew past its baseline)`);
    process.exit(1);
  }

  console.log(`0 cap violations across ${files.length} files scanned (${offenders.length} offender${offenders.length === 1 ? '' : 's'} within baseline, ${removable.length} removable baseline entr${removable.length === 1 ? 'y' : 'ies'})`);
  process.exit(0);
}
