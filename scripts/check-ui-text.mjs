#!/usr/bin/env node
// Scans built renderer/main/preload bundles for leaked project terminology (requirement/task
// numbers, user-story numbers, or phrases like "later task"/"wired up"/"not implemented") that
// should never reach a user-visible string. Usage: node scripts/check-ui-text.mjs [rootDir]
// (default: <repoRoot>/out). Exits 1 if any match is found, 2 if no bundle files were scanned,
// 0 otherwise.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const LEAK_PATTERN = /\b(?:FR|SC)-\d{3}\b|\bT\d{3}\b|\bUS\d\b|later task|wired up|User Story|not implemented/g;

// Exact matched substrings known to come from third-party bundled text, not Refract's own UI
// copy. Add an entry here (never loosen the regex above) if a real false positive shows up.
// 'not implemented' matches Mermaid's own bundled xychart error string ("Drawing of right axis
// is not implemented", mermaid.core's xychartDiagram chunk) -- a real upstream library message,
// not a Refract placeholder. This blanket-exempts the bare phrase everywhere; a future genuine
// Refract-authored "not implemented" leak would also be missed by this guard. If that happens,
// replace this entry with a more specific check (e.g. require the Mermaid-specific surrounding
// text) rather than tightening the shared regex, which every other pattern here still needs.
const ALLOWED = ['not implemented'];

const root = path.resolve(process.cwd(), process.argv[2] ?? path.join(repoRoot, 'out'));
const SUBDIRS = ['main', 'preload', path.join('renderer', 'assets')];

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
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
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

let leakCount = 0;
let fileCount = 0;

for (const subdir of SUBDIRS) {
  const dir = path.join(root, subdir);
  if (!isDirectory(dir)) continue;
  for (const file of walk(dir)) {
    fileCount++;
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const match of line.matchAll(LEAK_PATTERN)) {
        if (ALLOWED.includes(match[0])) continue;
        const relative = path.relative(root, file);
        const start = Math.max(0, match.index - 40);
        const context = line.slice(start, start + 80).trim();
        console.log(`${relative}:${i + 1} ${context}`);
        leakCount++;
      }
    }
  }
}

if (fileCount === 0) {
  console.log(`no built bundles found under ${root} -- did you run pnpm build first?`);
  process.exit(2);
} else if (leakCount > 0) {
  console.log(`${leakCount} leak${leakCount === 1 ? '' : 's'} found across ${fileCount} file${fileCount === 1 ? '' : 's'}`);
  process.exit(1);
} else {
  console.log(`0 leaks found across ${fileCount} file${fileCount === 1 ? '' : 's'}`);
  process.exit(0);
}
