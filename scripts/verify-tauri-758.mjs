#!/usr/bin/env node
// Live CDP check for #758: a tool row's "Wrote N lines to <path>" line draws a worktree-relative path as a file link, but an
// `xd://`, `~/` and UNC target as plain text (no button, no focus stop). Reuses the `997-notice-severity` tape's #758 writes;
// scratch REFRACT_DATA_DIR, CDP port 9258.
// Usage: CARGO_TARGET_DIR=<shared target dir> [REFRACT_758_SHOTS_DIR=<dir>] node scripts/verify-tauri-758.mjs

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-758';
const PORT = 9258;
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_758_SHOTS_DIR || path.join(tmpdir(), 'lane758', 'shots');
const TARGETS = [
  { key: 'relative', text: 'notes-758.txt', linked: true },
  { key: 'xd://', text: 'xd://mcp__skippy_brain_save_memory', linked: false },
  { key: '~/', text: '~/notes-758.md', linked: false },
  { key: 'UNC', text: '\\\\server\\share\\notes-758.md', linked: false }
];

async function main() {
  const head = gitHead(REPO_ROOT);
  console.log(`${LOG}: git HEAD ${head}`);
  mkdirSync(SHOTS_DIR, { recursive: true });
  const report = [];
  const failures = [];
  let passes = 0;
  const check = (ok, label, extra) => {
    report.push({ step: label, ok, ...(extra !== undefined ? { extra } : {}) });
    if (ok) passes += 1;
    else failures.push(label);
    console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label}${ok || extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
  };

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-758-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-758-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-758-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-758-link-targets');
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-758-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-758-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-758-shim-'));

  let child;
  let cdp;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port: PORT,
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
    cdp = await CdpSession.connect(await waitForCdpTarget(PORT, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(PORT, launched.targetPid)) throw new Error(`${LOG}: CDP target on port ${PORT} is not owned by pid ${launched.targetPid}`);

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

    await cdp.typeIntoByLabel('Message', 'trigger the scripted writes');
    await cdp.clickByLabel('Send message');
    // The tape's last frames are the four writes; the turn settles right after them.
    await cdp.waitFor(`Array.from(document.querySelectorAll('button')).some((b) => (b.textContent ?? '').includes('Wrote'))`, { timeoutMs: 30_000, label: 'Write rows rendered' });

    // Open every collapsed row (group, then members) until all four "Wrote 1 line to" lines are in the DOM.
    const wroteLines = `Array.from(document.querySelectorAll('p')).filter((p) => (p.textContent ?? '').startsWith('Wrote 1 line to'))`;
    for (let attempt = 0; attempt < 8; attempt++) {
      const count = await cdp.evaluate(`${wroteLines}.length`);
      if (count >= TARGETS.length) break;
      await cdp.evaluate(
        `Array.from(document.querySelectorAll('[role="log"] button[aria-expanded="false"]')).filter((b) => /Wrote|Writing|Saving/.test((b.textContent ?? '') + (b.getAttribute('aria-label') ?? ''))).forEach((b) => b.click())`
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    await cdp.waitFor(`${wroteLines}.length >= ${TARGETS.length}`, { timeoutMs: 10_000, label: 'All four "Wrote 1 line to" lines expanded' });

    for (const target of TARGETS) {
      const state = await cdp.evaluate(`(() => {
        const p = ${wroteLines}.find((el) => (el.textContent ?? '').includes(${JSON.stringify(target.text)}));
        if (!p) return null;
        const button = p.querySelector('button');
        const span = Array.from(p.querySelectorAll('span')).find((s) => s.textContent === ${JSON.stringify(target.text)});
        return {
          text: p.textContent,
          button: !!button,
          buttonLabel: button?.getAttribute('aria-label') ?? null,
          focusable: !!p.querySelector('button, a[href], [tabindex]'),
          plainSpanTitle: span?.getAttribute('title') ?? null
        };
      })()`);
      if (target.linked) {
        check(!!state && state.button && state.focusable, `${target.key}: drawn as a file link button`, state);
      } else {
        check(!!state && !state.button && !state.focusable && state.plainSpanTitle === target.text, `${target.key}: plain text span with a title, no button, not focusable`, state);
      }
    }
    await cdp.evaluate(`${wroteLines}[0]?.scrollIntoView({ block: 'center' })`);
    await cdp.screenshot(path.join(SHOTS_DIR, 'write-targets.png'));
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    failures.push('run crashed');
    console.error(`${LOG}: FAIL run crashed`, err);
  } finally {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, passes, failures, results: report }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write report.json: ${writeErr}`);
    }
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    for (const dir of [dataDir, importSourceDir, repoDirBase, worktreesRootForCleanup, exeDir, launcherDir, shimDir]) await safeRmSync(dir, LOG);
  }

  console.log(`${LOG}: ${failures.length ? `FAILED (${failures.length})` : `all ${passes} checks passed`}; evidence in ${SHOTS_DIR}`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(`${LOG}: FAILED`, err);
  process.exit(1);
});
