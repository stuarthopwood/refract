#!/usr/bin/env node
// Live CDP check for #687: the current-work banner above the composer, driven by the
// `current-work-687` fake-omp tape. Asserts the banner marker first so a missing banner fails loudly.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  citeScreenshots,
  safeRmSync,
  requireSharedCargoTarget,
  clearKnownOutputFiles
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { TODO_PILL_SELECTOR, PANEL_SELECTOR, clickTodoPill } from './verify-700-todo-pin-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-687';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_687_SHOTS_DIR || path.join(tmpdir(), 'refract-687-banner-shots');
const SHOT_NAMES = ['intent.png', 'retrying.png', 'compacting.png', 'todo.png', 'pinned.png', 'needs-you.png', 'idle.png'];

const BANNER = `document.querySelector('[data-testid="current-work-banner"]')`;
const BANNER_TEXT = `(document.querySelector('[data-testid="current-work-banner-text"]')?.textContent ?? null)`;

const report = [];
function assertTrue(actual, label, extra) {
  const ok = actual === true;
  report.push({ step: label, ok, actual, ...(extra ? { extra } : {}) });
  if (!ok) throw new Error(`FAIL: ${label} (actual ${JSON.stringify(actual)})`);
  console.log(`${LOG}: PASS ${label}`);
}

/** Waits for the banner to exist AND its text to match, so a missing banner never passes. */
async function expectBanner(cdp, regex, label, timeoutMs = 20_000) {
  await cdp.waitFor(`(() => { const t = ${BANNER_TEXT}; return !!(${BANNER}) && t !== null && new RegExp(${JSON.stringify(regex.source)}).test(t); })()`, { timeoutMs, label });
  const text = await cdp.evaluate(BANNER_TEXT);
  assertTrue(regex.test(text), `${label} (text: ${JSON.stringify(text)})`);
  return text;
}

