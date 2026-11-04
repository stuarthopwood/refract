#!/usr/bin/env node
// Live CDP check for #1048 slice 2: one launch per faked date (REFRACT_DATE_OVERRIDE, debug builds only).
// Run after `pnpm exec tauri build --debug --no-bundle` with CARGO_TARGET_DIR set.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { buildFakeGh } from './verify-1121-pr-polish-fake-gh.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { settleForScreenshot, dispatchNeutralPointerdown } from './verify-1048-holiday-touches-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1048-slice2';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1048_SLICE2_SHOTS_DIR || path.join(tmpdir(), 'refract-1048-slice2-shots');
const SHORT_FLIGHT_INTERVAL_MS = 3_000;
const LONG_IDLE_MS = 600_000;
const VIEWPORT = { width: 1800, height: 1000 };
const SETTLE_MS = 500;

const CASES = [
  { id: 'bonfire-night', date: '2026-11-03', icon: 'lucide-flame', loop: true, deepChecks: false },
  { id: 'christmas', date: '2026-12-10', icon: 'lucide-tree-pine', loop: true, deepChecks: true },
  { id: 'new-year-31-dec', date: '2026-12-31', icon: 'lucide-party-popper', loop: true, deepChecks: false },
  { id: 'new-year-1-jan', date: '2027-01-01', icon: 'lucide-party-popper', loop: true, deepChecks: false },
  { id: 'star-wars-day', date: '2027-05-04', icon: 'lucide-swords', loop: false, deepChecks: false },
  { id: 'pi-day', date: '2027-03-14', icon: 'lucide-pi', loop: false, deepChecks: false },
  { id: 'none-27-dec', date: '2026-12-27', icon: null, loop: false, deepChecks: false },
  { id: 'none-30-dec', date: '2026-12-30', icon: null, loop: false, deepChecks: false }
];

