#!/usr/bin/env node
// Live CDP check for issue #1238 (Context usage chip shows session AI credits + plan usage).
// Drives a REAL built Tauri debug exe over CDP against the FAKE `omp` shim (`ai-credits-1238`
// scenario: a github-copilot model, 12k/200k context, get_session_stats cost 0.1234), never a
// real `omp`. The plan lookup uses the real `gh` token, so the tooltip may legitimately say
// either "Plan: N% used" or "Plan usage unavailable"; the check accepts both and records which.
//
// Usage (after `pnpm exec tauri build --debug --no-bundle` on this head, shared target dir set):
// CARGO_TARGET_DIR=<shared target dir> node scripts/verify-1238-ai-credits.mjs

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { spawnSync_ } from './verify-1067-enter-queued-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1238';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1238_SHOTS_DIR || path.join(tmpdir(), 'refract-1238-ai-credits');

const CREDITS = `document.querySelector('[data-ai-credits]')`;
const FIGURES = `document.querySelector('[data-context-usage-figures]')`;

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirtyLines = spawnSync_('git', ['-C', REPO_ROOT, 'status', '--porcelain']).stdout.split('\n').filter(Boolean);
  console.log(`${LOG}: git HEAD ${head}${dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
  mkdirSync(SHOTS_DIR, { recursive: true });

  const report = [];
  const failures = [];
  const check = (ok, label, extra) => {
    report.push({ step: label, ok, ...(extra ? { extra } : {}) });
    if (!ok) failures.push(label);
    console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label}${ok || extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
  };

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1238-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1238-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1238-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1238-ai-credits');
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1238-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1238-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1238-shim-'));

  let child;
  let cdp;
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
        REFRACT_FAKE_OMP_SCENARIO: 'ai-credits-1238'
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) {
      throw new Error(`${LOG}: CDP target on port ${port} is not owned by the process this run launched (pid ${launched.targetPid})`);
    }

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
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open, Create session enabled' }
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Session composer enabled'
    });

    // (a) The credits sit inside the Context usage chip, next to the figures.
    let creditsSeen = true;
    try {
      await cdp.waitFor(`!!${CREDITS}`, { timeoutMs: 30_000, label: 'AI credits shown in the Context usage chip' });
    } catch {
      creditsSeen = false;
    }
    const chip = await cdp.evaluate(`(() => {
      const credits = ${CREDITS};
      const figures = ${FIGURES};
      return {
        figures: figures ? figures.textContent.trim() : null,
        creditsText: credits ? credits.querySelector('[aria-hidden]')?.textContent.trim() ?? null : null,
        sameChip: !!credits && !!figures && figures.parentElement.contains(credits)
      };
    })()`);
    await cdp.screenshot(path.join(SHOTS_DIR, '1-chip.png'));
    check(creditsSeen && chip.sameChip && /(^|\s)12 credits$/.test(chip.creditsText ?? ''), '(a) Context usage chip shows "12 credits" beside the figures', chip);

    // (e) Keyboard reachable.
    const tabIndex = await cdp.evaluate(`${CREDITS} ? ${CREDITS}.tabIndex : null`);
    check(tabIndex === 0, '(e) [data-ai-credits] is keyboard reachable (tabIndex 0)', { tabIndex });

    // (c) Screen-reader text.
    const sr = await cdp.evaluate(`${CREDITS} ? (${CREDITS}.querySelector('.sr-only')?.textContent ?? null) : null`);
    check(typeof sr === 'string' && sr.includes('12 credits'), '(c) sr-only text includes "12 credits"', { sr });

    // (b) Tooltip via keyboard focus plus a real mouse move over the element.
    await cdp.evaluate(`${CREDITS}.focus()`);
    const rect = await cdp.evaluate(`(() => { const r = ${CREDITS}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
    let tooltipText = null;
    try {
      await cdp.waitFor(`!!document.querySelector('[role="tooltip"], [data-slot="tooltip-content"]') && /Plan/.test(document.querySelector('[data-plan-usage]')?.textContent ?? '')`, {
        timeoutMs: 10_000,
        label: 'Tooltip with the plan line'
      });
    } catch {
      // Recorded below as a failed check with the observed text.
    }
    tooltipText = await cdp.evaluate(`(() => {
      const t = document.querySelector('[role="tooltip"]') || document.querySelector('[data-slot="tooltip-content"]');
      return t ? t.textContent : null;
    })()`);
    const planMatch = typeof tooltipText === 'string' ? tooltipText.match(/Plan: (<1|\d+)% used|Plan usage unavailable/) : null;
    await cdp.screenshot(path.join(SHOTS_DIR, '2-tooltip.png'));
    check(!!planMatch, `(b) Tooltip shows a plan line (observed: ${planMatch ? planMatch[0] : 'none'})`, { tooltipText });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });

    // (d) Settings > Chat > "Show AI credits and plan usage" off removes the credits only.
    await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
    await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 10_000, label: 'Settings screen opened' });
    await cdp.clickByText('Chat', { tag: 'button' });
    await cdp.waitFor(`!!document.querySelector('#show-ai-credits')`, { timeoutMs: 10_000, label: 'Chat section shows the AI credits switch' });
    await cdp.evaluate(`document.querySelector('#show-ai-credits').scrollIntoView({ block: 'center' })`);
    await cdp.click(`document.querySelector('#show-ai-credits')`);
    await cdp.waitFor(`document.querySelector('#show-ai-credits').getAttribute('aria-checked') === 'false'`, { timeoutMs: 5_000, label: 'AI credits switch is off' });
    await cdp.screenshot(path.join(SHOTS_DIR, '3-settings-off.png'));
    await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
    await cdp.waitFor(`!!document.querySelector('[aria-label="Message"]')`, { timeoutMs: 10_000, label: 'Back to chat from Settings' });
    await cdp.waitFor(`!${CREDITS}`, { timeoutMs: 10_000, label: 'AI credits gone' }).catch(() => {});
    const off = await cdp.evaluate(`({ credits: !!${CREDITS}, figures: !!${FIGURES} })`);
    await cdp.screenshot(path.join(SHOTS_DIR, '4-credits-off.png'));
    check(!off.credits && off.figures, '(d) Switch off removes [data-ai-credits] and keeps [data-context-usage-figures]', off);
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    failures.push('run crashed');
    console.error(`${LOG}: FAIL run crashed`, err);
  } finally {
    try {
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

  console.log(`${LOG}: ${failures.length ? `FAILED (${failures.length})` : 'all checks passed'}; evidence in ${SHOTS_DIR}`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(`${LOG}: FAILED`, err);
  process.exit(1);
});
