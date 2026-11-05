#!/usr/bin/env node
// Live CDP check for #1647: in a transcript pane and the Appearance preview the plain watermark is the inline-SVG
// BrandMark (facets fill with --watermark-tone-*, opacity = --watermark-opacity) and in season the holiday glyph
// shows instead. Drives a REAL built Tauri debug exe against the FAKE `omp` shim; scratch REFRACT_DATA_DIR.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_1647_SHOTS_DIR=<dir> node scripts/verify-tauri-1647.mjs

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, switchTheme } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1647';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1647_SHOTS_DIR || path.join(tmpdir(), 'lane1647', 'shots');
const BASE_PORT = 9247;
const THEMES = [{ id: 'dark', name: 'Dark' }, { id: 'light', name: 'Light' }];
const SCENARIOS = [
  { id: 'plain', date: '2026-06-15' },
  { id: 'holiday', date: '2026-10-27' }
];

// Resolves a CSS value through a probe element so the token and the painted fill serialise the same way.
const RESOLVE = `(value) => { const p = document.createElement('div'); p.style.color = value; document.body.appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c; }`;
const PLAIN_PROBE = (live) => `(() => {
  const resolve = ${RESOLVE};
  const marks = Array.from(document.querySelectorAll(${JSON.stringify(live ? '.watermark-mark--live' : '.watermark-mark:not(.watermark-mark--live)')}));
  const mark = marks[0];
  if (!mark) return { count: marks.length };
  const svg = mark.querySelector('svg');
  const paths = svg ? Array.from(svg.querySelectorAll('path')) : [];
  const facets = paths.map((p) => {
    const m = /var\\((--watermark-tone-[0-9a-f]+)\\)/.exec(p.getAttribute('style') || '');
    return { token: m ? m[1] : null, fill: getComputedStyle(p).fill, expected: m ? resolve('var(' + m[1] + ')') : null };
  });
  return {
    count: marks.length,
    holidayCount: document.querySelectorAll('.watermark-mark-holiday').length,
    emptyState: !!document.querySelector('[data-chat-empty-state]'),
    hasSvg: !!svg,
    opacity: Number(getComputedStyle(mark).opacity),
    token: Number(getComputedStyle(mark).getPropertyValue('--watermark-opacity')),
    facetCount: facets.length,
    mismatched: facets.filter((f) => !f.token || f.fill !== f.expected).length,
    distinctFills: new Set(facets.map((f) => f.fill)).size,
    sample: facets.slice(0, 2)
  };
})()`;
const HOLIDAY_PROBE = (live) => `(() => {
  const marks = Array.from(document.querySelectorAll(${JSON.stringify(live ? '.watermark-mark-holiday.watermark-mark--live' : '.watermark-mark-holiday:not(.watermark-mark--live)')}));
  const mark = marks[0];
  const svg = mark && mark.querySelector('svg');
  if (!svg) return { count: marks.length, hasSvg: false };
  return {
    count: marks.length,
    plainCount: document.querySelectorAll('.watermark-mark').length,
    emptyState: !!document.querySelector('[data-chat-empty-state]'),
    hasSvg: true,
    opacity: Number(getComputedStyle(svg).opacity),
    token: Number(getComputedStyle(svg).getPropertyValue('--holiday-artwork-opacity'))
  };
})()`;
const near = (a, b) => Math.abs(a - b) < 0.005;

async function openAppearance(cdp) {
  if (!(await cdp.evaluate(`!!document.querySelector('[aria-label="Back to chat"]')`))) await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Appearance')`);
  await cdp.waitFor(`!!document.getElementById('watermark-toggle')`, { timeoutMs: 10_000, label: 'Appearance mounted' });
  await cdp.evaluate(`document.getElementById('watermark-toggle').scrollIntoView({ block: 'center' })`);
  await sleep(400);
}
async function backToChat(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 10_000, label: 'Back in chat' });
  await sleep(400);
}