const report = [];
function check(ok, label, extra) {
  report.push({ step: label, ok, ...(extra !== undefined ? { extra } : {}) });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label}${extra !== undefined ? ` ${JSON.stringify(extra)}` : ''}`);
  if (!ok) throw new Error(`FAIL: ${label}`);
}

const RUNNING_LOOP_ANIMATIONS = `document.getAnimations().filter((a) => a.effect?.target?.classList?.contains('holiday-ambient-loop-bat-wrap') && a.playState === 'running').length`;

async function dumpFailureDiagnostics(cdp) {
  const text = await cdp.evaluate(`document.body.innerText.slice(0, 600)`).catch(() => '');
  console.error(`${LOG}: page text at failure: ${JSON.stringify(text)}`);
  const diag = await cdp.evaluate(`(() => { const l = document.querySelector('.holiday-ambient-loop'); const w = l && Array.from(l.querySelectorAll('.holiday-ambient-loop-bat-wrap')); return JSON.stringify({ paused: l?.getAttribute('data-paused'), count: l?.getAttribute('data-flight-count'), focus: document.hasFocus(), hidden: document.hidden, visible: w?.map((e) => e.offsetParent !== null) }); })()`).catch(() => '');
  console.error(`${LOG}: loop diag: ${diag}`);
}

async function runCase(c, exeDir, launcherExe, shimDir, repoDir) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1048s2-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1048s2-import-'));
  const ompLog = path.join(exeDir, `omp-calls-${c.id}.log`);
  const shot = (name) => path.join(SHOTS_DIR, `${c.id}-${name}.png`);
  let child;
  let cdp;
  try {
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, path.join(exeDir, 'refract-tauri.exe'), {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, `app-${c.id}.log`),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'session',
        REFRACT_FAKE_OMP_DEBUG_LOG: ompLog,
        REFRACT_DATE_OVERRIDE: c.date,
        REFRACT_HOLIDAY_IDLE_MS: String(LONG_IDLE_MS),
        REFRACT_HOLIDAY_FLIGHT_INTERVAL_MS: String(SHORT_FLIGHT_INTERVAL_MS)
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched pid');
    // The loop pauses while the window lacks focus; a background-launched exe has none.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    // Transcript-pane loops live in gutters that only exist above 86rem (1376px).
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
    await cdp.waitFor(`!!(window.refract && window.refract.debug)`, { timeoutMs: 15_000, label: 'debug bridge' });
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await cdp.openLocalFolderDialog();
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
    await cdp.waitFor(`!!document.querySelector('[data-repository-id]')`, { timeoutMs: 30_000, label: 'Project added' });
    await createSessionViaQuickCreate(cdp, path.basename(repoDir));
    await cdp.evaluate(`window.refract.settings.setChatWidth('reading-column')`);
    await sleep(SETTLE_MS);
    await settleForScreenshot(cdp);

    const presence = () =>
      cdp.evaluate(`(() => ({
        watermark: document.querySelector('.watermark-mark-holiday svg')?.getAttribute('class') ?? null,
        plainWatermark: !!document.querySelector('.watermark-mark:not(.watermark-mark-holiday)'),
        sidebar: Array.from(document.querySelectorAll('svg')).map((s) => s.getAttribute('class')).filter((k) => /lucide-/.test(k ?? '')),
        loop: !!document.querySelector('.holiday-ambient-loop')
      }))()`);
    const p = await presence();
    if (c.icon) {
      check(!p.watermark && p.plainWatermark, `${c.id} (${c.date}): session-pane watermark stays plain (#1256); the plain mark is present`, p);
      check(p.sidebar.some((k) => k.includes(c.icon)), `${c.id}: sidebar logo accessory is ${c.icon}`, p);
      check(p.loop === c.loop, `${c.id}: ambient loop ${c.loop ? 'present' : 'absent'} under Full`, p);
    } else {
      check(!p.watermark && !p.loop && !p.sidebar.some((k) => /flame|tree-pine|party-popper|swords|lucide-pi\b|ghost/.test(k)), `${c.id} (${c.date}): no holiday artwork`, p);
    }
    await cdp.screenshot(shot('watermark-sidebar'));

    if (c.loop) {
      await dispatchNeutralPointerdown(cdp);
      await cdp.waitFor(`Number(document.querySelector('.holiday-ambient-loop')?.getAttribute('data-flight-count') ?? 0) > 0`, { timeoutMs: 30_000, label: `${c.id}: a loop flight starts` });
      const pieces = await cdp.evaluate(`document.querySelectorAll('.holiday-ambient-loop-bat-wrap').length`);
      check(pieces === 3, `${c.id}: three loop pieces`, pieces);
      await cdp.waitFor(`${RUNNING_LOOP_ANIMATIONS} > 0`, { timeoutMs: 10_000, label: `${c.id}: a loop piece is actually animating` });
      check(true, `${c.id}: a loop piece is actually animating`, await cdp.evaluate(RUNNING_LOOP_ANIMATIONS));
      await cdp.screenshot(shot('loop-flight'));
    }

    if (c.deepChecks) {
      await cdp.evaluate(`window.refract.settings.setHolidayTouches('artwork')`);
      await cdp.waitFor(`!document.querySelector('.holiday-ambient-loop')`, { timeoutMs: 10_000, label: 'Artwork only: loop unmounts' });
      const pa = await presence();
      check(pa.sidebar.some((k) => k.includes(c.icon)), 'Artwork only: sidebar artwork stays', pa);
      await cdp.screenshot(shot('artwork-only'));
      await cdp.evaluate(`window.refract.settings.setHolidayTouches('off')`);
      await sleep(SETTLE_MS);
      const po = await presence();
      check(!po.watermark && !po.loop && !po.sidebar.some((k) => k.includes(c.icon)), 'Off: no holiday artwork or loop', po);
      await cdp.screenshot(shot('off'));
      await cdp.evaluate(`window.refract.settings.setHolidayTouches('full')`);
      await cdp.waitFor(`!!document.querySelector('.holiday-ambient-loop')`, { timeoutMs: 10_000, label: 'Full: loop remounts' });
      // Without this a vacuous 0 would pass: prove a flight is running first.
      await dispatchNeutralPointerdown(cdp);
      await cdp.waitFor(`${RUNNING_LOOP_ANIMATIONS} > 0`, { timeoutMs: 30_000, label: 'A loop flight is running before reduced motion is emulated' });
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await cdp.waitFor(`getComputedStyle(document.querySelector('.holiday-ambient-loop')).display === 'none'`, { timeoutMs: 5_000, label: 'Reduced motion hides the loop layer' });
      const running = await cdp.evaluate(RUNNING_LOOP_ANIMATIONS);
      check(running === 0, 'Reduced motion: the running loop animation was cancelled', running);
      await cdp.screenshot(shot('reduced-motion'));
    }

    if (c.icon) {
      await cdp.typeIntoByLabel('Message', 'trigger the scripted turn');
      await cdp.clickByLabel('Send message');
      await cdp.waitFor(`!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`, { timeoutMs: 30_000, label: 'Approval card' });
      await cdp.clickByText('Approve');
      const spinner = `Array.from(document.querySelectorAll('.agent-spinner-holiday'))[0]`;
      await cdp.waitFor(`!!(${spinner})`, { timeoutMs: 10_000, label: `${c.id}: holiday spinner glyph` });
      const cls = await cdp.evaluate(`(${spinner}).getAttribute('class')`);
      check(cls.includes(c.icon), `${c.id}: spinner glyph is ${c.icon}`, cls);
      check(await cdp.evaluate(`Array.from(document.querySelectorAll('span.sr-only')).some((el) => (el.textContent ?? '').trim() === 'Working')`), `${c.id}: sr-only "Working" present`);
      await cdp.screenshot(shot('spinner'));
      if (c.deepChecks) {
        const anim = await cdp.evaluate(`getComputedStyle(${spinner}).animationName`);
        check(anim === 'none', 'Christmas spinner: static under emulated reduced motion', anim);
        await cdp.send('Emulation.setEmulatedMedia', { features: [] });
      }
    }
    const calls = existsSync(ompLog) ? readFileSync(ompLog, 'utf8').split('\n').filter(Boolean).length : 0;
    report.push({ step: `${c.id}: fake omp call log`, ok: true, extra: { log: ompLog, calls } });
    if (c.icon) check(calls > 0, `${c.id}: fake omp was used (call log has entries)`, calls);
  } catch (err) {
    if (cdp) {
      await cdp.screenshot(shot('FAILED')).catch(() => {});
      await dumpFailureDiagnostics(cdp);
    }
    throw err;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir, LOG);
    await safeRmSync(importSourceDir, LOG);
  }
}

async function main() {
  const head = gitHead(REPO_ROOT);
  console.log(`${LOG}: git HEAD ${head}`);
  mkdirSync(SHOTS_DIR, { recursive: true });
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1048s2-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1048-slice2');
  const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1048s2-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1048s2-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1048s2-shim-'));
  let crashed;
  try {
    buildOmpShim(shimDir);
    buildFakeGh(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    for (const c of CASES) await runCase(c, exeDir, launcherExe, shimDir, repoDir);
  } catch (err) {
    crashed = err;
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
  } finally {
    const failures = report.filter((r) => r.ok === false).map((r) => r.step);
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, failures, passCount: report.filter((r) => r.ok).length, results: report }, null, 2));
    for (const d of [repoDirBase, worktreesRoot, exeDir, launcherDir, shimDir]) await safeRmSync(d, LOG);
  }
  if (crashed) throw crashed;
  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
