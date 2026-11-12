#!/usr/bin/env node
// Live CDP check (three scenarios on scratch launches): A, a live key changed in Settings with a Session running reaches the global
// config.yml; B, a failed launch migration leaves a legacy overlay that the Settings write must rewrite; C, as B but the overlay
// refresh fails, so Settings must show the write's warning while the value is still saved.
// No model calls: the real `omp` runs against a scratch PI_CODING_AGENT_DIR and REFRACT_DATA_DIR.
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-tauri-1765.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, statSync, readdirSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget, gitHead, computeDirty, sha256OfFile } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-tauri-560-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1765';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
// The shared target holds whichever lane built last; REFRACT_1765_EXE pins the copy taken right after this lane's own build.
const EXE_SOURCE = process.env.REFRACT_1765_EXE || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
const SHOTS_DIR = process.env.REFRACT_1765_SHOTS_DIR || 'C:/Users/shopwood/refract-live-check-1765';
const MODEL = 'probe-fake/probe-fake-model';
const KEY = 'compaction.thresholdPercent';
const NEW_VALUE = 55;
const LEGACY_VALUE = 65;
const WARNING_TEXT = 'Saved, but a Session started before the migration may keep the old values';
const ORIGINAL_CONFIG = ['modelRoles:', `  default: ${MODEL}`, 'compaction:', '  thresholdPercent: 60', ''].join('\n');
const MODELS_YML = ['providers:', '  probe-fake:', '    baseUrl: http://127.0.0.1:1', '    auth: none', '    api: openai-completions', '    models:', '      - id: probe-fake-model', '        name: Probe Fake Model', '        api: openai-completions', '        contextWindow: 200000', '        maxTokens: 1000', ''].join('\n');
const LEGACY_STORE = { version: 2, overrides: { [KEY]: LEGACY_VALUE }, read_limit_migrated: true, thresholds_reset_pending: false };
const thresholdIs = (text, n) => new RegExp(`thresholdPercent:\\s*${n}\\b`).test(text);

