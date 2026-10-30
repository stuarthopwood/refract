#!/usr/bin/env node
// Scans built renderer bundles for leaked project terminology that must never reach user-visible strings.
// Exits 1 on a match, 2 if no bundle files were scanned.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const LEAK_PATTERN = /\b(?:FR|SC)-\d{3}\b|\bT\d{3}\b|\bUS\d\b|later task|wired up|User Story|not implemented/g;

// Third-party bundled text, not Refract copy. 'not implemented' is Mermaid's own xychart error;
// this exempts the phrase everywhere, so a genuine Refract leak of it would be missed.
const ALLOWED = ['not implemented'];

const root = path.resolve(process.cwd(), process.argv[2] ?? path.join(repoRoot, 'out'));
const SUBDIRS = [path.join('tauri-web', 'assets')];

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
