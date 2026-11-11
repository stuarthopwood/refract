#!/usr/bin/env node
// Live CDP check for issue #1765 (T062): a Settings write reaches a RUNNING Session's legacy overlay as well as the global config,
// and a startup-only key says "Applies to new Sessions".
// A read-only scratch config.yml makes the first migration fail, so the Session launches on the legacy overlay; the file is
// then made writable, the migration retries inside the Settings write, and the overlay must be rewritten.
// Uses the real `omp` against a scratch PI_CODING_AGENT_DIR (fake provider, no model calls) and a scratch REFRACT_DATA_DIR.
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-tauri-1765.mjs
// Env: REFRACT_1765_SHOTS_DIR overrides the screenshot/report directory.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget, gitHead, computeDirty, sha256OfFile, citeScreenshots } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-tauri-560-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1765';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1765_SHOTS_DIR || 'C:/Users/shopwood/refract-live-check-1765';
const MODEL = 'probe-fake/probe-fake-model';
const KEY = 'compaction.thresholdPercent';
const ORIGINAL_CONFIG = ['modelRoles:', `  default: ${MODEL}`, 'compaction:', '  thresholdPercent: 60', ''].join('\n');
const MODELS_YML = ['providers:', '  probe-fake:', '    baseUrl: http://127.0.0.1:1', '    auth: none', '    api: openai-completions', '    models:', '      - id: probe-fake-model', '        name: Probe Fake Model', '        api: openai-completions', '        contextWindow: 200000', '        maxTokens: 1000', ''].join('\n');
const LEGACY_STORE = { version: 2, overrides: { [KEY]: 70 }, read_limit_migrated: true, thresholds_reset_pending: false };

const report = [];
const shotNames = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
  if (ok !== true) process.exitCode = 1;
}

const navButton = (label) => `Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)})`;