async function runScenario(scenario, index, exePath, launcherExe, shimDir, report, check) {
  const tag = `${LOG}-${scenario.id}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), `refract-1647-${scenario.id}-data-`));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), `refract-1647-${scenario.id}-import-`));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), `refract-1647-${scenario.id}-repo-`));
  const repoDir = makeScratchRepo(repoDirBase, `verify-1647-${scenario.id}`);
  const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  let child;
  let cdp;
  try {
    const launched = await launchBuiltExe(launcherExe, exePath, {
      port: BASE_PORT + index,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(shimDir, `app-${scenario.id}.log`),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'session',
        REFRACT_DATE_OVERRIDE: scenario.date
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(BASE_PORT + index, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(BASE_PORT + index, launched.targetPid)) throw new Error(`${tag}: CDP target not owned by launched pid`);

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await cdp.openLocalFolderDialog();
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`, { timeoutMs: 30_000, label: 'Scratch repository added' });
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'New session dialog' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 90_000, label: 'dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Composer enabled' });
    await sleep(1500);

    for (const theme of THEMES) {
      if (theme.id !== 'dark') await switchTheme(cdp, theme.id, theme.name);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 400 });
      await sleep(600);
      const label = `${scenario.id}/${theme.name}`;
      if (scenario.id === 'plain') {
        const live = await cdp.evaluate(PLAIN_PROBE(true));
        check(live.count === 1 && live.holidayCount === 0 && live.emptyState === false, `${label}: transcript pane shows exactly one plain mark, no holiday glyph`, live);
        check(live.hasSvg && live.facetCount > 1 && live.mismatched === 0 && live.distinctFills > 1, `${label}: transcript mark is the inline-SVG BrandMark, facets fill with their --watermark-tone-*`, live);
        check(near(live.opacity, live.token) && live.token > 0, `${label}: transcript mark opacity equals --watermark-opacity`, { opacity: live.opacity, token: live.token });
      } else {
        const live = await cdp.evaluate(HOLIDAY_PROBE(true));
        check(live.count === 1 && live.hasSvg && live.plainCount === 0 && live.emptyState === false, `${label}: transcript pane shows the holiday glyph, not the plain mark`, live);
        check(near(live.opacity, live.token) && live.token > 0, `${label}: holiday glyph opacity equals --holiday-artwork-opacity`, { opacity: live.opacity, token: live.token });
      }
      await cdp.screenshot(path.join(SHOTS_DIR, `1647-${scenario.id}-transcript-${theme.id}.png`));

      await openAppearance(cdp);
      if (scenario.id === 'plain') {
        const prev = await cdp.evaluate(PLAIN_PROBE(false));
        check(prev.count === 1 && prev.holidayCount === 0 && prev.hasSvg && prev.facetCount > 1 && prev.mismatched === 0, `${label}: Appearance preview is the BrandMark with tone fills`, prev);
        check(near(prev.opacity, prev.token) && prev.token > 0, `${label}: preview opacity equals --watermark-opacity`, { opacity: prev.opacity, token: prev.token });
      } else {
        const prev = await cdp.evaluate(HOLIDAY_PROBE(false));
        check(prev.count === 1 && prev.hasSvg && prev.plainCount === 0, `${label}: Appearance preview shows the holiday glyph`, prev);
        check(near(prev.opacity, prev.token) && prev.token > 0, `${label}: preview glyph opacity equals --holiday-artwork-opacity`, { opacity: prev.opacity, token: prev.token });
      }
      await cdp.screenshot(path.join(SHOTS_DIR, `1647-${scenario.id}-preview-${theme.id}.png`));
      await backToChat(cdp);
    }
  } catch (err) {
    report.push({ step: `${tag} crashed`, ok: false, error: String(err && err.stack ? err.stack : err) });
    try { if (cdp) await cdp.screenshot(path.join(SHOTS_DIR, `1647-${scenario.id}-crash.png`)); } catch { /* best effort */ }
    throw err;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    for (const d of [dataDir, importSourceDir, repoDirBase, worktreesRoot]) await safeRmSync(d, LOG);
  }
}

async function main() {
  console.log(`${LOG}: git HEAD ${gitHead(REPO_ROOT)}`);
  mkdirSync(SHOTS_DIR, { recursive: true });
  const report = [];
  const check = (ok, label, extra) => {
    report.push({ step: label, ok, ...(extra !== undefined ? { extra } : {}) });
    console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` ${JSON.stringify(extra ?? '')}`}`);
  };
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1647-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1647-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1647-shim-'));
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    for (const [i, scenario] of SCENARIOS.entries()) await runScenario(scenario, i, exeInfo.dest, launcherExe, shimDir, report, check);
  } finally {
    try { writeFileSync(path.join(SHOTS_DIR, '1647-report.json'), JSON.stringify(report, null, 2)); } catch { /* best effort */ }
    for (const d of [exeDir, launcherDir, shimDir]) await safeRmSync(d, LOG);
  }
  const failed = report.filter((r) => r.ok === false);
  console.log(`${LOG}: ${report.length - failed.length}/${report.length} steps passed; shots in ${SHOTS_DIR}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`${LOG}: FAILED`, err);
  process.exit(1);
});