const report = [];
const evidenceFiles = [];
let scenario = '';
function check(ok, label, evidence) {
  report.push({ scenario, step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${scenario} ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
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
  evidenceFiles.push(name);
}

function keepFile(source, name) {
  copyFileSync(source, path.join(SHOTS_DIR, name));
  evidenceFiles.push(name);
}

async function openAdvanced(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await cdp.click(navButton('Advanced'));
  await cdp.waitFor(`document.body.textContent.includes('File read line limit')`, { timeoutMs: 15_000, label: 'Advanced rendered' });
}

async function changeThreshold(cdp) {
  await openAdvanced(cdp);
  const input = `document.getElementById(${JSON.stringify(`advanced-${KEY}`)})`;
  await cdp.waitFor(`!!${input}`, { timeoutMs: 30_000, label: 'threshold input' });
  await cdp.click(input);
  await cdp.evaluate(`${input}.select()`);
  await cdp.send('Input.insertText', { text: String(NEW_VALUE) });
  await cdp.pressEnter();
  return input;
}

async function waitForFile(file, predicate) {
  let text = '';
  for (let i = 0; i < 360; i++) {
    text = existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8') : '';
    if (predicate(text)) break;
    await sleep(250);
  }
  return text;
}

/** Runs `body` on one scratch launch of the exe; `seed` prepares the scratch dirs before it starts. */
async function withApp(name, seed, body) {
  scenario = name;
  const dataDir = mkdtempSync(path.join(tmpdir(), `refract-1765${name}-data-`));
  const agentDir = mkdtempSync(path.join(tmpdir(), `refract-1765${name}-agent-`));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), `refract-1765${name}-import-`));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), `refract-1765${name}-repo-`));
  const repoDir = makeScratchRepo(repoDirBase, `verify-1765-${name}`);
  const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), `refract-1765${name}-exe-`));
  const launcherDir = mkdtempSync(path.join(tmpdir(), `refract-1765${name}-launcher-`));
  const exe = path.join(exeDir, 'refract-tauri.exe');
  const dirs = [dataDir, agentDir, importSourceDir, repoDirBase, worktreesRoot, exeDir, launcherDir];
  let session;
  try {
    const launcherExe = buildLauncher(launcherDir);
    copyFileSync(EXE_SOURCE, exe);
    report.push({ scenario, step: 'build identity', ok: true, evidence: { head: gitHead(REPO_ROOT), dirty: computeDirty(REPO_ROOT), exeSha256: sha256OfFile(exe) } });
    check([exeDir, dataDir, agentDir].every((d) => d.startsWith(tmpdir())), 'Isolation: exe, data dir and OMP agent dir are scratch dirs', { exeDir, dataDir, agentDir });
    writeFileSync(path.join(agentDir, 'models.yml'), MODELS_YML);
    writeFileSync(path.join(agentDir, 'config.yml'), ORIGINAL_CONFIG);
    seed({ dataDir, agentDir });

    const port = await getFreePort();
    const logName = `app-${name}.log`;
    const launched = await launchBuiltExe(launcherExe, exe, { port, dataDir, importSourceDir, logFile: path.join(SHOTS_DIR, logName), extraEnv: { PI_CODING_AGENT_DIR: agentDir } });
    evidenceFiles.push(logName);
    session = { cdp: await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 })), child: launched.child };
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target not owned by launched pid');
    const { cdp } = session;
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]') || !!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 60_000, label: 'Readiness or main screen' });
    if (await cdp.evaluate(`!document.querySelector('[aria-label="Settings"]') && !!document.querySelector('[data-readiness-primary]')`)) {
      await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
      await addRepository(cdp, repoDir);
    }
    await createSessionViaQuickCreate(cdp, path.basename(repoDir));
    await body({ cdp, dataDir, agentDir });
  } catch (err) {
    report.push({ scenario, step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    console.error(err);
    try { if (session) await session.cdp.screenshot(path.join(SHOTS_DIR, `crash-${name}.png`)); } catch {}
    process.exitCode = 1;
  } finally {
    if (session) {
      session.cdp.close();
      await stopLauncher(session.child).catch(() => {});
    }
    for (const dir of dirs) await safeRmSync(dir, LOG);
  }
}

async function scenarioA() {
  await withApp('A', () => {}, async ({ cdp, dataDir, agentDir }) => {
    const configFile = path.join(agentDir, 'config.yml');
    await shoot(cdp, 'A-session-running.png');
    check((await waitForFile(path.join(dataDir, 'token-guard-migration.json'), (t) => t !== '')) !== '', 'Migration finished normally (marker written, no legacy file seeded)', null);
    check(!existsSync(path.join(dataDir, 'token-guard-overlay.yml')), 'Running Session launched without a legacy overlay', null);
    const before = omp(agentDir, 'config', 'get', KEY, '--json');
    check(before !== NEW_VALUE, `Global config holds ${before} before the change (not ${NEW_VALUE})`, before);

    const input = await changeThreshold(cdp);
    const configText = await waitForFile(configFile, (t) => thresholdIs(t, NEW_VALUE));
    check(thresholdIs(configText, NEW_VALUE), `Settings change with a Session running wrote thresholdPercent ${NEW_VALUE} to the scratch global config.yml`, configText);
    check(omp(agentDir, 'config', 'get', KEY, '--json') === NEW_VALUE, `omp config get ${KEY} reads ${NEW_VALUE}`, null);
    check(await cdp.evaluate(`!!document.querySelector('[aria-label="Back to chat"]')`), 'Settings still open and the app alive after the write', null);
    keepFile(configFile, 'A-config.yml');

    const labels = await cdp.evaluate(`(() => ({
      liveRowHasLabel: document.getElementById('advanced-${KEY}-status') !== null,
      startupRowHasLabel: document.getElementById('advanced-task.maxConcurrency-status')?.textContent === 'Applies to new Sessions'
    }))()`);
    check(labels.startupRowHasLabel && !labels.liveRowHasLabel, '"Applies to new Sessions" shows on startup-only task.maxConcurrency and not on live compaction.thresholdPercent', labels);
    await cdp.evaluate(`document.getElementById('advanced-task.maxConcurrency-status')?.scrollIntoView({ block: 'center' })`);
    await shoot(cdp, 'A-applies-to-new-sessions-label.png');
    await cdp.evaluate(`${input}.scrollIntoView({ block: 'center' })`);
    await shoot(cdp, 'A-live-key-after-change.png');
    await cdp.evaluate(`window.scrollTo(0, 0); document.querySelector('main, [role="main"]')?.scrollTo?.(0, 0)`);
    await cdp.click(`Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Optimise token usage')`);
    await cdp.waitFor(`!!document.querySelector('[role="alertdialog"]')`, { timeoutMs: 10_000, label: 'Optimise dialog' });
    const dialogText = await cdp.evaluate(`document.querySelector('[role="alertdialog"]').textContent`);
    check(dialogText.includes('Running Sessions pick up the ones that apply live; the rest apply to new Sessions.') && !dialogText.includes('running Sessions and all other settings are unchanged'), 'Optimise dialog states live keys reach running Sessions and the rest apply to new Sessions', dialogText);
    await shoot(cdp, 'A-optimise-dialog.png');
    await cdp.click(`Array.from(document.querySelectorAll('[role="alertdialog"] button')).find((b) => b.textContent.trim() === 'Cancel')`);
  });
}

async function scenarioB(name, blockOverlay) {
  await withApp(name, ({ dataDir }) => {
    writeFileSync(path.join(dataDir, 'token-guard.json'), JSON.stringify(LEGACY_STORE, null, 2));
    // The migration records a backup pointer here before it writes anything; a directory makes that atomic rename fail.
    mkdirSync(path.join(dataDir, 'token-guard-migration-backup.json'));
  }, async ({ cdp, dataDir, agentDir }) => {
    const overlayFile = path.join(dataDir, 'token-guard-overlay.yml');
    const marker = path.join(dataDir, 'token-guard-migration.json');
    await shoot(cdp, `${name}-session-on-legacy-overlay.png`);
    check(!existsSync(marker), 'Migration failed at launch: no success marker, app booted and a Session is running', null);
    const overlayBefore = existsSync(overlayFile) ? readFileSync(overlayFile, 'utf8') : '';
    check(thresholdIs(overlayBefore, LEGACY_VALUE), `Running Session launched on the legacy overlay (seeded threshold ${LEGACY_VALUE})`, overlayBefore);
    keepFile(overlayFile, `${name}-overlay-before.yml`);
    const mtimeBefore = statSync(overlayFile).mtimeMs;

    await safeRmSync(path.join(dataDir, 'token-guard-migration-backup.json'), LOG);
    // A read-only overlay is still readable (so Refract knows it generated it) but the atomic rename over it fails.
    if (blockOverlay) chmodSync(overlayFile, 0o444);
    await changeThreshold(cdp);
    const warningShown = (timeoutMs) => cdp.waitFor(`Array.from(document.querySelectorAll('[data-slot="alert"]')).some((a) => a.textContent.includes(${JSON.stringify(WARNING_TEXT)}))`, { timeoutMs, label: 'write warning' }).then(() => true, () => false);
    if (blockOverlay) {
      // The write first re-runs the whole migration (one `omp config set` per key, over 30 s), so the warning arrives as late as the config does in B.
      const warned = await warningShown(120_000);
      const overlayAfter = readFileSync(overlayFile, 'utf8');
      check(warned, 'Settings shows the legacy-overlay refresh failure as a warning', await cdp.evaluate(`Array.from(document.querySelectorAll('[data-slot="alert"]')).map((a) => a.textContent)`));
      check(thresholdIs(overlayAfter, LEGACY_VALUE) && !thresholdIs(overlayAfter, NEW_VALUE), 'The blocked legacy overlay kept the old threshold', overlayAfter);
      await shoot(cdp, `${name}-warning-shown.png`);
      chmodSync(overlayFile, 0o666);
    } else {
      const overlayAfter = await waitForFile(overlayFile, (t) => thresholdIs(t, NEW_VALUE));
      check(thresholdIs(overlayAfter, NEW_VALUE) && statSync(overlayFile).mtimeMs > mtimeBefore, `Settings change rewrote the running Session's legacy overlay (threshold ${NEW_VALUE})`, overlayAfter);
      check(!(await warningShown(3_000)), 'No warning shows when the overlay refresh succeeds', null);
      keepFile(overlayFile, `${name}-overlay-after.yml`);
    }
    check(existsSync(marker), 'Migration succeeded on the retry inside the Settings write (marker written)', null);
    check(omp(agentDir, 'config', 'get', KEY, '--json') === NEW_VALUE, `Global config holds ${NEW_VALUE} too`, null);
    await shoot(cdp, `${name}-after-settings-write.png`);
  });
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  await scenarioA();
  await scenarioB('B', false);
  await scenarioB('C', true);
  const hashes = Object.fromEntries(evidenceFiles.filter((n) => existsSync(path.join(SHOTS_DIR, n))).map((n) => [n, sha256OfFile(path.join(SHOTS_DIR, n))]));
  writeFileSync(path.join(SHOTS_DIR, 'sha256.json'), JSON.stringify(hashes, null, 2));
  report.push({ scenario: '', step: 'evidence files (sha256)', ok: true, evidence: hashes });
  writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
  if (report.some((r) => !r.ok)) process.exitCode = 1;
  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}; files: ${readdirSync(SHOTS_DIR).length}`);
}

main();
