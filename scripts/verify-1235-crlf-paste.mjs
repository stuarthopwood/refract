#!/usr/bin/env node
// Live CDP check for issue #1235 (a large CRLF paste loses its text after the next keystroke).
// Drives a REAL built Tauri debug exe over CDP against the FAKE `omp` shim (`session` scenario),
// never a real `omp`. Pastes a large CRLF block (synthetic ClipboardEvent carrying a CRLF
// `text/plain` payload), types one more character, sends, and proves the full original text
// (CRLF intact) reaches the fake omp's `prompt` command.
//
// Usage (after `pnpm exec tauri build --debug --no-bundle` on this head, shared target dir set):
// CARGO_TARGET_DIR=<shared target dir> node scripts/verify-1235-crlf-paste.mjs

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { spawnSync_, debugLogContent } from './verify-1067-enter-queued-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1235';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1235_SHOTS_DIR || path.join(tmpdir(), 'refract-1235-crlf-paste');

const PASTED = ['Plan', ...Array.from({ length: 120 }, (_, i) => `line ${i + 1}: some pasted content`)].join('\r\n');
const TYPED = '```';

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirtyLines = spawnSync_('git', ['-C', REPO_ROOT, 'status', '--porcelain']).stdout.split('\n').filter(Boolean);
  console.log(`${LOG}: git HEAD ${head}${dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''} pasted ${PASTED.length} chars`);
  mkdirSync(SHOTS_DIR, { recursive: true });

  const report = [];
  const check = (ok, label, extra) => {
    report.push({ step: label, ok, ...(extra ? { extra } : {}) });
    if (!ok) throw new Error(`FAIL: ${label} ${JSON.stringify(extra ?? '')}`);
    console.log(`${LOG}: PASS ${label}`);
  };

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1235-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1235-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1235-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1235-crlf-paste');
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1235-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1235-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1235-shim-'));
  const debugLogPath = path.join(exeDir, 'fake-omp-invocations.log');

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
        REFRACT_FAKE_OMP_DEBUG_LOG: debugLogPath,
        REFRACT_FAKE_OMP_SCENARIO: 'session'
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

    // Real paste event with a CRLF text/plain payload, as a Windows clipboard produces.
    await cdp.evaluate(`(() => {
      const el = document.querySelector('[aria-label="Message"]');
      el.focus();
      const data = new DataTransfer();
      data.setData('text/plain', ${JSON.stringify(PASTED)});
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    })()`);
    const chipLabel = `Plan (${PASTED.length} chars)`;
    await cdp.waitFor(`document.querySelector('[aria-label="Message"]').value.includes(${JSON.stringify(chipLabel)})`, {
      timeoutMs: 10_000,
      label: 'Paste collapsed into a chip label'
    });

    // The next keystroke: this is what dropped the chip before the fix.
    await cdp.send('Input.insertText', { text: TYPED });
    const afterType = await cdp.evaluate(`document.querySelector('[aria-label="Message"]').value`);
    check(afterType.includes(chipLabel) && afterType.endsWith(TYPED), 'Label still intact in the draft after typing', { afterType });

    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`document.querySelectorAll('[data-slot="message"]').length > 0`, { timeoutMs: 30_000, label: 'Message sent' });
    const expectedMessage = `${PASTED}${TYPED}`;
    let sentMatches = false;
    for (let i = 0; i < 50 && !sentMatches; i++) {
      sentMatches = debugLogContent(debugLogPath)
        .split('\n')
        .some((line) => line.includes('RECV') && line.includes(JSON.stringify(expectedMessage).slice(1, -1)));
      if (!sentMatches) await new Promise((r) => setTimeout(r, 200));
    }
    check(sentMatches, 'Full CRLF paste text plus typed suffix reached the fake omp prompt command');
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
