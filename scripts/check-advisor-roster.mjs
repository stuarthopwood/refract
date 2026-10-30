#!/usr/bin/env node
// Fails when a WATCHDOG.yml/.yaml advisor roster (repo root or .omp/) is committed and not in
// scripts/advisor-roster-allowlist.json: a roster silently replaces the Advisor role (#1409).
// Usage: node scripts/check-advisor-roster.mjs
// Exit: 1 on a committed roster that is not allowlisted, 0 otherwise.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const ALLOWLIST_PATH = path.join(__dirname, 'advisor-roster-allowlist.json');
const ROSTER_PATHS = new Set(['WATCHDOG.yml', 'WATCHDOG.yaml', '.omp/WATCHDOG.yml', '.omp/WATCHDOG.yaml']);

const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
if (!Array.isArray(allowlist) || !allowlist.every((entry) => typeof entry === 'string')) {
  console.error('check-advisor-roster: advisor-roster-allowlist.json must be an array of repo-relative paths');
  process.exit(1);
}

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter(Boolean);
const offenders = tracked.filter((file) => ROSTER_PATHS.has(file) && !allowlist.includes(file));

if (offenders.length > 0) {
  for (const file of offenders) {
    console.error(`check-advisor-roster: ${file} is committed. A WATCHDOG roster overrides the Advisor role for every Session in this repo; remove it, or add it to scripts/advisor-roster-allowlist.json on purpose.`);
  }
  process.exit(1);
}
console.log('check-advisor-roster: no committed advisor roster.');
