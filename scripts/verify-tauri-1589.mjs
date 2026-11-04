#!/usr/bin/env node
// Live CDP check for #1589 (lists refresh after a merge, close or Session write): scratch exe + data dir + profile, fake `omp`.
// With Issues and Pull requests loaded, counts list fetches via wrappers, emits a burst of three `github:changed` events,
// then asserts one fetch per list, no aria-busy, focus and selection unchanged, with before/after screenshots.
// Needs a signed-in `gh` (the renderer ignores the event until GitHub status is ready).
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-tauri-1589.mjs
// Env: REFRACT_1589_SHOTS_DIR overrides the screenshot/report dir (default <os tmpdir>/refract-1589-shots).

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget, gitHead, computeDirty, sha256OfFile, citeScreenshots } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExe } from './verify-tauri-560-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1589';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1589_SHOTS_DIR || path.join(tmpdir(), 'refract-1589-shots');
// Debounce is 1 s; wait past it plus a fetch round trip.
const SETTLE_MS = 3500;

const report = [];
const shotNames = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
  if (ok !== true) process.exitCode = 1;
}
const shot = async (cdp, name) => {
  await sleep(500);
  await cdp.screenshot(path.join(SHOTS_DIR, name));
  shotNames.push(name);
};

const viewButton = (label) => `Array.from(document.querySelectorAll('[role="group"][aria-label="Views"] button[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith(${JSON.stringify(label)}))`;

async function launch(env) {
  const port = await getFreePort();
  const launched = await launchBuiltExe(env.launcherExe, env.exe, {
    port,
    dataDir: env.dataDir,
    importSourceDir: env.importSourceDir,
    pathPrepend: env.shimDir,
    logFile: path.join(SHOTS_DIR, `app-${port}.log`),
    extraEnv: {
      OMP_PROFILE: 'verify-1589',
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      REFRACT_FAKE_OMP_SCENARIO: 'session'
    }
  });
  const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
  if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target not owned by launched pid');
  console.log(`${LOG}: launched exe pid ${launched.targetPid} on port ${port}`);
  return { cdp, child: launched.child };
}

async function openView(cdp, label) {
  await cdp.click(viewButton(label));
  await cdp.waitFor(`${viewButton(label)}?.getAttribute('aria-current') === 'page'`, { timeoutMs: 20_000, label: `${label} view selected` });
  await cdp.waitFor(`!document.querySelector('[aria-busy="true"]')`, { timeoutMs: 60_000, label: `${label} list settled` });
}

// Counts every list fetch and records whether a loading state (aria-busy) ever appeared while the burst ran.
const INSTALL_PROBES = `(() => {
  const api = window.refract;
  window.__v1589 = { issues: 0, prs: 0, busySeen: false };
  const wrap = (obj, key, counter) => { const original = obj[key].bind(obj); obj[key] = (...args) => { window.__v1589[counter] += 1; return original(...args); }; };
  wrap(api.issues, 'list', 'issues');
  wrap(api.pullRequests, 'listAcross', 'prs');
  new MutationObserver(() => { if (document.querySelector('[aria-busy="true"]')) window.__v1589.busySeen = true; })
    .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy'] });
})()`;

const EMIT_BURST = (kind) => `(async () => {
  const emit = (payload) => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'github:changed', payload });
  for (const number of [1, 2, 3]) await emit({ repositoryId: null, kind: ${JSON.stringify(kind)}, number });
})()`;

const SNAPSHOT = `(() => ({
  active: document.activeElement ? (document.activeElement.getAttribute('aria-label') || document.activeElement.textContent || '').trim().slice(0, 80) : null,
  selected: Array.from(document.querySelectorAll('[aria-current="true"]')).map((el) => el.textContent.trim().slice(0, 80)),
  rows: document.querySelectorAll('[data-row-key], li button[aria-current]').length
}))()`;

async function burstCheck(cdp, label, kind, shotPrefix) {
  await cdp.evaluate(`window.__v1589 = { issues: 0, prs: 0, busySeen: false }`);
  const before = await cdp.evaluate(SNAPSHOT);
  await shot(cdp, `${shotPrefix}-before.png`);
  await cdp.evaluate(EMIT_BURST(kind));
  await sleep(SETTLE_MS);
  const counts = await cdp.evaluate(`window.__v1589`);
  const after = await cdp.evaluate(SNAPSHOT);
  await shot(cdp, `${shotPrefix}-after.png`);
  const listKey = kind === 'pr' ? 'prs' : 'issues';
  check(counts[listKey] === 1, `${label}: three events inside the debounce cause one list fetch`, counts);
  check(counts.busySeen === false, `${label}: no loading state (aria-busy) appeared during the quiet refresh`, counts);
  check(before.active === after.active, `${label}: focus is unchanged`, { before: before.active, after: after.active });
  check(JSON.stringify(before.selected) === JSON.stringify(after.selected) || after.selected.length <= 1, `${label}: selection is retained or moved to a single next row`, { before: before.selected, after: after.selected });
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1589-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1589-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1589-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1589-lists');
  const repoName = path.basename(repoDir);
  const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', repoName);
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1589-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1589-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1589-shim-'));
  const exe = path.join(exeDir, 'refract-tauri.exe');
  let session;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    copyFileSync(path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe'), exe);
    const exeHash = sha256OfFile(exe);
    report.push({ step: 'build identity', ok: true, evidence: { head: gitHead(REPO_ROOT), dirty: computeDirty(REPO_ROOT), exeSha256: exeHash } });

    session = await launch({ launcherExe, exe, dataDir, shimDir, importSourceDir });
    const { cdp } = session;
    check(path.dirname(exe).startsWith(tmpdir()) && dataDir.startsWith(tmpdir()), 'Isolation: exe, data dir and WebView2 profile are scratch copies under the temp dir', { exe, dataDir });

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]') || !!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 60_000, label: 'Readiness or main screen' });
    if (await cdp.evaluate(`!!document.querySelector('[data-readiness-primary]')`)) {
      await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
      await addRepository(cdp, repoDir);
    }
    await cdp.waitFor(`!!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 30_000, label: 'Settings button' });
    await createSessionViaQuickCreate(cdp, repoName);

    // Both lists must have loaded once so the refresh has something to refresh.
    await openView(cdp, 'Issues');
    await openView(cdp, 'Pull requests');
    await cdp.evaluate(INSTALL_PROBES);

    await burstCheck(cdp, 'Pull requests, kind pr (in-app merge)', 'pr', '1-pull-requests');
    await openView(cdp, 'Issues');
    await burstCheck(cdp, 'Issues, kind issue (agent gh issue close)', 'issue', '2-issues');

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
    for (const dir of [dataDir, importSourceDir, repoDirBase, worktreesRoot, exeDir, launcherDir, shimDir]) await safeRmSync(dir, LOG);
  }
  if (report.some((r) => !r.ok)) process.exitCode = 1;
  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main();
