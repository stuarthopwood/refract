#!/usr/bin/env node
// Live CDP check for issue #883 (frictionless in-app updates: periodic check, background download,
// "Update now" row, restart-to-update confirm). Two launches of one debug exe:
//
//   Run A (stubbed release source, no seeded state): a fake `gh` (scripts/verify-883-gh-shim.rs,
//     first on PATH) reports only the running version. Asserts (a) no prompt at launch and the
//     periodic tick runs while nothing is newer, (b) after a flag file flips the fake release list,
//     the periodic check detects it with no clicks, (c) the download starts by itself, and the
//     fake installer's Authenticode check (never weakened) fails, so (d-failure) the failure
//     surfaces cleanly as the "Update failed" footer badge and no "ready" row appears.
//   Run B (seeded `updateState.json` in the Downloaded phase, a fake-omp turn left running):
//     asserts (d) the sidebar "Refract 9.9.9 is ready" row with its "Update now" action plus the
//     footer "Update ready" badge, (e) "Update now" with one agent mid-turn shows the confirm
//     dialog naming the count, Cancel keeps the app running, and "Restart and update" quits the
//     app without running the (fake, unsigned) installer: the quit hook's own signature
//     re-check refuses it. The real installer is never executed.
//
// Usage: REFRACT_883_EXE=<copied debug exe> node scripts/verify-883-updates.mjs
// (build: `pnpm exec tauri build --debug --no-bundle`, copy refract-tauri.exe out first).

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  sha256OfFile,
  citeScreenshots,
  safeRmSync,
  clearKnownOutputFiles
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-883';
const SHOTS_DIR = process.env.REFRACT_883_SHOTS_DIR || path.join(tmpdir(), 'refract-883-shots');
const EXE = process.env.REFRACT_883_EXE;
const CURRENT_VERSION = process.env.REFRACT_883_CURRENT || '0.8.0';
const NEWER_VERSION = '9.9.9';
const INTERVAL_SECS = '4';
const SHOT_NAMES = ['a1-launch-no-prompt.png', 'a2-update-failed.png', 'a3-failed-popover.png', 'b1-ready-row-and-badge.png', 'b2-confirm-dialog.png'];

const report = [];
function check(ok, label, extra) {
  report.push({ step: label, ok, ...(extra ? { extra } : {}) });
  if (!ok) throw new Error(`FAIL: ${label}${extra ? ` (${JSON.stringify(extra)})` : ''}`);
  console.log(`${LOG}: PASS ${label}`);
}

function buildGhShim(dir) {
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'gh.exe');
  const result = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-883-gh-shim.rs'), '-o', out], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) throw new Error(`rustc gh shim failed:\n${result.stderr}`);
}

function callLines(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : [];
}
const countCalls = (file, prefix) => callLines(file).filter((line) => line.startsWith(prefix)).length;

async function bootToSession(cdp, repoDir) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness green (fake omp)' }
  );
  await cdp.click(`document.querySelector('[data-readiness-primary]')`);
  await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
  await cdp.click(`document.querySelector('[role="dialog"] input')`);
  await cdp.send('Input.insertText', { text: repoDir });
  await cdp.clickByText('Add repository', { inDialog: true });
  await cdp.waitFor(
    `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
    { timeoutMs: 30_000, label: 'Scratch repository added' }
  );
}

async function createSession(cdp) {
  await cdp.clickByLabel('New session from a branch in ', { prefix: true });
  await cdp.waitFor(
    `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
    { timeoutMs: 15_000, label: 'New session dialog open' }
  );
  await cdp.clickByText('Create session', { inDialog: true });
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
  await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
    timeoutMs: 60_000,
    label: 'Session composer enabled'
  });
}

const footerBadgeText = (cdp) =>
  cdp.evaluate(`(() => { const b = document.querySelector('footer button'); return b ? (b.textContent ?? '').trim() : null; })()`);
