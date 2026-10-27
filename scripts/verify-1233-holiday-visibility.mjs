#!/usr/bin/env node
// Live CDP check for issue #1233 (Halloween artwork visibility): on all five dark themes the
// Halloween bats and watermark glyph read at about 3:1 against the theme background, and the bat
// flight countdown survives idle pauses (it freezes while paused instead of restarting).
//
// Usage: CARGO_TARGET_DIR=<shared target dir> CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 node
// scripts/verify-1233-holiday-visibility.mjs (requires a prior `pnpm exec tauri build --debug
// --no-bundle`). Runs a scratch instance with a scratch data dir and the recorded-frame fake omp.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  safeRmSync,
  requireSharedCargoTarget,
  switchTheme,
  clearKnownOutputFiles
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { dispatchNeutralPointerdown } from './verify-1048-holiday-touches-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1233';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1233_SHOTS_DIR || path.join(tmpdir(), 'refract-1233-shots');
const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'nordic-frost', name: 'Nordic Frost' },
  { id: 'cyber-amber', name: 'Cyber Amber' }
];
const DATE_OVERRIDE = '2026-10-27';
const SHORT_IDLE_MS = 3_000;
const SHORT_FLIGHT_INTERVAL_MS = 5_000;
const MIN_CONTRAST = 3;

// Composites `color` at `opacity` over `--background` through a canvas (the same sRGB-gamma
// blend the compositor uses) and returns the WCAG contrast of the result against the background.
const CONTRAST_PROBE = `(selector) => {
  const el = document.querySelector(selector);
  if (!el) return null;
  const probe = document.createElement('canvas');
  probe.width = probe.height = 1;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  const style = getComputedStyle(el);
  const rootStyle = getComputedStyle(document.documentElement);
  const bgHost = document.createElement('div');
  bgHost.style.color = getComputedStyle(document.querySelector('[class*="theme-"]') ?? document.body).getPropertyValue('--background') || rootStyle.getPropertyValue('--background');
  document.body.appendChild(bgHost);
  const bgColor = getComputedStyle(bgHost).color;
  bgHost.remove();
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, 1, 1);
  const bg = Array.from(ctx.getImageData(0, 0, 1, 1).data);
  ctx.globalAlpha = Number(style.opacity);
  ctx.fillStyle = style.color;
  ctx.fillRect(0, 0, 1, 1);
  const fg = Array.from(ctx.getImageData(0, 0, 1, 1).data);
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (p) => 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]);
  const a = lum(fg), b = lum(bg);
  return { opacity: style.opacity, color: style.color, bg, fg, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
}`;

async function main() {
  const head = gitHead(REPO_ROOT);
  console.log(`${LOG}: git HEAD ${head}`);
  clearKnownOutputFiles(SHOTS_DIR, 'refract-1233-shots', [...THEMES.map((t) => `artwork-${t.id}.png`), 'report.json']);
  const report = [];
  const assertTrue = (ok, label, extra) => {
    report.push({ step: label, ok, ...(extra ? { extra } : {}) });
    console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ` ${JSON.stringify(extra)}` : ''}`);
    if (!ok) throw new Error(`FAIL: ${label}`);
  };

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1233-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1233-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1233-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1233-holiday-visibility');
  const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1233-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1233-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1233-shim-'));
  let child;
  let cdp;
  let failure;
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
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'session',
        REFRACT_DATE_OVERRIDE: DATE_OVERRIDE,
        REFRACT_HOLIDAY_IDLE_MS: String(SHORT_IDLE_MS),
        REFRACT_HOLIDAY_FLIGHT_INTERVAL_MS: String(SHORT_FLIGHT_INTERVAL_MS)
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`${LOG}: CDP target is not owned by the launched pid`);
    await cdp.waitFor(`!!(window.refract && window.refract.debug)`, { timeoutMs: 15_000, label: 'debug bridge' });

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
    );
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(`!!document.querySelector('[data-chat-empty-state]')`, { timeoutMs: 30_000, label: 'Empty chat state' });

    // ---- 3:1 contrast, bats and glyph, every theme ----
    for (const theme of THEMES) {
      if (theme.id !== 'dark') await switchTheme(cdp, theme.id, theme.name);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 400 });
      await sleep(600);
      const glyph = await cdp.evaluate(`(${CONTRAST_PROBE})('.watermark-mark-holiday svg')`);
      const bat = await cdp.evaluate(`(${CONTRAST_PROBE})('.holiday-ambient-loop-bat')`);
      assertTrue(!!glyph && glyph.contrast >= MIN_CONTRAST, `${theme.name}: watermark glyph at least ${MIN_CONTRAST}:1`, glyph);
      assertTrue(!!bat && bat.contrast >= MIN_CONTRAST, `${theme.name}: bats at least ${MIN_CONTRAST}:1`, bat);
      await cdp.screenshot(path.join(SHOTS_DIR, `artwork-${theme.id}.png`));
    }
    await switchTheme(cdp, 'dark', 'Dark');

    // ---- Flight countdown survives idle pauses ----
    // Each awake window is 3.4s (idle pause at 3s) against a 5s delay: a countdown that restarts
    // on resume never reaches 5s, so any flight here proves the remaining delay was kept.
    const flightCount = () => cdp.evaluate(`Number(document.querySelector('.holiday-ambient-loop')?.getAttribute('data-flight-count') ?? 0)`);
    const pausedAttr = () => cdp.evaluate(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') === 'true'`);
    await cdp.waitFor(`document.querySelector('.holiday-ambient-loop')?.getAttribute('data-paused') === 'true'`, { timeoutMs: 15_000, label: 'Loop paused by idle' });
    const before = await flightCount();
    let pausedFlights = 0;
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const atPause = await flightCount();
      await sleep(1_000);
      pausedFlights += (await flightCount()) - atPause;
      await dispatchNeutralPointerdown(cdp);
      await sleep(3_400);
    }
    const after = await flightCount();
    assertTrue(pausedFlights === 0, 'No flight starts while the loop is paused', { pausedFlights });
    assertTrue(after > before, 'A flight starts across repeated short awake windows (countdown kept across pauses)', { before, after });
    assertTrue(await pausedAttr(), 'Loop is paused again after the last idle timeout');
  } catch (err) {
    failure = err;
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
  }
  if (cdp) cdp.close();
  if (child) await stopLauncher(child).catch(() => {});
  for (const dir of [dataDir, importSourceDir, repoDirBase, worktreesRoot, exeDir, launcherDir, shimDir]) await safeRmSync(dir, LOG);
  writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, results: report }, null, 2));
  if (failure) throw failure;
  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
