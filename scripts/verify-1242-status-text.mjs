#!/usr/bin/env node
// Live CDP check for issue #1242 (spec 004 FR-039, FR-042): the composer status text is 14px, in
// the accent text colour, raised about 4px, and shimmers only while the Session is working.
// Driven by the same `current-work-687` fake-omp tape as `verify-687-current-work-banner.mjs`.
// Order: working (shimmer on, geometry) -> reduced motion emulated (static) -> Settings switch off
// (static) and back on -> needs you (static, five-theme accent-colour loop and shots).

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep, resolveCssVarColor } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  citeScreenshots,
  safeRmSync,
  requireSharedCargoTarget,
  switchTheme,
  clearKnownOutputFiles
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1242';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1242_SHOTS_DIR || path.join(tmpdir(), 'refract-1242-status-text-shots');
const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' },
  { id: 'nordic-frost', name: 'Nordic Frost' },
  { id: 'cyber-amber', name: 'Cyber Amber' }
];
const SHOT_NAMES = ['working.png', ...THEMES.map((t) => `needs-you-${t.id}.png`)];

const BANNER = `document.querySelector('[data-testid="current-work-banner"]')`;
const LABEL = `document.querySelector('[data-testid="current-work-banner-text"]')`;
const SHIMMER = `${LABEL}?.querySelector('[data-shimmer]')`;

const report = [];
function assertTrue(actual, label, extra) {
  const ok = actual === true;
  report.push({ step: label, ok, actual, ...(extra ? { extra } : {}) });
  if (!ok) throw new Error(`FAIL: ${label} (actual ${JSON.stringify(actual)})`);
  console.log(`${LOG}: PASS ${label}`);
}

async function shimmerState(cdp) {
  return cdp.evaluate(`(() => { const s = ${SHIMMER}; if (!s) return null; const cs = getComputedStyle(s); return { mode: s.getAttribute('data-shimmer'), animation: cs.animationName, color: cs.color }; })()`);
}

async function shot(cdp, name) {
  await sleep(250);
  await cdp.screenshot(path.join(SHOTS_DIR, name));
}

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirtyLines = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).stdout.split('\n').filter(Boolean);
  console.log(`${LOG}: git HEAD ${head}${dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
  clearKnownOutputFiles(SHOTS_DIR, 'refract-1242-status-text-shots', [...SHOT_NAMES, 'report.json']);
  mkdirSync(SHOTS_DIR, { recursive: true });

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1242-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1242-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1242-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1242-status');
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1242-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1242-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1242-shim-'));

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
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`, { timeoutMs: 30_000, label: 'Scratch repository added' });
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'New session dialog open' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Session composer enabled' });

    await cdp.typeIntoByLabel('Message', 'do the work');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`!!(${BANNER}) && !!(${SHIMMER})`, { timeoutMs: 20_000, label: 'Banner shows while working' });

    // Working: geometry, colour, shimmer on.
    const accent = await resolveCssVarColor(cdp, '--accent-text', 'color');
    const geometry = await cdp.evaluate(`(() => { const b = ${BANNER}; const l = ${LABEL}; const bs = getComputedStyle(b); return { height: b.getBoundingClientRect().height, fontSize: bs.fontSize, marginBottom: bs.marginBottom, labelColor: getComputedStyle(l).color, labelSize: getComputedStyle(l).fontSize }; })()`);
    assertTrue(geometry.fontSize === '14px' && geometry.labelSize === '14px', 'Banner text is 14px (text-sm)', geometry);
    assertTrue(geometry.marginBottom === '4px', 'Banner is raised with a 4px bottom margin', geometry);
    assertTrue(geometry.height >= 22 && geometry.height <= 26, 'Banner keeps its h-6 line height', geometry);
    assertTrue(geometry.labelColor === accent, 'Label colour is --accent-text', { accent, labelColor: geometry.labelColor });
    const working = await shimmerState(cdp);
    assertTrue(working?.mode === 'on' && working.animation === 'text-shimmer-sweep', 'Shimmer runs while working', working);
    assertTrue(await cdp.evaluate(`${BANNER}.getAttribute('aria-live') === 'off'`), 'Banner stays aria-live off');
    await shot(cdp, 'working.png');

    // Reduced motion: the class may stay, but the animation and gradient are gone.
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(300);
    const reduced = await shimmerState(cdp);
    assertTrue(reduced?.animation === 'none' && reduced.color === accent, 'Reduced motion: no animation, plain accent colour', reduced);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

    // Settings switch off, then on.
    assertTrue((await cdp.evaluate(`window.refract.settings.setAnimatedStatusText(false).then((r) => r.ok)`)) === true, 'Turned Animated status text off');
    await cdp.waitFor(`${SHIMMER}?.getAttribute('data-shimmer') === 'off'`, { timeoutMs: 5_000, label: 'Shimmer stops with the switch off' });
    assertTrue((await cdp.evaluate(`window.refract.settings.setAnimatedStatusText(true).then((r) => r.ok)`)) === true, 'Turned Animated status text back on');
    await cdp.waitFor(`${SHIMMER}?.getAttribute('data-shimmer') === 'on'`, { timeoutMs: 5_000, label: 'Shimmer resumes with the switch on' });

    // Needs you: static, accent-coloured in every theme.
    await cdp.waitFor(`/Waiting for your answer/.test(${LABEL}?.textContent ?? '')`, { timeoutMs: 30_000, label: 'Banner shows needs-you' });
    for (const theme of THEMES) {
      await switchTheme(cdp, theme.id, theme.name);
      await sleep(300);
      const themeAccent = await resolveCssVarColor(cdp, '--accent-text', 'color');
      const s = await shimmerState(cdp);
      assertTrue(s?.mode === 'off' && s.animation !== 'text-shimmer-sweep', `${theme.name}: needs-you is static`, s);
      const color = await cdp.evaluate(`getComputedStyle(${LABEL}).color`);
      assertTrue(color === themeAccent, `${theme.name}: label colour is --accent-text`, { themeAccent, color });
      await shot(cdp, `needs-you-${theme.id}.png`);
    }
    await switchTheme(cdp, 'dark', 'Dark');

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
