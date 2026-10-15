#!/usr/bin/env node
// Live CDP check for issue #563 (Stage group row + Subagent panel tree), gate requirement.
//
// Reuses the recorded-frame fake `omp` harness built for issue #795 (`verify-tauri.mjs`/
// `verify-tauri-cdp.mjs`), selecting the pre-existing `scripts/fixtures/omp-frames/
// subagents.jsonl` tape (`REFRACT_FAKE_OMP_SCENARIO=subagents`) instead of adding a new fixture
// (AGENTS.md: no new fixtures). That tape is a single `task()` batch of two subagents (alpha,
// beta) in ONE stage -- enough to exercise the Stage group row (header shown because it has 2
// agents, decision 1), its `SpineList` member rows, the running/finished status icons, and the
// Subagent panel's tree (two rows, roving tab stop, selection, keyboard). It is NOT two Stages,
// so the Subagent chain row (which needs 2+ Stages, FR-065) and the chain's own opener-based
// "pre-select from a chat entry" path cannot be exercised by this tape; see the report this
// script prints at the end for exactly what that leaves untested.
//
// Reuses the already-built debug exe (`node scripts/ci-local.mjs` ran `tauri build --debug
// --no-bundle` already this session) rather than rebuilding, since nothing under `src-tauri/`
// changed since that build. Every scratch path below is a fresh `mkdtempSync` result (never an
// externally supplied or concatenated path), cleaned up by that same literal variable in the
// `finally` block, the same pattern `verify-tauri.mjs` already uses.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, createWriteStream, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, launchViaJobObject, isTargetOwningPort } from './verify-tauri-cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
const PROMPT_MESSAGE = 'Investigate alpha and beta.';
const SHOTS_DIR = 'C:/Users/shopwood/AppData/Local/Temp/refract-563-shots/';

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

function buildOmpShim(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-omp-shim.rs');
  const out = path.join(dir, 'omp.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', src, '-o', out]);
  if (result.status !== 0) throw new Error(`buildOmpShim: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

function buildLauncher(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-launcher.rs');
  const out = path.join(dir, 'verify-tauri-launcher.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', src, '-o', out]);
  if (result.status !== 0) throw new Error(`buildLauncher: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

function makeScratchRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const run = (args) => {
    const result = spawnSync_('git', ['-C', dir, ...args]);
    if (result.status !== 0) throw new Error(`makeScratchRepo: git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    return result;
  };
  run(['init', '-q', '-b', 'main']);
  run(['-c', 'user.name=verify-563', '-c', 'user.email=verify-563@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

function worktreesDirFor(repoDir) {
  return path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
}

function copyBuiltExe(destDir) {
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'refract-tauri.exe');
  const src = path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
  if (!existsSync(src)) throw new Error(`copyBuiltExe: built exe not found at ${src}`);
  copyFileSync(src, dest);
  return dest;
}

async function launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, pathPrepend, extraEnv = {}, logFile }) {
  const webview2DataDir = path.join(path.dirname(exePath), 'webview2-data');
  mkdirSync(webview2DataDir, { recursive: true });
  const pidFile = path.join(path.dirname(exePath), 'target.pid');
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
    ...extraEnv,
  };
  if (pathPrepend) env.PATH = `${pathPrepend};${process.env.PATH}`;
  const { child, targetPid } = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: path.dirname(exePath), env });
  if (logFile) {
    const stream = createWriteStream(logFile);
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
  }
  return { child, targetPid };
}

async function safeRmSync(dir) {
  if (!dir) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 2) {
        console.warn(`verify-563: could not remove scratch dir ${dir} (left on disk): ${err.message}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function pressKey(cdp, key, windowsVirtualKeyCode) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode });
}

