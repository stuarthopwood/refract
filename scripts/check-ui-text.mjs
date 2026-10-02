#!/usr/bin/env node
// Scans built renderer/main/preload bundles for leaked project terminology (requirement/task
// numbers, user-story numbers, or phrases like "later task"/"wired up"/"not implemented") that
// should never reach a user-visible string. Usage: node scripts/check-ui-text.mjs [rootDir]
// (default: <repoRoot>/out). Exits 1 if any match is found, 0 otherwise.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const LEAK_PATTERN = /\b(?:FR|SC)-\d{3}\b|\bT\d{3}\b|\bUS\d\b|later task|wired up|User Story|not implemented/;

// Exact matched substrings known to come from third-party bundled text, not Refract's own UI
// copy. Add an entry here (never loosen the regex above) if a real false positive shows up.
const ALLOWED = [];

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

for (const subdir of SUBDIRS) {
  const dir = path.join(root, subdir);
  if (!isDirectory(dir)) continue;
  for (const file of walk(dir)) {
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = LEAK_PATTERN.exec(line);
      if (!match) continue;
      if (ALLOWED.includes(match[0])) continue;
      const relative = path.relative(root, file);
      const start = Math.max(0, match.index - 40);
      const context = line.slice(start, start + 80).trim();
      console.log(`${relative}:${i + 1} ${context}`);
      leakCount++;
    }
  }
}

if (leakCount > 0) {
  console.log(`${leakCount} leak${leakCount === 1 ? '' : 's'} found`);
  process.exit(1);
} else {
  console.log('no leaks found');
  process.exit(0);
}