async function shot(cdp, name) {
  await sleep(250);
  await cdp.screenshot(path.join(SHOTS_DIR, name));
}

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirtyLines = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).stdout.split('\n').filter(Boolean);
  console.log(`${LOG}: git HEAD ${head}${dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
  clearKnownOutputFiles(SHOTS_DIR, 'refract-687-banner-shots', [...SHOT_NAMES, 'report.json']);
  mkdirSync(SHOTS_DIR, { recursive: true });

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-687-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-687-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-687-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-687-banner');
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-687-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-687-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-687-shim-'));

  let child;
  let cdp;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    console.log(`${LOG}: exe sha256 ${exeInfo.hash}`);
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log'),
        REFRACT_FAKE_OMP_SCENARIO: 'current-work-687'
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) {
      throw new Error(`${LOG}: CDP target on port ${port} is not owned by the process this run launched (pid ${launched.targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green (fake omp)' });
    await cdp.openLocalFolderDialog();
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`, { timeoutMs: 30_000, label: 'Scratch repository added' });
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'New session dialog open' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Session composer enabled' });

    // Idle: no banner before the turn starts.
    assertTrue((await cdp.evaluate(`!(${BANNER})`)) === true, 'Idle Session shows no banner');

    await cdp.typeIntoByLabel('Message', 'do the work');
    await cdp.clickByLabel('Send message');

    const intentText = await expectBanner(cdp, /Reading ChatPane\.tsx/, 'Banner shows the latest intent');
    const full = await cdp.evaluate(`${BANNER}.textContent`);
    assertTrue(/^\s*Reading ChatPane\.tsx/.test(full), 'Banner has no elapsed turn time prefix (#1250)', { full });
    assertTrue(await cdp.evaluate(`(() => { const b = ${BANNER}; return b.getAttribute('aria-live') === 'off' && !b.querySelector('[role="progressbar"], button'); })()`), 'Banner is aria-live off with no progressbar or control');
    const height = await cdp.evaluate(`${BANNER}.getBoundingClientRect().height`);
    assertTrue(height >= 20 && height <= 28, 'Banner is one ~24px line', { height });
    await shot(cdp, 'intent.png');

    await expectBanner(cdp, /Running a command/, 'A call with no intent falls back to a plain verb, never the raw tool name');
    assertTrue(!/bash/i.test(await cdp.evaluate(BANNER_TEXT)), 'The raw tool name "bash" is never shown');

    // RetryLine owns the retry text; the banner deliberately never shows it.
    await cdp.waitFor(`/Retrying\\s*Attempt 2 of 3/.test(document.querySelector('[data-testid="retry-line"]')?.textContent ?? '')`, { timeoutMs: 20_000, label: 'Retry line shows attempt 2 of 3' });
    assertTrue(!/Retrying/.test((await cdp.evaluate(BANNER_TEXT)) ?? ''), 'The banner leaves the retry text to the Retry line');
    console.log(`${LOG}: PASS Retry line shows attempt 2 of 3`);
    await shot(cdp, 'retrying.png');
    await expectBanner(cdp, /Compacting context…/, 'Banner shows the compaction variant');
    await shot(cdp, 'compacting.png');

    const todoText = await expectBanner(cdp, /Task 1 of 2 · Wire the banner/, 'Banner shows the current todo task "n of m"');
    assertTrue(!/Planning the work/.test(todoText), 'The todo line outranks the intent');
    await shot(cdp, 'todo.png');

    // Pinned: the todo line drops; the intent line stays.
    await cdp.waitFor(`!!(${TODO_PILL_SELECTOR})`, { timeoutMs: 10_000, label: 'Todo pill present' });
    await clickTodoPill(cdp);
    await cdp.waitFor(`!!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Todo panel pinned' });
    await expectBanner(cdp, /Planning the work/, 'With the todo panel pinned the todo line drops and the intent shows');
    assertTrue(!/Task 1 of 2/.test(await cdp.evaluate(BANNER_TEXT)), 'Pinned: the todo line is gone');
    await shot(cdp, 'pinned.png');
    await clickTodoPill(cdp);
    await cdp.waitFor(`!(${PANEL_SELECTOR})`, { timeoutMs: 5_000, label: 'Todo panel unpinned' });
    await expectBanner(cdp, /Task 1 of 2 · Wire the banner/, 'Unpinned: the todo line returns');

    // Setting off hides it, on restores it.
    assertTrue((await cdp.evaluate(`window.refract.settings.setReadoutVisibility('current-work', false).then((r) => r.ok)`)) === true, 'Turned the current-work readout off');
    await cdp.waitFor(`!(${BANNER})`, { timeoutMs: 5_000, label: 'Banner hides when the Setting is off' });
    assertTrue((await cdp.evaluate(`window.refract.settings.setReadoutVisibility('current-work', true).then((r) => r.ok)`)) === true, 'Turned the current-work readout back on');
    await expectBanner(cdp, /\S/, 'Banner returns when the Setting is back on');

    // Needs you: the scripted question is pending.
    await expectBanner(cdp, /Needs your input/, 'Banner shows "needs you" while a question is pending', 30_000);
    await shot(cdp, 'needs-you.png');
    await cdp.waitFor(`!!document.querySelector('[role="radio"]')`, { timeoutMs: 10_000, label: 'Question card is open' });
    await cdp.click(`Array.from(document.querySelectorAll('[role="radio"]')).find((el) => (el.textContent ?? '').includes('Postgres'))`);
    await cdp.clickByText('Submit');

    // Idle again: hidden.
    await cdp.waitFor(`!(${BANNER})`, { timeoutMs: 20_000, label: 'Banner hides once the turn settles' });
    await shot(cdp, 'idle.png');

    report.push({ step: 'screenshots', ok: true, screenshots: citeScreenshots(SHOTS_DIR, SHOT_NAMES) });
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    throw err;
  } finally {
    try {
      const failures = report.filter((r) => r.ok === false).map((r) => r.step);
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, dirty: dirtyLines.length > 0, failures, results: report }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write report.json: ${writeErr}`);
    }
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir, LOG);
    await safeRmSync(importSourceDir, LOG);
    await safeRmSync(repoDirBase, LOG);
    await safeRmSync(worktreesRootForCleanup, LOG);
    await safeRmSync(exeDir, LOG);
    await safeRmSync(launcherDir, LOG);
    await safeRmSync(shimDir, LOG);
  }

  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