const readyRowText = (cdp) =>
  cdp.evaluate(`(() => { const span = Array.from(document.querySelectorAll('span')).find((el) => /^Refract \\S+ is ready$/.test((el.textContent ?? '').trim())); return span ? span.textContent.trim() : null; })()`);

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function launch({ launcherExe, exeCopy, dataDir, shimDir, extraEnv, importSourceDir, repoDir }) {
  const port = await getFreePort();
  const launched = await launchBuiltExe(launcherExe, exeCopy, {
    port,
    dataDir,
    pathPrepend: shimDir,
    logFile: path.join(path.dirname(exeCopy), `app-${port}.log`),
    extraEnv: {
      REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      REFRACT_883_CURRENT: CURRENT_VERSION,
      REFRACT_883_NEWER: NEWER_VERSION,
      ...extraEnv
    }
  });
  const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
  const cdp = await CdpSession.connect(wsUrl);
  if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`${LOG}: CDP target on ${port} is not the process this run launched`);
  await bootToSession(cdp, repoDir);
  return { cdp, child: launched.child, targetPid: launched.targetPid };
}

async function runA(ctx) {
  const callLog = path.join(ctx.workDir, 'gh-calls-a.log');
  const flagFile = path.join(ctx.workDir, 'newer-release.flag');
  const assetDir = path.join(ctx.workDir, 'fake-assets');
  mkdirSync(assetDir, { recursive: true });
  const installerBytes = Buffer.from('not a real installer: verify-883 stub');
  writeFileSync(path.join(assetDir, `Refract-Setup-${NEWER_VERSION}.exe`), installerBytes);
  writeFileSync(path.join(assetDir, `Refract-Setup-${NEWER_VERSION}.exe.sha256`), `${createHash('sha256').update(installerBytes).digest('hex')}\n`);

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-883-a-data-'));
  const { cdp, child } = await launch({
    ...ctx,
    dataDir,
    extraEnv: {
      REFRACT_UPDATE_CHECK_INTERVAL_SECS: INTERVAL_SECS,
      REFRACT_883_CALL_LOG: callLog,
      REFRACT_883_FLAG_FILE: flagFile,
      REFRACT_883_ASSET_DIR: assetDir
    }
  });
  try {
    // (a) no prompt at launch, and the periodic tick really runs while nothing is newer.
    await cdp.waitFor(`!!document.querySelector('footer')`, { timeoutMs: 15_000, label: 'footer mounted' });
    const launchChecks = countCalls(callLog, 'release list');
    check(launchChecks >= 1, '(a) the launch check ran `gh release list` against the stub', { launchChecks });
    await sleep(Number(INTERVAL_SECS) * 1000 * 2 + 1500);
    const periodicChecks = countCalls(callLog, 'release list');
    check(periodicChecks > launchChecks, '(a) a periodic check re-ran `gh release list` with no click and nothing newer', { launchChecks, periodicChecks });
    check((await footerBadgeText(cdp)) === null, '(a) no footer update badge while only the current version is listed');
    check((await readyRowText(cdp)) === null, '(a) no sidebar "ready" row while only the current version is listed');
    check(countCalls(callLog, 'release download') === 0, '(a) nothing was downloaded');
    await cdp.screenshot(path.join(SHOTS_DIR, 'a1-launch-no-prompt.png'));

    // (b)(c) flip the stub; no clicks from here on.
    writeFileSync(flagFile, 'newer');
    await cdp.waitFor(`(() => { const b = document.querySelector('footer button'); return !!b && /Downloading update|Update failed|Update ready/.test(b.textContent ?? ''); })()`, {
      timeoutMs: 60_000,
      label: 'footer badge appears after the periodic check finds the newer release'
    });
    check(true, '(b) the periodic check detected the newer release with no clicks (badge appeared)');
    await cdp.waitFor(`(() => { const b = document.querySelector('footer button'); return !!b && /Update failed|Update ready/.test(b.textContent ?? ''); })()`, {
      timeoutMs: 60_000,
      label: 'download attempt finished'
    });
    check(countCalls(callLog, 'release view v' + NEWER_VERSION) >= 1, '(c) the app looked up the release assets by itself');
    check(countCalls(callLog, 'release download v' + NEWER_VERSION) === 1, '(c) the download ran automatically, exactly once', {
      downloads: countCalls(callLog, 'release download')
    });

    // (d-failure) the fake asset has no valid Authenticode signature: verification must refuse it.
    check((await footerBadgeText(cdp)) === 'Update failed', '(d) the signature check refused the stub installer and the failure surfaced as "Update failed"', {
      badge: await footerBadgeText(cdp)
    });
    check((await readyRowText(cdp)) === null, '(d) a failed verification never shows the "ready" row');
    await cdp.screenshot(path.join(SHOTS_DIR, 'a2-update-failed.png'));
    await cdp.click(`document.querySelector('footer button')`);
    await cdp.waitFor(`!!document.querySelector('[data-radix-popper-content-wrapper]')`, { timeoutMs: 10_000, label: 'badge popover open' });
    const popover = await cdp.evaluate(`document.querySelector('[data-radix-popper-content-wrapper]').textContent`);
    check(/Update failed/.test(popover) && !/Update now/.test(popover), '(d) the failed popover explains the failure and offers no "Update now"', { popover });
    await cdp.screenshot(path.join(SHOTS_DIR, 'a3-failed-popover.png'));
    const tickCount = countCalls(callLog, 'release list');
    await sleep(Number(INTERVAL_SECS) * 1000 + 1500);
    check(countCalls(callLog, 'release download') === 1, '(c) later ticks did not re-download', { before: tickCount, after: countCalls(callLog, 'release list') });
  } finally {
    cdp.close();
    await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir, LOG);
  }
}

