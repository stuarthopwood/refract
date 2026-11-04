#!/usr/bin/env node
// Live CDP check (#1236): mid-turn assistant prose becomes a closed, clamped "Note" row; the final reply stays a message.
// Needs a prior `pnpm exec tauri build --debug --no-bundle`; uses the fake `omp` shim, never a real one.

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
const LOG = 'verify-1236';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1236_SHOTS_DIR || path.join(tmpdir(), 'refract-1236-mid-turn-prose');

const NOTE_ROWS = `Array.from(document.querySelectorAll('button[aria-expanded]')).filter((b) => /^Note/.test(b.textContent.trim()))`;

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirtyLines = spawnSync_('git', ['-C', REPO_ROOT, 'status', '--porcelain']).stdout.split('\n').filter(Boolean);
  console.log(`${LOG}: git HEAD ${head}${dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
  mkdirSync(SHOTS_DIR, { recursive: true });

  const report = [];
  const check = (ok, label, extra) => {
    report.push({ step: label, ok, ...(extra ? { extra } : {}) });
    if (!ok) throw new Error(`FAIL: ${label} ${JSON.stringify(extra ?? '')}`);
    console.log(`${LOG}: PASS ${label}`);
  };

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1236-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1236-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1236-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1236-mid-turn-prose');
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1236-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1236-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1236-shim-'));

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
        REFRACT_FAKE_OMP_SCENARIO: 'mid-turn-prose-1236'
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
    await cdp.openLocalFolderDialog();
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
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

    await cdp.click(`document.querySelector('[aria-label="Message"]')`);
    await cdp.send('Input.insertText', { text: 'do the multi-tool turn' });
    await cdp.clickByLabel('Send message');

    await cdp.waitFor(
      `Array.from(document.querySelectorAll('[data-slot="message"]')).some((m) => m.textContent.includes('NOTE-ONE-1236'))`,
      { timeoutMs: 30_000, label: 'First prose shown as a full message before a tool follows' }
    );
    await cdp.screenshot(path.join(SHOTS_DIR, '1-before-tool.png'));

    try {
      await cdp.waitFor(`${NOTE_ROWS}.length === 2`, { timeoutMs: 40_000, label: 'Two Note rows after the turn' });
    } catch (err) {
      const dump = await cdp.evaluate(`JSON.stringify({
        buttons: Array.from(document.querySelectorAll('button[aria-expanded]')).map((b) => b.textContent.trim().slice(0, 80)),
        log: (document.querySelector('[role="log"]') || document.body).innerText.slice(0, 1500)
      })`);
      await cdp.screenshot(path.join(SHOTS_DIR, 'fail-notes.png'));
      throw new Error(`${err.message}; dump ${dump}`);
    }
    await cdp.waitFor(
      `Array.from(document.querySelectorAll('[data-slot="message"]')).some((m) => m.textContent.includes('FINAL-REPLY-1236'))`,
      { timeoutMs: 20_000, label: 'Final reply visible as a message' }
    );
    const state = await cdp.evaluate(`(() => {
      const notes = ${NOTE_ROWS};
      const messages = Array.from(document.querySelectorAll('[data-slot="message"]')).map((m) => m.textContent);
      return {
        noteExpanded: notes.map((n) => n.getAttribute('aria-expanded')),
        noteText: notes.map((n) => n.textContent.trim()),
        proseStillAMessage: messages.some((t) => t.includes('NOTE-ONE-1236') || t.includes('NOTE-TWO-1236')),
        finalIsMessage: messages.some((t) => t.includes('FINAL-REPLY-1236 all done.')),
        finalInNote: notes.some((n) => n.textContent.includes('FINAL-REPLY-1236'))
      };
    })()`);
    check(state.noteExpanded.every((v) => v === 'false'), 'Both Note rows start closed', state);
    check(state.noteText[0].includes('NOTE-ONE-1236') && state.noteText[1].includes('NOTE-TWO-1236'), 'Note rows carry a first-line summary', state);
    check(!state.proseStillAMessage, 'Collapsed prose is no longer a full message', state);
    check(state.finalIsMessage && !state.finalInNote, 'Final reply stays a full message, not a Note', state);
    await cdp.screenshot(path.join(SHOTS_DIR, '2-collapsed.png'));

    await cdp.click(`${NOTE_ROWS}[0]`);
    await cdp.waitFor(
      `Array.from(document.querySelectorAll('button[aria-expanded]')).some((b) => b.textContent.trim() === 'Show more')`,
      { timeoutMs: 10_000, label: 'Show more appears on the long Note' }
    );
    const clamp = await cdp.evaluate(`(() => {
      const more = Array.from(document.querySelectorAll('button[aria-expanded]')).find((b) => b.textContent.trim() === 'Show more');
      const body = document.getElementById(more.getAttribute('aria-controls'));
      return { expanded: more.getAttribute('aria-expanded'), maxHeight: body.style.maxHeight, clipped: body.scrollHeight > body.clientHeight };
    })()`);
    check(clamp.expanded === 'false' && clamp.maxHeight === '8lh' && clamp.clipped, 'Long Note is clamped to 8 lines', clamp);
    await cdp.screenshot(path.join(SHOTS_DIR, '3-clamped.png'));
    await cdp.click(`Array.from(document.querySelectorAll('button[aria-expanded]')).find((b) => b.textContent.trim() === 'Show more')`);
    const grown = await cdp.evaluate(`(() => {
      const less = Array.from(document.querySelectorAll('button[aria-expanded]')).find((b) => b.textContent.trim() === 'Show less');
      if (!less) return null;
      const body = document.getElementById(less.getAttribute('aria-controls'));
      return { expanded: less.getAttribute('aria-expanded'), clipped: body.scrollHeight > body.clientHeight + 1, hasLast: body.textContent.includes('Paragraph 14') };
    })()`);
    check(!!grown && grown.expanded === 'true' && !grown.clipped && grown.hasLast, 'Show more reveals the whole Note and flips to Show less', grown);
    await cdp.screenshot(path.join(SHOTS_DIR, '4-expanded.png'));
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
  console.error(`${LOG}: FAILED`, err);
  process.exit(1);
});
