#!/usr/bin/env node
// Chains the live checks that cover the paths spec 080 changed (alarm clock, chain card, transcript menus, profile/accounts).
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_080_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-080.mjs

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitHead } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = process.env.REFRACT_080_SHOTS_DIR || path.join(tmpdir(), 'refract-080-shots');

const STEPS = [
  { name: '072 chat followups (alarm clock)', script: 'verify-tauri-072.mjs', shotsEnv: 'REFRACT_072_SHOTS_DIR' },
  { name: '1437 chain card', script: 'verify-tauri-1437.mjs', shotsEnv: 'REFRACT_1437_SHOTS_DIR' },
  { name: '076 transcript menus and dialogs', script: 'verify-tauri-076.mjs', shotsEnv: 'REFRACT_076_SHOTS_DIR' },
  { name: '008 profile and accounts', script: 'verify-tauri-008.mjs', shotsEnv: 'REFRACT_008_SHOTS_DIR' },
];

mkdirSync(SHOTS_DIR, { recursive: true });
const results = [];
for (const step of STEPS) {
  const shots = path.join(SHOTS_DIR, step.script.replace(/\.mjs$/, ''));
  mkdirSync(shots, { recursive: true });
  const run = spawnSync(process.execPath, [path.join(__dirname, step.script)], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, [step.shotsEnv]: shots },
  });
  results.push({ step: step.name, ok: run.status === 0, status: run.status, shots });
}

const report = { gitHead: gitHead(REPO_ROOT), ok: results.every((r) => r.ok), results };
writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
console.log(`verify-080: ${report.ok ? 'PASS' : 'FAIL'} ${path.join(SHOTS_DIR, 'report.json')}`);
process.exit(report.ok ? 0 : 1);