function omp(agentDir, ...args) {
  const result = spawnSync('omp', args, { encoding: 'utf8', windowsHide: true, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
  if (result.status !== 0) throw new Error(`omp ${args.join(' ')} failed: ${result.stderr}`);
  return JSON.parse(result.stdout).value;
}

async function shoot(cdp, name) {
  await sleep(500);
  await cdp.screenshot(path.join(SHOTS_DIR, name));
  shotNames.push(name);
}

async function openAdvanced(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await cdp.click(navButton('Advanced'));
  await cdp.waitFor(`document.body.textContent.includes('File read line limit')`, { timeoutMs: 15_000, label: 'Advanced rendered' });
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1765-data-'));
  const agentDir = mkdtempSync(path.join(tmpdir(), 'refract-1765-agent-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1765-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1765-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1765-live');
  const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1765-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1765-launcher-'));
  const exe = path.join(exeDir, 'refract-tauri.exe');
  const dirs = [dataDir, agentDir, importSourceDir, repoDirBase, worktreesRoot, exeDir, launcherDir];
  const configFile = path.join(agentDir, 'config.yml');
  const overlayFile = path.join(dataDir, 'token-guard-overlay.yml');
  let session;
  try {
    const launcherExe = buildLauncher(launcherDir);
    copyFileSync(path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe'), exe);
    report.push({ step: 'build identity', ok: true, evidence: { head: gitHead(REPO_ROOT), dirty: computeDirty(REPO_ROOT), exeSha256: sha256OfFile(exe) } });
    check([exeDir, dataDir, agentDir].every((d) => d.startsWith(tmpdir())), 'Isolation: exe, data dir and OMP agent dir are scratch dirs', { exeDir, dataDir, agentDir });

    writeFileSync(configFile, ORIGINAL_CONFIG);
    writeFileSync(path.join(agentDir, 'models.yml'), MODELS_YML);
    writeFileSync(path.join(dataDir, 'token-guard.json'), JSON.stringify(LEGACY_STORE, null, 2));
    chmodSync(configFile, 0o444);

    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exe, { port, dataDir, importSourceDir, logFile: path.join(SHOTS_DIR, 'app.log'), extraEnv: { PI_CODING_AGENT_DIR: agentDir } });
    session = { cdp: await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 })), child: launched.child };
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target not owned by launched pid');
    const { cdp } = session;

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]') || !!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 60_000, label: 'Readiness or main screen' });
    if (await cdp.evaluate(`!document.querySelector('[aria-label="Settings"]') && !!document.querySelector('[data-readiness-primary]')`)) {
      await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
      await addRepository(cdp, repoDir);
    }
    await createSessionViaQuickCreate(cdp, path.basename(repoDir));
    await shoot(cdp, 'session-running.png');

    const overlayBefore = existsSync(overlayFile) ? readFileSync(overlayFile, 'utf8') : '';
    check(/thresholdPercent:\s*70\b/.test(overlayBefore), 'Running Session launched on the legacy overlay (migration pending, threshold 70)', overlayBefore);
    const mtimeBefore = existsSync(overlayFile) ? statSync(overlayFile).mtimeMs : 0;

    chmodSync(configFile, 0o644);
    await openAdvanced(cdp);
    const input = `document.getElementById(${JSON.stringify(`advanced-${KEY}`)})`;
    await cdp.waitFor(`!!${input}`, { timeoutMs: 30_000, label: 'threshold input' });
    await cdp.click(input);
    await cdp.evaluate(`${input}.select()`);
    await cdp.send('Input.insertText', { text: '55' });
    await cdp.pressEnter();

    let overlayAfter = '';
    for (let i = 0; i < 60; i++) {
      overlayAfter = readFileSync(overlayFile, 'utf8');
      if (/thresholdPercent:\s*55\b/.test(overlayAfter)) break;
      await sleep(250);
    }
    check(/thresholdPercent:\s*55\b/.test(overlayAfter) && statSync(overlayFile).mtimeMs > mtimeBefore, 'Settings change rewrote the running Session\'s legacy overlay (threshold 55)', overlayAfter);
    check(omp(agentDir, 'config', 'get', KEY, '--json') === 55, 'Settings change landed in the global config (threshold 55)', null);
    check(await cdp.evaluate(`!!document.querySelector('[aria-label="Back to chat"]')`), 'Settings still open and the app alive after the write', null);

    const labels = await cdp.evaluate(`(() => ({
      liveRowHasLabel: document.getElementById('advanced-${KEY}-status') !== null,
      startupRowHasLabel: document.getElementById('advanced-task.maxConcurrency-status')?.textContent === 'Applies to new Sessions'
    }))()`);
    check(labels.startupRowHasLabel && !labels.liveRowHasLabel, '"Applies to new Sessions" shows on startup-only task.maxConcurrency and not on live compaction.thresholdPercent', labels);
    await cdp.evaluate(`document.getElementById('advanced-task.maxConcurrency-status')?.scrollIntoView({ block: 'center' })`);
    await shoot(cdp, 'applies-to-new-sessions-label.png');
    await cdp.evaluate(`${input}.scrollIntoView({ block: 'center' })`);
    await shoot(cdp, 'live-key-after-change.png');
    await cdp.evaluate(`window.scrollTo(0, 0); document.querySelector('main, [role="main"]')?.scrollTo?.(0, 0)`);
    await cdp.click(`Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Optimise token usage')`);
    await cdp.waitFor(`!!document.querySelector('[role="alertdialog"]')`, { timeoutMs: 10_000, label: 'Optimise dialog' });
    const dialogText = await cdp.evaluate(`document.querySelector('[role="alertdialog"]').textContent`);
    check(dialogText.includes('Running Sessions pick up the ones that apply live; the rest apply to new Sessions.') && !dialogText.includes('running Sessions and all other settings are unchanged'), 'Optimise dialog states live keys reach running Sessions and the rest apply to new Sessions', dialogText);
    await shoot(cdp, 'optimise-dialog.png');
    await cdp.click(`Array.from(document.querySelectorAll('[role="alertdialog"] button')).find((b) => b.textContent.trim() === 'Cancel')`);
    report.push({ step: 'screenshots (sha256)', ok: true, evidence: citeScreenshots(SHOTS_DIR, shotNames) });
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    console.error(err);
    try { if (session) await session.cdp.screenshot(path.join(SHOTS_DIR, 'crash.png')); } catch {}
    process.exitCode = 1;
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    if (session) {
      session.cdp.close();
      await stopLauncher(session.child).catch(() => {});
    }
    for (const dir of dirs) await safeRmSync(dir, LOG);
  }
  if (report.some((r) => !r.ok)) process.exitCode = 1;
  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main();
