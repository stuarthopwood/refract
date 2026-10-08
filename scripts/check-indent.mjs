#!/usr/bin/env node
// Static guard for issue #387: this codebase is strictly 2-space indented, so any *odd* leading-
// space count on a non-blank line is a reliable signature of the write/edit tool's silent
// whole-file reformatting bug (confirmed root cause: `cfg://lsp`'s `formatOnWrite: true` driving
// an LSP formatter with the wrong indent width -- see issue #387's own comments). A JSDoc block
// continuation line (` * text` or a bare `*/` closing delimiter) is legitimately odd-indented by
// convention and is excluded. Usage: node scripts/check-indent.mjs [rootDir] (default:
// <repoRoot>/src). Exits 1 if any unallowed odd-indent line is found, 2 if no .ts/.tsx files were
// scanned, 0 otherwise.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const root = path.resolve(process.cwd(), process.argv[2] ?? path.join(repoRoot, 'src'));

// Files with known, pre-existing odd-indent damage (issue #387) not fixed by this guard's own
// introducing change (PLAN.md row A3 named only 4 files; these 4 more were found by the same
// repo-wide scan but are out of that row's scope). Tracked here, not silently ignored, so this
// guard still catches any NEW instance of the bug without re-litigating these on every run.
// Follow-up: fix these and remove the entries.
const ALLOWED_FILES = new Set([
  'src/shared/mermaidTheme.ts',
  'src/renderer/state/theme-store.ts',
  'src/main/omp/loginProviders.ts',
  'src/renderer/lib/use-cleared-announcement.ts'
]);

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
      yield* walk(full);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      yield full;
    }
  }
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

let fileCount = 0;
let damagedFileCount = 0;
let lineCount = 0;

for (const file of isDirectory(root) ? walk(root) : []) {
  fileCount++;
  const relative = path.relative(repoRoot, file).split(path.sep).join('/');
  if (ALLOWED_FILES.has(relative)) continue;

  const content = readFileSync(file, 'utf-8');
  const lines = content.split(/\r\n|\n/);
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const stripped = line.replace(/^ +/, '');
    const indent = line.length - stripped.length;
    if (indent === 0) continue;
    if (stripped.startsWith('*')) continue; // JSDoc ` * text` continuation or a bare `*/` close
    if (indent % 2 === 1) bad.push({ lineNo: i + 1, indent, text: stripped.slice(0, 80) });
  }

  if (bad.length > 0) {
    damagedFileCount++;
    lineCount += bad.length;
    console.log(`${relative}: ${bad.length} odd-indent line${bad.length === 1 ? '' : 's'}`);
    for (const { lineNo, indent, text } of bad.slice(0, 5)) {
      console.log(`  ${relative}:${lineNo} (indent ${indent}) ${text}`);
    }
    if (bad.length > 5) console.log(`  ... and ${bad.length - 5} more`);
  }
}

if (fileCount === 0) {
  console.log(`no .ts/.tsx files found under ${root}`);
  process.exit(2);
} else if (damagedFileCount > 0) {
  console.log(`${lineCount} odd-indent line${lineCount === 1 ? '' : 's'} across ${damagedFileCount} file${damagedFileCount === 1 ? '' : 's'} (${fileCount} scanned, ${ALLOWED_FILES.size} allow-listed)`);
  process.exit(1);
} else {
  console.log(`0 odd-indent lines across ${fileCount} files scanned (${ALLOWED_FILES.size} allow-listed)`);
  process.exit(0);
}
