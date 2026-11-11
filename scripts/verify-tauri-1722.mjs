#!/usr/bin/env node
// Live check for #1722: persistent error toasts stay until dismissed, carry the right text, dedupe, and are announced once, assertively.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1722';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const MSG = 'Scratch quick-create failure 1722';

const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1722-data-'));
const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1722-import-'));
const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1722-repo-'));
const repoDir = makeScratchRepo(repoDirBase, 'verify-1722');
const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1722-exe-'));
const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1722-launcher-'));
const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1722-shim-'));
const results = [];
const shotsDir = path.join(tmpdir(), 'verify-1722-shots');
mkdirSync(shotsDir, { recursive: true });
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${detail === undefined ? '' : JSON.stringify(detail)}`);
  if (!ok) throw new Error(`FAIL ${label}`);
}

let child, cdp;
try {
  buildOmpShim(shimDir);
  const launcherExe = buildLauncher(launcherDir);
  const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
  const port = await getFreePort();
  const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
    port,
    dataDir,
    pathPrepend: shimDir,
    logFile: path.join(exeDir, 'app.log'),
    extraEnv: {
      REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath
    }
  });
  child = launched.child;
  cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
  if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target not owned by launched pid');

  await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 90_000, label: 'Readiness green' });
  await cdp.openLocalFolderDialog();
  await cdp.click(`document.querySelector('[role="dialog"] input')`);
  await cdp.send('Input.insertText', { text: repoDir });
  await cdp.clickByText('Add project', { inDialog: true });
  await cdp.waitFor(`!!document.querySelector('[data-quick-create-session]')`, { timeoutMs: 30_000, label: 'quick-create button present' });
  await cdp.evaluate(`window.refract.theme.set('dark')`);
  await cdp.waitFor(`document.documentElement.className.includes('theme-dark')`, { timeoutMs: 10_000, label: 'Dark theme' });

  // Force the real quick-create path to fail, and record every write to the assertive region and sonner's region.
  await cdp.evaluate(`(() => {
    window.refract.sessions.create = async () => ({ ok: false, error: { code: 'unknown', message: ${JSON.stringify(MSG)} } });
    window.__alertWrites = []; window.__sonnerWrites = [];
    const watch = (el, sink) => new MutationObserver(() => sink.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    window.__watchRegions = () => {
      const alert = document.querySelector('body > div[role="alert"][aria-live="assertive"]');
      const sonner = document.querySelector('section[aria-live="polite"]');
      if (alert && !alert.__w) { alert.__w = 1; watch(alert, window.__alertWrites); }
      if (sonner && !sonner.__w) { sonner.__w = 1; watch(sonner, window.__sonnerWrites); }
      return { alert: !!alert, sonner: !!sonner };
    };
    new MutationObserver(() => window.__watchRegions()).observe(document.body, { childList: true, subtree: true });
    window.__watchRegions();
    return true;
  })()`);

  for (let i = 0; i < 3; i++) {
    await cdp.click(`document.querySelector('[data-quick-create-session]')`);
    await sleep(700);
  }
  await sleep(800);
  await cdp.screenshot(path.join(shotsDir, '01-quick-create-failure-dark.png'));
  await sleep(8000);
  const stillOpen = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-sonner-toast]')).filter((t) => t.getAttribute('data-removed') !== 'true' && t.textContent.includes(${JSON.stringify(MSG)})).length`);
  check('toast still open 8s later (past sonner default 4s)', stillOpen === 1, stillOpen);

  const state = await cdp.evaluate(`(() => {
    const toasts = Array.from(document.querySelectorAll('[data-sonner-toast]')).filter((t) => t.getAttribute('data-removed') !== 'true' && t.textContent.includes(${JSON.stringify(MSG)}));
    const alert = document.querySelector('body > div[role="alert"][aria-live="assertive"]');
    const nonEmpty = window.__alertWrites.filter((t) => t === ${JSON.stringify(MSG)});
    const sonnerHits = window.__sonnerWrites.filter((t) => t.includes(${JSON.stringify(MSG)}));
    return {
      toastCount: toasts.length,
      closeButtons: toasts.map((t) => t.querySelectorAll('[data-close-button]').length),
      alertText: alert ? alert.textContent : null,
      alertWritesWithText: nonEmpty.length,
      alertWritesAll: window.__alertWrites,
      sonnerWritesWithText: sonnerHits.length,
      sonnerRegionHasText: (document.querySelector('section[aria-live="polite"]')?.textContent ?? '').includes(${JSON.stringify(MSG)}),
      sonnerInsideAlertRegionCount: document.querySelectorAll('[role="alert"]').length
    };
  })()`);
  console.log(`${LOG}: state ${JSON.stringify(state)}`);
  check('exactly one error toast for three failures', state.toastCount === 1, state.toastCount);
  check('toast has a close button', state.closeButtons[0] >= 1, state.closeButtons);
  check('assertive role=alert region holds the message', state.alertText === MSG, state.alertText);
  console.log(`${LOG}: assertive region text writes per failure: ${state.alertWritesWithText} (3 failures)`);
  check('assertive region written once per failure with the text (3 total, none duplicated)', state.alertWritesWithText === 3, state.alertWritesWithText);
  console.log(`${LOG}: DOUBLE ANNOUNCEMENT (sonner polite region also carries the text): ${state.sonnerRegionHasText ? 'YES' : 'NO'} (sonner region mutations containing text: ${state.sonnerWritesWithText})`);

  // Delete failure arrives as a backend event; emit the real one through the Tauri event bus.
  const DEL = 'Scratch delete failure 1722';
  await cdp.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'sessions:delete-failed', payload: { sessionId: 'nope-1722', error: { code: 'unknown', message: ${JSON.stringify(DEL)} } } })`);
  await cdp.waitFor(`Array.from(document.querySelectorAll('[data-sonner-toast]')).some((t) => t.textContent.includes(${JSON.stringify(DEL)}))`, { timeoutMs: 10_000, label: 'delete-failure toast' });
  await sleep(6000);
  const del = await cdp.evaluate(`(() => {
    const t = Array.from(document.querySelectorAll('[data-sonner-toast]')).filter((x) => x.getAttribute('data-removed') !== 'true' && x.textContent.includes(${JSON.stringify(DEL)}));
    const alert = document.querySelector('body > div[role="alert"][aria-live="assertive"]');
    return { count: t.length, text: t[0]?.textContent, close: t[0]?.querySelectorAll('[data-close-button]').length, alert: alert?.textContent };
  })()`);
  console.log(`${LOG}: delete ${JSON.stringify(del)}`);
  await cdp.screenshot(path.join(shotsDir, '02-delete-failure-dark.png'));
  check('delete failure toast persists with message and close button', del.count === 1 && del.text.includes(DEL) && del.text.includes('Could not delete') && del.close >= 1, del);
  check('delete failure announced assertively with title and description', typeof del.alert === 'string' && del.alert.includes('Could not delete') && del.alert.includes(DEL), del.alert);

  // Dismiss via the close button: the toast must go.
  await cdp.click(`Array.from(document.querySelectorAll('[data-sonner-toast]')).find((x) => x.textContent.includes(${JSON.stringify(MSG)})).querySelector('[data-close-button]')`);
  await sleep(1500);
  const gone = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-sonner-toast]')).filter((t) => t.getAttribute('data-removed') !== 'true' && t.textContent.includes(${JSON.stringify(MSG)})).length`);
  check('close button dismisses the toast', gone === 0, gone);
  writeFileSync(path.join(exeDir, 'report.json'), JSON.stringify({ state, results }, null, 2));
} finally {
  if (cdp) cdp.close();
  if (child) await stopLauncher(child).catch(() => {});
  for (const d of [dataDir, importSourceDir, repoDirBase, exeDir, launcherDir, shimDir]) await safeRmSync(d, LOG);
}