async function runB(ctx) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-883-b-data-'));
  const updatesDir = path.join(dataDir, 'updates');
  mkdirSync(updatesDir, { recursive: true });
  const installerPath = path.join(updatesDir, `Refract-Setup-${NEWER_VERSION}.exe`);
  writeFileSync(installerPath, 'not a real installer: verify-883 stub');
  writeFileSync(`${installerPath}.sha256`, `${createHash('sha256').update(readFileSync(installerPath)).digest('hex')}\n`);
  writeFileSync(
    path.join(dataDir, 'updateState.json'),
    JSON.stringify({ version: 1, phase: 'downloaded', availableVersion: NEWER_VERSION, installerPath, notesUrl: `https://github.com/stuarthopwood/refract/releases/tag/v${NEWER_VERSION}` })
  );
  const { cdp, child, targetPid } = await launch({
    ...ctx,
    dataDir,
    extraEnv: {
      REFRACT_UPDATE_CHECK_INTERVAL_SECS: '3600',
      REFRACT_883_CALL_LOG: path.join(ctx.workDir, 'gh-calls-b.log'),
      REFRACT_883_FLAG_FILE: path.join(ctx.workDir, 'never.flag'),
      REFRACT_883_ASSET_DIR: path.join(ctx.workDir, 'fake-assets'),
      REFRACT_FAKE_OMP_SCENARIO: 'stop-911'
    }
  });
  try {
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('span')).find((el) => /^Refract \\S+ is ready$/.test((el.textContent ?? '').trim()))`, {
      timeoutMs: 30_000,
      label: 'sidebar ready row'
    });
    check((await readyRowText(cdp)) === `Refract ${NEWER_VERSION} is ready`, '(d) the sidebar row reads "Refract 9.9.9 is ready"');
    const action = await cdp.evaluate(`(() => { const b = document.querySelector('[aria-label="Restart and install the update now"]'); return b ? b.textContent.trim() : null; })()`);
    check(action === 'Update now', '(d) the row carries an "Update now" action', { action });
    check((await footerBadgeText(cdp)) === 'Update ready', '(d) the footer badge reads "Update ready"', { badge: await footerBadgeText(cdp) });
    await createSession(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, 'b1-ready-row-and-badge.png'));

    // (e) leave one agent mid-turn (fake omp holds the turn until aborted).
    await cdp.typeIntoByLabel('Message', 'keep working for the update check');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`(() => { const b = document.querySelector('[aria-label="Stop"]'); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, {
      timeoutMs: 20_000,
      label: 'agent mid-turn (Stop button enabled)'
    });
    await cdp.clickByLabel('Restart and install the update now');
    await cdp.waitFor(`!!document.querySelector('[role="alertdialog"]')`, { timeoutMs: 10_000, label: 'confirm dialog opened' });
    const dialogText = await cdp.evaluate(`document.querySelector('[role="alertdialog"]').textContent`);
    check(dialogText.includes('1 agent is running; restarting stops it.'), '(e) the confirm dialog names the running-agent count', { dialogText });
    check(dialogText.includes('Cancel') && dialogText.includes('Restart and update'), '(e) the dialog offers Cancel and "Restart and update"');
    await cdp.screenshot(path.join(SHOTS_DIR, 'b2-confirm-dialog.png'));
    await cdp.click(`Array.from(document.querySelectorAll('[role="alertdialog"] button')).find((b) => b.textContent.trim() === 'Cancel')`);
    await cdp.waitFor(`!document.querySelector('[role="alertdialog"]')`, { timeoutMs: 10_000, label: 'dialog closed on Cancel' });
    await sleep(1500);
    check(processAlive(targetPid), '(e) Cancel leaves the app running');
    check((await readyRowText(cdp)) !== null, '(e) Cancel keeps the "ready" row');

    // Restart and update: the app quits; the quit hook's signature re-check refuses the stub.
    await cdp.clickByLabel('Restart and install the update now');
    await cdp.waitFor(`!!document.querySelector('[role="alertdialog"]')`, { timeoutMs: 10_000, label: 'confirm dialog reopened' });
    await cdp.click(`Array.from(document.querySelectorAll('[role="alertdialog"] button')).find((b) => b.textContent.trim() === 'Restart and update')`);
    const deadline = Date.now() + 45_000;
    while (processAlive(targetPid) && Date.now() < deadline) await sleep(500);
    check(!processAlive(targetPid), '(e) "Restart and update" quit the app', { targetPid });
  } finally {
    cdp.close();
    await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir, LOG);
  }
}

