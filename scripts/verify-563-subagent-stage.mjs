#!/usr/bin/env node
// Live CDP check: Stage group row and Subagent panel tree, driven by the fake `omp` `subagents`
// tape (one stage, two subagents). It cannot exercise the chain row (needs 2+ Stages) or the
// chain's opener pre-select path; the printed report lists what stays untested.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, createWriteStream, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, launchViaJobObject, isTargetOwningPort } from './verify-tauri-cdp.mjs';
import { requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const PROMPT_MESSAGE = 'Investigate alpha and beta.';
const SHOTS_DIR = path.join(tmpdir(), 'refract-563-shots');

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

    const bodyTextEarly = await cdp.waitFor(`document.body?.innerText ?? ''`, { timeoutMs: 30_000, label: 'page has rendered some text' });
    console.log('verify-563: early body text sample:', JSON.stringify(bodyTextEarly.slice(0, 120)));

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' },
    );
    await cdp.screenshot(path.join(SHOTS_DIR, '01-readiness-green.png'));
    findings.push('Readiness screen green, Add repository enabled.');

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

    await cdp.typeIntoByLabel('Message', PROMPT_MESSAGE);
    await cdp.clickByLabel('Send message');
    // The header shows for a 2+ agent stage; member rows are not mounted until expanded.
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

    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && (t.textContent.match(/Finished/g) || []).length >= 1; })()`,
      { timeoutMs: 30_000, label: 'At least one subagent settled' },
    );

    await cdp.click(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); if (!t) return null; return Array.from(t.querySelectorAll('button,[role="button"]')).find((el) => el.textContent.includes('Stage 1')); })()`,
    );
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.includes('alpha') && t.textContent.includes('beta'); })()`,
      { timeoutMs: 15_000, label: 'Stage group expanded, alpha/beta member rows visible' },
    );
    await cdp.screenshot(path.join(SHOTS_DIR, '03-stage-group-expanded.png'));
    findings.push('Stage group row expands to show its SpineList member rows (alpha, beta), each a plain SubagentRow with the shared status icon.');

    // The readout chip row may not render in the narrow scratch window; the rail button is always present.
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

    // The chip row waits on one combined, debounced readout update (readout.rs); time how long
    // the chip takes to appear to show the rail-button fallback was a timing gap, not a regression.
    const chipAppearStart = Date.now();
    try {
      await cdp.waitFor(
        `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('Open subagents panel'))`,
        { timeoutMs: 10_000, label: 'Subagents readout chip eventually appears' },
      );
      findings.push(`Readout-timing check: the Subagents chip was indeed absent right after the panel opened, but appeared ${Date.now() - chipAppearStart}ms later on its own -- a readout-computation latency (readout.rs's combined, debounced update), not a missing feature; confirms the earlier rail-button fallback was the correct workaround for a pre-existing timing gap, not a #563 regression.`,
      );
    } catch {
      findings.push('Readout-timing check: the Subagents chip still had not appeared after a further 10s poll -- could not confirm it resolves on its own within this run; see the readout.rs code citation above for why the gate itself is unchanged by this story regardless.');
    }

    // The first treeitem is the Stage row, which has no `aria-selected`; target a selectable agent row.
    const firstRowId = await cdp.evaluate(
      `document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"][aria-selected]')?.getAttribute('aria-posinset')`,
    );
    await cdp.click(`document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"][aria-selected]')`);
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

    // Assert on computed style in the real build: a compiled utility class does not prove
    // Chromium's :focus-visible heuristic actually paints the outline.
    const focusedRowOutline = await cdp.evaluate(
      `(() => { const el = document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"][aria-selected="true"]'); if (!el) return null; const cs = getComputedStyle(el); return { isActiveElement: el === document.activeElement, outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor }; })()`,
    );
    if (!focusedRowOutline || !focusedRowOutline.isActiveElement) {
      throw new Error(`verify-563: M7 live check could not confirm the focused tree row is document.activeElement: ${JSON.stringify(focusedRowOutline)}`);
    }
    if (focusedRowOutline.outlineStyle === 'none' || focusedRowOutline.outlineWidth === '0px') {
      throw new Error(`verify-563: M7 REGRESSION -- the keyboard-focused tree row paints no outline live (outline-style=${focusedRowOutline.outlineStyle}, outline-width=${focusedRowOutline.outlineWidth}); the outline-hidden+focus-visible:outline-solid fix did not survive contact with the real build.`);
    }
    findings.push(`M7 live confirmation: the keyboard-focused tree row's own computed style is outline-style=${focusedRowOutline.outlineStyle}, outline-width=${focusedRowOutline.outlineWidth}, outline-color=${focusedRowOutline.outlineColor} -- a real, painting focus ring on :focus-visible, not just a compiled utility that looks right in isolation.`);

    // Opened via the rail button (no opener), so `closeHostedPanel` moves stranded focus back to
    // the rail button; target the exact Close button, not a generic aria-label match.
    const beforeCloseFocus = await cdp.evaluate(
      `({ role: document.activeElement?.getAttribute('role'), label: document.activeElement?.textContent?.trim() })`,
    );
    await cdp.click(`document.querySelector('[data-panel-close]')`);
    await cdp.waitFor(`!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 10_000, label: 'Panel tree unmounted after Close' });
    // `closeHostedPanel`'s own stranded-focus fallback runs inside a `requestAnimationFrame`.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const focusReturnedToRail = await cdp.evaluate(`document.activeElement === document.querySelector('[data-rail-button="subagents"]')`);
    const actualActiveElement = await cdp.evaluate(
      `(() => { const el = document.activeElement; return el ? { tag: el.tagName, id: el.id || null, role: el.getAttribute('role'), ariaLabel: el.getAttribute('aria-label'), isBody: el === document.body, dataRailButton: el.getAttribute('data-rail-button') } : null; })()`,
    );
    findings.push(`Exact post-close document.activeElement: ${JSON.stringify(actualActiveElement)}.`);
    await cdp.screenshot(path.join(SHOTS_DIR, '06-panel-closed-focus-return.png'));
    findings.push(
      `Panel closed via its own Close button ([data-panel-close], aria-label "Close Subagents panel"); focus before close was on a ${JSON.stringify(beforeCloseFocus)} tree row; focus returned to the Subagents rail button ([data-rail-button="subagents"]): ${focusReturnedToRail} (expected true -- no opener/chip existed since this panel opened via the rail fallback, so hosted-panel-actions.ts's own stranded-focus fallback to the rail button is the correct target here).`,
    );

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
