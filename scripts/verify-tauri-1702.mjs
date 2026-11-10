#!/usr/bin/env node
// Live CDP check for #1702: repeated identical warnings collapse into one row whose `×N` count is its own unclipped span.
// The maintenance pause surviving a Conversation reset is only provable by the Rust tests (session/token_guard.rs,
// omp/token_guard/shake.rs): the fake omp cannot drive a real shake.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  safeRmSync,
  requireSharedCargoTarget,
  clearKnownOutputFiles
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1702';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1702_SHOTS_DIR || path.join(tmpdir(), 'refract-1702-shots');
const WARNING_BASE = 'Issue #1702 live check: repeated token-guard warning.';

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirtyLines = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).stdout.split('\n').filter(Boolean);
  console.log(`${LOG}: git HEAD ${head}${dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
  clearKnownOutputFiles(SHOTS_DIR, 'refract-1702-shots', ['collapsed-warning.png', 'report.json']);

  const report = [];
  function check(ok, label, extra) {
    report.push({ step: label, ok, ...(extra ? { extra } : {}) });
    if (!ok) throw new Error(`FAIL: ${label} ${JSON.stringify(extra ?? null)}`);
    console.log(`${LOG}: PASS ${label}`);
  }

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1702-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1702-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1702-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1702');
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1702-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1702-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1702-shim-'));

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
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log'),
        REFRACT_FAKE_OMP_SCENARIO: '997-notice-severity'
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) {
      throw new Error(`${LOG}: CDP target on port ${port} is not owned by pid ${launched.targetPid}`);
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
      { timeoutMs: 15_000, label: 'New session dialog open' }
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Session composer enabled'
    });

    await cdp.typeIntoByLabel('Message', 'trigger the scripted notices');
    await cdp.clickByLabel('Send message');
    // The tape emits the warning three times; wait for the error notice that follows so all three have been folded.
    await cdp.waitFor(
      `Array.from(document.querySelectorAll('span.sr-only')).some((el) => (el.textContent ?? '').trim() === 'Error:')`,
      { timeoutMs: 30_000, label: 'Tape finished (error notice rendered)' }
    );

    const rows = await cdp.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('span.sr-only'))
        .filter((el) => (el.textContent ?? '').trim() === 'Warning:')
        .map((el) => el.parentElement?.parentElement)
        .filter((r) => r && (r.textContent ?? '').includes(${JSON.stringify(WARNING_BASE)}));
      return rows.map((r) => {
        const spans = Array.from(r.querySelectorAll('span'));
        const count = spans.find((s) => /^\\s*\\u00d7\\d+$/.test(s.textContent ?? ''));
        const rowRect = r.getBoundingClientRect();
        const countRect = count?.getBoundingClientRect();
        return {
          text: (r.textContent ?? '').trim(),
          countText: count ? count.textContent.trim() : null,
          countWidth: countRect ? countRect.width : 0,
          countRight: countRect ? countRect.right : null,
          rowRight: rowRect.right,
          countClipped: count ? count.scrollWidth > count.clientWidth : null
        };
      });
    })()`);
    check(rows.length === 1, 'repeated warnings collapse into exactly one row', { rows });
    check(rows[0].countText === '\u00d73', 'the row carries a x3 count in its own span', { rows });
    check(rows[0].countWidth > 0 && rows[0].countRight <= rows[0].rowRight + 0.5 && rows[0].countClipped === false, 'the x3 count is fully inside the row and not clipped', { rows });

    await cdp.screenshot(path.join(SHOTS_DIR, 'collapsed-warning.png'));
    report.push({ step: 'screenshot', ok: true, path: path.join(SHOTS_DIR, 'collapsed-warning.png') });
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    throw err;
  } finally {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, failures: report.filter((r) => r.ok === false).map((r) => r.step), results: report }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write report.json: ${writeErr}`);
    }
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    for (const dir of [dataDir, importSourceDir, repoDirBase, worktreesRootForCleanup, exeDir, launcherDir, shimDir]) await safeRmSync(dir, LOG);
  }

  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