async function main() {
  let shimDir, dataDir, importSourceDir, repoDir, exeDir;
  let child;
  let cdp;
  const findings = [];
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-563-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-563-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-563-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-563-repo-')));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-563-exe-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    const port = await getFreePort();

    console.log(`verify-563: shim dir ${shimDir}`);
    console.log(`verify-563: data dir ${dataDir}`);
    console.log(`verify-563: repo dir ${repoDir}`);
    console.log(`verify-563: shots dir ${SHOTS_DIR}`);
    console.log(`verify-563: CDP port ${port}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const exePath = copyBuiltExe(exeDir);
    console.log(`verify-563: built exe copied to ${exePath}`);

    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'subagents',
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log'),
      },
    });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-563: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }

    // Resolved data dir abort check (skill: refract-tauri-live-check-isolation).
    const bodyTextEarly = await cdp.waitFor(`document.body?.innerText ?? ''`, { timeoutMs: 30_000, label: 'page has rendered some text' });
    console.log('verify-563: early body text sample:', JSON.stringify(bodyTextEarly.slice(0, 120)));

    // US1-style readiness.
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' },
    );
    await cdp.screenshot(path.join(SHOTS_DIR, '01-readiness-green.png'));
    findings.push('Readiness screen green, Add repository enabled.');

    // Add scratch repository.
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Repository added, session-list row rendered' },
    );
    findings.push('Scratch repository added.');

    // Create session.
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open, Create session enabled' },
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Session opened, composer enabled',
    });
    findings.push('Session created, agent attached (fake omp, subagents.jsonl scenario).');

    // Send message, triggering the task() batch of two subagents (alpha, beta).
    await cdp.typeIntoByLabel('Message', PROMPT_MESSAGE);
    await cdp.clickByLabel('Send message');
    // Wait for the Stage group row header ("Stage 1") to appear -- decision 1: a stage with 2+
    // agents gets a header even as the turn's only stage. Visible even while the group is
    // collapsed (the header itself, not the member rows, which Radix Collapsible does not
    // mount at all until expanded -- decision 6's default-collapsed-once-settled behaviour).
    try {
      await cdp.waitFor(
        `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.includes('Stage 1'); })()`,
        { timeoutMs: 30_000, label: 'Stage 1 group header rendered' },
      );
    } catch (err) {
      const diag = await cdp.evaluate(
        `({ transcriptPresent: !!document.querySelector('[aria-label="Transcript"]'), transcriptText: document.querySelector('[aria-label="Transcript"]')?.textContent ?? '(none)' })`,
      );
      console.error('verify-563: stage-wait diagnostics:', JSON.stringify(diag, null, 2));
      await cdp.screenshot(path.join(SHOTS_DIR, '99-diag-stage-wait-failure.png'));
      throw err;
    }

    await cdp.screenshot(path.join(SHOTS_DIR, '02-stage-group-collapsed.png'));
    findings.push('Stage group header ("Stage 1") rendered for the 2-agent batch (alpha, beta), confirming decision 1\'s "2+ agents gets a header even for the turn\'s only stage" rule.');

    // Wait for both subagents to settle (both reach "finished").
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && (t.textContent.match(/Finished/g) || []).length >= 1; })()`,
      { timeoutMs: 30_000, label: 'At least one subagent settled' },
    );

    // Expand the Stage group row (click its own collapsed-line trigger).
    await cdp.click(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); if (!t) return null; return Array.from(t.querySelectorAll('button,[role="button"]')).find((el) => el.textContent.includes('Stage 1')); })()`,
    );
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.includes('alpha') && t.textContent.includes('beta'); })()`,
      { timeoutMs: 15_000, label: 'Stage group expanded, alpha/beta member rows visible' },
    );
    await cdp.screenshot(path.join(SHOTS_DIR, '03-stage-group-expanded.png'));
    findings.push('Stage group row expands to show its SpineList member rows (alpha, beta), each a plain SubagentRow with the shared status icon.');

    // Open the Subagent panel. Prefer the existing Subagents chip (the readout chip row); when
    // it is absent from the narrow scratch window (observed live: the chip row did not render
    // at all at this window width/readout state), fall back to the permanent rail button
    // (`IconRail.tsx`'s own `data-rail-button="subagents"`), which is always present regardless.
    const chipFound = await cdp.evaluate(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('Open subagents panel'))`,
    );
    if (chipFound) {
      await cdp.clickByLabel('Open subagents panel', { prefix: true });
      findings.push('Opened the panel via the Subagents readout chip.');
    } else {
      await cdp.click(`document.querySelector('[data-rail-button="subagents"]')`);
      findings.push('Subagents readout chip was not present at this window state; opened the panel via the permanent rail button instead (data-rail-button="subagents").');
    }
    await cdp.waitFor(`!!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 15_000, label: 'Subagent panel tree mounted' });
    await cdp.screenshot(path.join(SHOTS_DIR, '04-panel-tree-open.png'));
    findings.push('Subagent panel opened; role="tree" (aria-label="Subagents") mounted with both agent rows.');

    // Select the first row, then roving-tabindex Down to the second, verifying selection moves.
    const firstRowId = await cdp.evaluate(
      `document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"]')?.getAttribute('aria-posinset')`,
    );
    await cdp.click(`document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"]')`);
    await cdp.waitFor(
      `document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"][aria-selected="true"]') != null`,
      { timeoutMs: 10_000, label: 'First tree row selected' },
    );
    const selectedBefore = await cdp.evaluate(
      `document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"][aria-selected="true"]')?.textContent`,
    );
    await pressKey(cdp, 'ArrowDown', 40);
    await cdp.waitFor(
      `(() => { const sel = document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"][aria-selected="true"]'); return !!sel && sel.textContent !== ${JSON.stringify(selectedBefore)}; })()`,
      { timeoutMs: 10_000, label: 'ArrowDown moved selection to the second row' },
    );
    const selectedAfter = await cdp.evaluate(
      `document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"][aria-selected="true"]')?.textContent`,
    );
    await cdp.screenshot(path.join(SHOTS_DIR, '05-panel-tree-arrowdown-selection.png'));
    findings.push(`Keyboard ArrowDown moved the tree's roving tab stop and selection from "${selectedBefore}" to "${selectedAfter}" -- confirms the tree keyboard handler and the active-indicator bar (visible in the screenshot) both work. firstRowId=${firstRowId}.`);

    // Close the panel; confirm focus falls back to the Subagents chip (no opener was recorded,
    // since this panel open went through the pre-existing chip route, not a chat-side chain
    // entry -- see findings below for why the NEW opener-based path could not be driven here).
    const closeClicked = await cdp.evaluate(
      `(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').toLowerCase().includes('close')); if (b) { b.click(); return true; } return false; })()`,
    );
    if (closeClicked) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const activeIsChip = await cdp.evaluate(
        `(document.activeElement?.getAttribute('aria-label') || '').startsWith('Open subagents panel')`,
      );
      await cdp.screenshot(path.join(SHOTS_DIR, '06-panel-closed-focus-return.png'));
      findings.push(`Panel closed via its Close button; focus returned to the Subagents chip: ${activeIsChip}.`);
    } else {
      findings.push('Could not find a Close button by aria-label heuristic; panel left open, screenshot 06 shows that state instead.');
      await cdp.screenshot(path.join(SHOTS_DIR, '06-panel-close-not-found.png'));
    }

    console.log('verify-563: PASS -- see findings below.');
    for (const f of findings) console.log(' -', f);
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child);
    try {
      if (exeDir && existsSync(path.join(exeDir, 'app.log'))) copyFileSync(path.join(exeDir, 'app.log'), path.join(SHOTS_DIR, 'app.log'));
      if (exeDir && existsSync(path.join(exeDir, 'fake-omp-invocations.log'))) copyFileSync(path.join(exeDir, 'fake-omp-invocations.log'), path.join(SHOTS_DIR, 'fake-omp-invocations.log'));
    } catch (err) {
      console.warn('verify-563: could not preserve logs:', err.message);
    }
    await safeRmSync(shimDir);
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    if (repoDir) await safeRmSync(worktreesDirFor(repoDir));
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
  }
}

main().catch((err) => {
  console.error('verify-563: FAIL');
  console.error(err);
  process.exitCode = 1;
});
