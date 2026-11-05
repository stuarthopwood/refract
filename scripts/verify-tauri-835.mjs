#!/usr/bin/env node
// Live CDP check for #835: repositories.add returns the real remote kind in its own response, not the
// `unknown` placeholder. Scratch data dir and scratch repos only; no network (the remote URL is never fetched).
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-tauri-835.mjs
// Env: REFRACT_835_SHOTS_DIR overrides the report directory.

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { buildLauncher, safeRmSync, requireSharedCargoTarget, gitHead, computeDirty, makeScratchRepo } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-835';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_835_SHOTS_DIR || path.join(tmpdir(), 'lane835', 'shots');

const report = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
}

const addViaIpc = (dir) => `window.refract.repositories.add(${JSON.stringify(dir)})`;

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const dirs = Object.fromEntries(['data', 'import', 'repo-origin', 'repo-local', 'exe', 'launcher'].map((n) => [n, mkdtempSync(path.join(tmpdir(), `refract-835-${n}-`))]));
  const exe = path.join(dirs.exe, 'refract-tauri.exe');
  let cdp, child;
  try {
    makeScratchRepo(dirs['repo-origin'], 'v835');
    makeScratchRepo(dirs['repo-local'], 'v835');
    const remoteAdd = spawnSync('git', ['-C', dirs['repo-origin'], 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], { encoding: 'utf8', windowsHide: true });
    if (remoteAdd.status !== 0) throw new Error(`git remote add failed: ${remoteAdd.stderr}`);
    const launcherExe = buildLauncher(dirs.launcher);
    copyFileSync(path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe'), exe);
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exe, {
      port, dataDir: dirs.data, logFile: path.join(SHOTS_DIR, `app-${port}.log`),
      extraEnv: { REFRACT_IMPORT_SOURCE_DIR: dirs.import }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target not owned by launched pid');
    await cdp.waitFor(`!!window.refract?.repositories?.add`, { timeoutMs: 60_000, label: 'IPC bridge ready' });

    const withRemote = await cdp.evaluate(addViaIpc(dirs['repo-origin']));
    check(withRemote.ok === true && withRemote.value?.remote?.kind === 'has' && withRemote.value.remote.host === 'github.com',
      'add of a repo with an origin remote returns remote.kind "has" in the add response itself', withRemote.value?.remote ?? withRemote);

    const withoutRemote = await cdp.evaluate(addViaIpc(dirs['repo-local']));
    check(withoutRemote.ok === true && withoutRemote.value?.remote?.kind === 'none',
      'add of a repo without a remote returns remote.kind "none", not the "unknown" placeholder', withoutRemote.value?.remote ?? withoutRemote);
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    console.error(err);
    process.exitCode = 1;
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHead(REPO_ROOT), dirty: computeDirty(REPO_ROOT), steps: report }, null, 2));
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    for (const dir of Object.values(dirs)) await safeRmSync(dir, LOG);
  }
  if (report.length === 0 || report.some((r) => !r.ok)) process.exitCode = 1;
  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main();
