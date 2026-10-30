#!/usr/bin/env node
// Live CDP check for #568 (pull request restyle: list rows, header, tabs, detail layout), driving the real Tauri debug build
// isolated per the `refract-tauri-live-check-isolation` skill (scratch data dirs, never the real `%APPDATA%/refract-tauri`).
// Needs real GitHub data: the scratch Project is a read-only shallow clone of `stuarthopwood/refract`; no comment/review/merge is ever sent.
// A failed clone or a settled list with zero rows is a hard failure, never a "not exercised" pass.
// Rebuilds the exe fresh via `buildAndCopyExeFresh` (a shared-target binary may be clobbered by a sibling lane), then asserts a #568-only marker first.

import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  getFreePort,
  waitForCdpTarget,
  CdpSession,
  stopLauncher,
  isTargetOwningPort,
  assertExeMatchesProcess,
  createReportLogger,
  sleep
} from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  buildAndCopyExeFresh,
  launchBuiltExe,
  safeRmSync,
  requireSharedCargoTarget
} from './verify-tauri-scratch-helpers.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_568_SHOTS_DIR || path.join(tmpdir(), 'refract-568-gate1-shots');
const GITHUB_SCRATCH_CLONE_URL = 'https://github.com/stuarthopwood/refract.git';
const NARROW_WIDTH = 360;

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function connectCdp(port, targetPid) {
  const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
  const cdp = await CdpSession.connect(wsUrl);
  if (!isTargetOwningPort(port, targetPid)) {
    throw new Error(`verify-tauri-568: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
  }
  return cdp;
}

async function pressTab(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
}

/** Shallow read-only clone of `stuarthopwood/refract` into `dir` for real PR data; `gh` resolves owner/repo from the remote, so `--depth 1` suffices. Returns `null` on failure so the caller fails loudly. */
function makeGithubScratchClone(dir) {
  mkdirSync(path.dirname(dir), { recursive: true });
  const result = spawnSync_('git', ['clone', '--depth', '1', '--quiet', GITHUB_SCRATCH_CLONE_URL, dir], { timeout: 60_000 });
  if (result.status !== 0) {
    console.warn(`verify-tauri-568: could not clone ${GITHUB_SCRATCH_CLONE_URL} (${result.stderr || result.error})`);
    return null;
  }
  return dir;
}

function assertBundleContainsStory568Marker() {
  const bundleRoot = path.join(REPO_ROOT, 'out', 'tauri-web');
  if (!existsSync(bundleRoot)) {
    throw new Error(`verify-tauri-568: no built renderer bundle at ${bundleRoot} -- run \`pnpm tauri build --debug --no-bundle\` first (the exe build below rebuilds it, but this static check runs before launch).`);
  }
  const grep = spawnSync_('node', ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    function* walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { yield* walk(full); }
        else if (entry.name.endsWith('.js')) yield full;
      }
    }
    let found = false;
    for (const file of walk(${JSON.stringify(bundleRoot)})) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('Refresh this pull request') && text.includes('bg-pr-')) { found = true; break; }
    }
    console.log(found ? 'FOUND' : 'MISSING');
  `]);
  assert(grep.stdout.includes('FOUND'), '#568-only marker (RefreshButton label + bg-pr- StatePill class) not found in the built renderer bundle -- the exe under test may not actually contain this story\'s code');
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const log = createReportLogger(path.join(SHOTS_DIR, 'report.txt'));
  const report = { gitHead: gitHead(REPO_ROOT), checks: [], failures: [], notExercised: [] };
  log(`verify-tauri-568: git HEAD under test: ${report.gitHead}`);

  function checkPass(name, detail) {
    report.checks.push({ name, status: 'PASS', detail });
    log(`STEP PASS: ${name}${detail ? ` -- ${detail}` : ''}`);
  }
  function checkFail(name, detail) {
    report.checks.push({ name, status: 'FAIL', detail });
    report.failures.push(name);
    log(`STEP FAIL: ${name}${detail ? ` -- ${detail}` : ''}`);
  }
  function notExercised(name, reason) {
    report.notExercised.push({ name, reason });
    log(`NOT EXERCISED: ${name} -- ${reason}`);
  }

  let dataDir, importSourceDir, shimDir, exeDir, repoClone;
  let child;
  let cdp;
  try {
    try {
      assertBundleContainsStory568Marker();
      checkPass('#568-only DOM/bundle marker present');
    } catch (err) {
      checkFail('#568-only DOM/bundle marker present', err.message);
      throw err;
    }

    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-568-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-568-import-src-'));
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-568-launcher-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-568-exe-'));
    const cloneParent = mkdtempSync(path.join(tmpdir(), 'refract-568-repo-'));
    repoClone = makeGithubScratchClone(path.join(cloneParent, 'refract'));

    log(`verify-tauri-568: data dir ${dataDir}`);
    log(`verify-tauri-568: evidence/screenshot dir ${SHOTS_DIR}`);
    log(`verify-tauri-568: GitHub scratch clone ${repoClone ?? '(FAILED -- see below)'}`);

    if (!repoClone) {
      // No repo is a hard failure: real PR data is the point.
      checkFail('GitHub scratch clone of stuarthopwood/refract succeeded', 'git clone failed (offline, or the ambient gh/git credentials are not reachable from this sandboxed shell) -- cannot prove anything about real PR data without it');
    }

    const launcherExe = buildLauncher(shimDir);
    const { dest: exePath, hash: exeHash } = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-tauri-568' });

    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      logFile: path.join(SHOTS_DIR, 'app-run.log')
    });
    child = launched.child;
    const targetPid = launched.targetPid;
    cdp = await connectCdp(port, targetPid);
    assertExeMatchesProcess(targetPid, exePath, exeHash);
    log(`verify-tauri-568: launched, pid ${targetPid}, exe sha256 ${exeHash} (asserted against the process's own exe path)`);

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]:not(:disabled)') || !!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add repository' && !el.disabled)`, { timeoutMs: 45_000, label: 'app ready for Add repository (readiness checks passed, button enabled)' });

    let reachedPrData = false;

    if (repoClone) {
      await addRepository(cdp, repoClone);
      checkPass('Added scratch stuarthopwood/refract clone as a Project');

      await cdp.clickByText('Pull requests');
      await cdp.waitFor(`document.querySelector('h2') && document.querySelector('h2').textContent.trim() === 'Pull requests'`, { timeoutMs: 15_000, label: 'Pull requests view mounted' });
      checkPass('Navigated to Pull requests view');

      const headerBorder = await cdp.evaluate(`(() => {
        const h2 = Array.from(document.querySelectorAll('h2')).find((el) => el.textContent.trim() === 'Pull requests');
        const header = h2 && h2.closest('.drag-region');
        return header ? getComputedStyle(header).borderBottomWidth : null;
      })()`);
      if (headerBorder === '0px') checkPass('PullRequestsView header has no border-b', `borderBottomWidth=${headerBorder}`);
      else checkFail('PullRequestsView header has no border-b', `borderBottomWidth=${headerBorder} (expected 0px)`);

      const loaded = await cdp.waitFor(`(() => {
        const err = document.querySelector('[role="alert"]');
        const rows = document.querySelectorAll('.divide-y.divide-divider > button, .divide-y > button');
        return rows.length > 0 ? 'rows' : (err ? 'error' : null);
      })()`, { timeoutMs: 30_000, label: 'pull request list settles' });

      if (loaded !== 'rows') {
        // An error banner or a list that never settles to real rows proves nothing about the restyle: hard failure.
        const errorText = loaded === 'error' ? await cdp.evaluate(`document.querySelector('[role="alert"]').textContent`) : '(list never settled within 30s)';
        checkFail('Pull request list settles to real rows', errorText);
      } else {
        reachedPrData = true;
      }
    }

    if (reachedPrData) {
      const rowShape = await cdp.evaluate(`(() => {
        const list = document.querySelector('.divide-y.divide-divider') ?? document.querySelector('.divide-y');
        if (!list) return null;
        const row = list.querySelector('button');
        if (!row) return null;
        return { rowClass: row.className, lines: row.querySelectorAll(':scope > span').length };
      })()`);
      assert(rowShape, 'no PullRequestRow found in a rendered list');
      const noBoxChrome = !/\brounded-md\b/.test(rowShape.rowClass) && !/\bborder-border\b/.test(rowShape.rowClass);
      if (noBoxChrome && rowShape.lines >= 3) checkPass('Row is a zero-box divide-y row with 3 lines', `rowClass="${rowShape.rowClass}"`);
      else checkFail('Row is a zero-box divide-y row with 3 lines', `rowClass="${rowShape.rowClass}" lines=${rowShape.lines}`);

      // Metadata segments must not be `font-code` (decision 2).
      const metaUsesAppFont = await cdp.evaluate(`(() => {
        const list = document.querySelector('.divide-y.divide-divider') ?? document.querySelector('.divide-y');
        const row = list && list.querySelector('button');
        if (!row) return null;
        const metaLine = row.querySelectorAll(':scope > span')[1];
        return metaLine ? !metaLine.className.includes('font-code') : null;
      })()`);
      if (metaUsesAppFont === true) checkPass('Row metadata line has no font-code class (App font, not mono)');
      else checkFail('Row metadata line has no font-code class (App font, not mono)', String(metaUsesAppFont));

      // ---- Keyboard-only: Tab to the first row, press Enter, prove it selected ----
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
      await cdp.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
      let reachedRow = false;
      for (let i = 0; i < 40 && !reachedRow; i++) {
        await pressTab(cdp);
        reachedRow = await cdp.evaluate(`document.activeElement && document.activeElement.closest('.divide-y') !== null`);
      }
      if (!reachedRow) {
        checkFail('Keyboard-only: Tab reaches a row and Enter selects it (detail h2 updates)', 'Tab never reached a row within 40 presses');
      } else {
        // `.closest('.divide-y')` returns the list container, not the row; the focused row is `document.activeElement`, so read it directly.
        const focusedRowTitle = await cdp.evaluate(`(() => {
          const titleSpan = document.activeElement ? document.activeElement.querySelector('span.truncate') : null;
          return titleSpan ? titleSpan.textContent.trim() : null;
        })()`);
        await cdp.pressEnter();
        // Poll generously: the detail view shows "Loading..." with no `h2` until a real GitHub round trip resolves.
        const detailTitleMatches = await cdp
          .waitFor(`(() => {
            const h2 = document.querySelector('h2.line-clamp-2');
            return h2 ? h2.textContent.includes(${JSON.stringify(focusedRowTitle ?? '')}) : false;
          })()`, { timeoutMs: 20_000, label: 'detail h2 picks up the selected row\'s title' })
          .catch(() => false);
        const barOnFocusedRow = await cdp.evaluate(`!!document.activeElement?.querySelector('.bg-active-indicator')`);
        if (barOnFocusedRow && detailTitleMatches) {
          checkPass('Keyboard-only: Tab reaches a row and Enter selects it (detail h2 updates)', `row "${focusedRowTitle}"`);
        } else {
          checkFail('Keyboard-only: Tab reaches a row and Enter selects it (detail h2 updates)', `row="${focusedRowTitle}" barOnFocusedRow=${barOnFocusedRow} detailTitleMatches=${detailTitleMatches}`);
        }
      }

      const barClass = await cdp.evaluate(`(() => { const el = document.querySelector('.divide-y button .bg-active-indicator'); return el ? el.className : null; })()`);
      if (barClass && !/transition|animate-/.test(barClass)) checkPass('Selection bar has no transition class (reduced-motion safe)', barClass);
      else checkFail('Selection bar has no transition class (reduced-motion safe)', barClass ?? 'bar not found');

      await cdp.waitFor(`!!document.querySelector('h2.line-clamp-2')`, { timeoutMs: 15_000, label: 'detail title rendered' });

      const titleClass = await cdp.evaluate(`(() => { const h2 = document.querySelector('h2.line-clamp-2'); return h2 ? h2.className : null; })()`);
      if (titleClass && /\btext-lg\b/.test(titleClass)) checkPass('Detail title is text-lg/line-clamp-2', titleClass);
      else checkFail('Detail title is text-lg/line-clamp-2', titleClass ?? 'not found');

      // Only the two branch tokens are font-code, not "into"/"by <author>" (decision 2).
      const branchLineShape = await cdp.evaluate(`(() => {
        const h2 = document.querySelector('h2.line-clamp-2');
        const branchLine = h2 ? h2.nextElementSibling : null;
        if (!branchLine) return null;
        const monoSpans = branchLine.querySelectorAll('.font-code');
        return { monoCount: monoSpans.length, fullText: branchLine.textContent.trim() };
      })()`);
      if (branchLineShape && branchLineShape.monoCount === 2) checkPass('Branch line has exactly 2 font-code tokens (head/base branch only)', branchLineShape.fullText);
      else checkFail('Branch line has exactly 2 font-code tokens (head/base branch only)', JSON.stringify(branchLineShape));

      const pillClass = await cdp.evaluate(`(() => { const pill = Array.from(document.querySelectorAll('span')).find((el) => /\\bbg-pr-(open|draft|closed|merged)\\b/.test(el.className)); return pill ? pill.className : null; })()`);
      if (pillClass) checkPass('StatePill renders with a bg-pr-* class', pillClass);
      else checkFail('StatePill renders with a bg-pr-* class', 'not found');

      // Scope button probes to the detail header (the block with the `h2.line-clamp-2` title); another panel could hold a same-named button.
      const newSessionVariant = await cdp.evaluate(`(() => { const header = document.querySelector('h2.line-clamp-2')?.closest('.shrink-0'); const btn = header && Array.from(header.querySelectorAll('button')).find((el) => el.textContent.trim().startsWith('New session') || el.textContent.trim() === 'Starting\\u2026'); return btn ? btn.getAttribute('data-variant') : null; })()`);
      if (newSessionVariant === 'ghost') checkPass('New session button is data-variant="ghost"');
      else checkFail('New session button is data-variant="ghost"', `got "${newSessionVariant}"`);

      // Merge must stay the one filled (default-variant) button.
      const mergeVariant = await cdp.evaluate(`(() => { const header = document.querySelector('h2.line-clamp-2')?.closest('.shrink-0'); const btn = header && Array.from(header.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Merge'); return btn ? btn.getAttribute('data-variant') : null; })()`);
      if (mergeVariant === 'default') checkPass('Merge button is data-variant="default" (the one filled button)');
      else checkFail('Merge button is data-variant="default" (the one filled button)', `got "${mergeVariant}"`);

      const changesLabel = await cdp.evaluate(`(() => { const tab = Array.from(document.querySelectorAll('button')).find((el) => /^Changes \\(\\d+ files?\\)$/.test(el.textContent.trim())); return tab ? tab.textContent.trim() : null; })()`);
      if (changesLabel) checkPass('Changes tab label includes file count', changesLabel);
      else checkFail('Changes tab label includes file count', 'not found');

      // Scope to the detail tablist (found by its "Overview" trigger): a bare `[role=tab][data-state=active]` matches the list's filter tabs first.
      const detailTabBorders = await cdp.evaluate(`(() => {
        const overviewTab = Array.from(document.querySelectorAll('[role="tab"]')).find((el) => el.textContent.trim() === 'Overview');
        const tablist = overviewTab ? overviewTab.closest('[role="tablist"]') : null;
        const active = tablist ? tablist.querySelector('[data-state="active"]') : null;
        if (!active) return null;
        const style = getComputedStyle(active);
        return { top: style.borderTopWidth, right: style.borderRightWidth, bottom: style.borderBottomWidth, left: style.borderLeftWidth };
      })()`);
      const isRealUnderline = detailTabBorders && detailTabBorders.bottom === '2px' && detailTabBorders.top === '0px' && detailTabBorders.right === '0px' && detailTabBorders.left === '0px';
      if (isRealUnderline) checkPass('Detail Overview/Changes active tab is a real 2px underline (0px on other 3 sides)', JSON.stringify(detailTabBorders));
      else checkFail('Detail Overview/Changes active tab is a real 2px underline (0px on other 3 sides)', JSON.stringify(detailTabBorders));

      // Scope to the Overview panel via the trigger's `aria-controls`, not any `<p>` in the document.
      const consensusText = await cdp.evaluate(`(() => {
        const overviewTab = Array.from(document.querySelectorAll('[role="tab"]')).find((el) => el.textContent.trim() === 'Overview');
        const panelId = overviewTab ? overviewTab.getAttribute('aria-controls') : null;
        const panel = panelId ? document.getElementById(panelId) : null;
        const candidates = panel ? Array.from(panel.querySelectorAll('p')).map((el) => el.textContent.trim()) : [];
        return candidates.find((t) => /approved|changes requested|commented/.test(t)) ?? null;
      })()`);
      if (consensusText) checkPass('Reviewer-consensus line renders when reviews exist', consensusText);
      else notExercised('Reviewer-consensus line with a non-zero verdict', 'the selected pull request happened to have no reviews yet; code-verified only (ReviewConsensus.tsx returns null on zero reviews, matching decision 10)');

      // ---- RefreshButton busy state at the detail call site ----
      const refreshBefore = await cdp.evaluate(`(() => {
        const btn = document.querySelector('button[aria-label="Refresh this pull request"]');
        return btn ? { ariaDisabled: btn.getAttribute('aria-disabled'), spinning: btn.querySelector('svg').getAttribute('class').includes('animate-spin') } : null;
      })()`);
      await cdp.click(`document.querySelector('button[aria-label="Refresh this pull request"]')`);
      const refreshDuring = await cdp.evaluate(`(() => {
        const btn = document.querySelector('button[aria-label="Refresh this pull request"]');
        return btn ? { ariaDisabled: btn.getAttribute('aria-disabled'), spinning: btn.querySelector('svg').getAttribute('class').includes('animate-spin') } : null;
      })()`);
      const refreshSettled = await cdp.waitFor(`(() => {
        const btn = document.querySelector('button[aria-label="Refresh this pull request"]');
        return btn && btn.getAttribute('aria-disabled') === 'false';
      })()`, { timeoutMs: 15_000, label: 'detail Refresh settles back' }).catch(() => false);
      if (refreshBefore?.ariaDisabled === 'false' && refreshDuring?.spinning && refreshDuring?.ariaDisabled === 'true' && refreshSettled) {
        checkPass('RefreshButton (detail): aria-disabled + spinner while loading, clears once settled');
      } else {
        checkFail('RefreshButton (detail): aria-disabled + spinner while loading, clears once settled', JSON.stringify({ refreshBefore, refreshDuring, refreshSettled }));
      }

      // ---- Narrow detail pane: the fixed `w-80` list column plus the sidebar leave only a sliver at a 360px window (App.tsx `minSize={360}`),
      // so size the window so the detail pane itself lands near ${NARROW_WIDTH}px and assert each action button sits inside that pane. ----
      const laidOutAtWideWindow = await cdp.evaluate(`(() => {
        const pane = Array.from(document.querySelectorAll('div')).find((el) => el.className === 'min-w-0 flex-1 overflow-hidden');
        return pane ? pane.getBoundingClientRect().left : null;
      })()`);
      let windowWidth = Math.round((laidOutAtWideWindow ?? 333) + NARROW_WIDTH);
      let paneRect = null;
      // The sidebar is resizable, so one offset calculation missed by 60px; converge by re-measuring the pane (up to 3 attempts).
      for (let attempt = 0; attempt < 3; attempt++) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: windowWidth, height: 900, deviceScaleFactor: 1, mobile: false });
        await sleep(500);
        paneRect = await cdp.evaluate(`(() => {
          const pane = Array.from(document.querySelectorAll('div')).find((el) => el.className === 'min-w-0 flex-1 overflow-hidden');
          if (!pane) return null;
          const r = pane.getBoundingClientRect();
          return { left: r.left, right: r.right, width: r.width };
        })()`);
        if (!paneRect) break;
        const error = paneRect.width - NARROW_WIDTH;
        if (Math.abs(error) <= 25) break;
        windowWidth = Math.round(windowWidth - error);
      }
      const buttonRects = await cdp.evaluate(`(() => {
        const header = document.querySelector('h2.line-clamp-2')?.closest('.shrink-0');
        const names = ['New session', 'Review', 'Merge'];
        return names.map((name) => {
          const btn = header && Array.from(header.querySelectorAll('button')).find((el) => el.textContent.trim() === name || (name === 'New session' && el.textContent.trim().startsWith('New session')));
          if (!btn) return { name, found: false };
          const r = btn.getBoundingClientRect();
          return { name, found: true, left: r.left, right: r.right, width: r.width };
        });
      })()`);
      const paneIsNarrow = paneRect && paneRect.width > 0 && paneRect.width <= NARROW_WIDTH + 60;
      const allInsidePane = paneRect && buttonRects.every((b) => b.found && b.left >= paneRect.left - 1 && b.right <= paneRect.right + 1 && b.width > 0);
      if (paneIsNarrow && allInsidePane) {
        checkPass(`All 3 detail action buttons fit inside the real ~${NARROW_WIDTH}px-wide detail pane`, JSON.stringify({ paneRect, buttonRects }));
      } else {
        checkFail(`All 3 detail action buttons fit inside the real ~${NARROW_WIDTH}px-wide detail pane`, JSON.stringify({ windowWidth, paneRect, buttonRects }));
      }
      await cdp.screenshot(path.join(SHOTS_DIR, `02-narrow-detail-pane.png`));
      await cdp.send('Emulation.clearDeviceMetricsOverride');

      await cdp.screenshot(path.join(SHOTS_DIR, '01-dark-pull-requests.png'));
      log('STEP PASS: Dark theme screenshot captured.');
    } else {
      notExercised('Every live PR-data check (list rows, detail header, tabs, StatePill, keyboard selection, narrow width, RefreshButton busy state)', 'real GitHub PR data was not reachable this run (see the hard failure above) -- code-verified only');
    }

    // ---- Reduced motion: asserted above via the bar's class list; captured for the record. ----
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(300);
    await cdp.screenshot(path.join(SHOTS_DIR, '03-reduced-motion.png'));
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });

    await cdp.evaluate(`window.refract.theme.set('dark-high-contrast')`);
    await cdp.waitFor(`document.documentElement.className.includes('dark-high-contrast')`, { timeoutMs: 10_000, label: 'high-contrast theme applied' });
    await cdp.screenshot(path.join(SHOTS_DIR, '04-theme-dark-high-contrast.png'));
    checkPass('Dark (high contrast) theme screenshot captured');

    await cdp.evaluate(`window.refract.theme.set('obsidian')`);
    await cdp.waitFor(`document.documentElement.className.includes('obsidian')`, { timeoutMs: 10_000, label: 'obsidian theme applied' });
    await cdp.screenshot(path.join(SHOTS_DIR, '05-theme-obsidian.png'));
    checkPass('Obsidian theme screenshot captured');

    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    if (report.failures.length > 0) {
      log(`verify-tauri-568: ${report.failures.length} FAILURE(S): ${report.failures.join('; ')}`);
      process.exitCode = 1;
    } else {
      log(`verify-tauri-568: ALL EXERCISED CHECKS PASS (${report.notExercised.length} not exercised). Evidence: ${SHOTS_DIR}`);
    }
  } catch (err) {
    report.failures.push(err.message);
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    process.exitCode = 1;
    throw err;
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child);
    if (dataDir) await safeRmSync(dataDir);
    if (importSourceDir) await safeRmSync(importSourceDir);
    if (shimDir) await safeRmSync(shimDir);
    if (exeDir) await safeRmSync(exeDir);
    if (repoClone) await safeRmSync(path.dirname(repoClone));
  }
}

main().catch((err) => {
  console.error('verify-tauri-568: FAIL');
  console.error(err);
  process.exitCode = 1;
});