async function main() {
  if (!EXE || !existsSync(EXE)) throw new Error(`${LOG}: set REFRACT_883_EXE to the copied debug exe`);
  const exeHash = sha256OfFile(EXE);
  const head = gitHead(REPO_ROOT);
  console.log(`${LOG}: git HEAD ${head}; exe ${EXE} sha256 ${exeHash}`);
  clearKnownOutputFiles(SHOTS_DIR, 'refract-883-shots', [...SHOT_NAMES, 'report.json']);

  const workDir = mkdtempSync(path.join(tmpdir(), 'refract-883-work-'));
  const shimDir = path.join(workDir, 'shims');
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-883-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-883-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-883-updates');
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-883-launcher-'));
  try {
    buildOmpShim(shimDir);
    buildGhShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const ctx = { launcherExe, exeCopy: EXE, shimDir, importSourceDir, repoDir, workDir };
    await runA(ctx);
    await runB(ctx);
    check(sha256OfFile(EXE) === exeHash, 'the exe hash is unchanged after both runs');
    report.push({ step: 'screenshots', ok: true, screenshots: citeScreenshots(SHOTS_DIR, SHOT_NAMES) });
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    process.exitCode = 1;
    console.error(err);
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, exeSha256: exeHash, results: report }, null, 2));
    await safeRmSync(workDir, LOG);
    await safeRmSync(importSourceDir, LOG);
    await safeRmSync(repoDirBase, LOG);
    await safeRmSync(launcherDir, LOG);
  }
  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main();
