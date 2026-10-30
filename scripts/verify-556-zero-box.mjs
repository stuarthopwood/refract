#!/usr/bin/env node
// Live CDP check that expanded notices, start-failure details and the approval-error Alert carry no
// background, border or radius. Runs three phases against one sha256-pinned exe with the fake omp
// shim and scratch data dirs, so no model cost and no real omp profile is touched.
//
// The approval-error phase stubs `window.refract.chat.answer` instead of killing omp:
// `handle_exit` settles pending requests to Cancelled before Approve can reach `answer_request`.
// Question and Ask cards stay code-verified only (no fixture drives them); the Subagents panel
// reuses NoticeRow and is blocked on #712.

import { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  getFreePort,
  waitForCdpTarget,
  CdpSession,
  launchViaJobObject,
  stopLauncher,
  isTargetOwningPort,
} from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  safeRmSync,
  assertExeUnchanged,
  citeScreenshots,
  clearKnownOutputFiles,
  sha256OfFile,
  requireSharedCargoTarget,
} from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_556_SHOTS_DIR || path.join(tmpdir(), `refract-556-zero-box-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const SHOT_NAMES = [
  'a01-long-notice-collapsed.png',
  'a02-long-notice-expanded.png',
  'b01-start-failed-banner.png',
  'b02-start-failed-details-expanded.png',
  'b03-start-failed-details-focus.png',
  'c01-approval-card-rendered.png',
  'c02-approval-card-error-alert.png',
];

function assertTrue(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

/** Local copy of the `rustc` PATH-shim build from `verify-tauri.mjs` (not exported there). */
function buildOmpShim(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-omp-shim.rs');
  const out = path.join(dir, 'omp.exe');
  const result = spawnSync('rustc', ['--edition', '2021', '-O', src, '-o', out], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`buildOmpShim: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

/** Greps the just-built renderer bundle for the new unboxed classNames and checks the old boxed ones
 * are gone. This only proves the bundle matches source; the live computed-style checks and
 * `assertExeUnchanged`'s sha256 pin catch a stale exe. */
function assertBundleMatchesStory556() {
  const assetsDir = path.join(REPO_ROOT, 'out', 'tauri-web', 'assets');
  const files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
  let combined = '';
  for (const f of files) combined += readFileSync(path.join(assetsDir, f), 'utf8');
  // The minifier emits one literal per className prop, so a substring match is exact.
  assertTrue(combined.includes('max-h-60 overflow-y-auto text-xs whitespace-pre-wrap text-muted-foreground'), 'built bundle is missing NoticeRow.tsx\'s new unboxed expansion className');
  assertTrue(!combined.includes('max-h-60 overflow-y-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap text-muted-foreground'), 'built bundle still contains NoticeRow.tsx\'s OLD boxed expansion className');
  assertTrue(combined.includes('p-1 text-xs text-muted-foreground outline-none'), 'built bundle is missing ChatPane.tsx\'s new unboxed Start-failure-details className');
  assertTrue(!combined.includes('rounded-md bg-muted p-2 text-xs outline-none'), 'built bundle still contains ChatPane.tsx\'s OLD boxed Start-failure-details className');
  // The `box.inline` cva string exists once in the bundle (call sites pass a prop, not a copy), so
  // check the literal in the bundle and `box="inline"` at each call site in source.
  const inlineAlertMarker = 'border-0 bg-transparent px-0 py-0 rounded-none';
  const inlineAlertCount = combined.split(inlineAlertMarker).length - 1;
  assertTrue(inlineAlertCount >= 1, `built bundle is missing the Fix 1 Alert box="inline" variant className (${inlineAlertMarker})`);
  const callSites = [
    { file: 'src/renderer/features/chat/AskCard.tsx', line: 321 },
    { file: 'src/renderer/features/chat/RequestCard.tsx', line: 419 },
    { file: 'src/renderer/features/chat/RequestCard.tsx', line: 586 },
  ];
  for (const { file, line } of callSites) {
    const src = readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n');
    assertTrue(
      /box="inline"/.test(src[line - 1] ?? ''),
      `${file}:${line} is missing box="inline" on its Alert call site`
    );
  }
  console.log('verify-556: bundle marker check PASS (new unboxed classNames present, old boxed classNames absent, Fix 1 inline Alert variant present).');
  return { inlineAlertCount };
}

async function pressTab(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
}

/** Reads the real computed style, never guessing from class names. */
async function readComputedBoxStyle(cdp, finderExpr) {
  return cdp.evaluate(
    `(() => { const el = ${finderExpr}; if (!el) return null; const s = getComputedStyle(el); return { backgroundColor: s.backgroundColor, borderTopWidth: s.borderTopWidth, borderRadius: s.borderRadius }; })()`,
  );
}

function assertNoBox(style, label) {
  assertTrue(!!style, `${label}: element not found`);
  assertTrue(
    style.backgroundColor === 'rgba(0, 0, 0, 0)' || style.backgroundColor === 'transparent',
    `${label}: expected no background fill, got backgroundColor=${style.backgroundColor}`,
  );
  assertTrue(style.borderTopWidth === '0px', `${label}: expected no border, got borderTopWidth=${style.borderTopWidth}`);
  assertTrue(style.borderRadius === '0px', `${label}: expected no border-radius, got borderRadius=${style.borderRadius}`);
}

async function runPhaseA({ exePath, exeHash, launcherExe, log, results }) {
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-556-a-shim-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-556-a-data-'));
  const repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-556-a-repo-')), 'verify-556a');
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-556-a-import-'));
  const pidFile = path.join(shimDir, 'target.pid');
  let child, cdp;
  try {
    const port = await getFreePort();
    buildOmpShim(shimDir);
    const env = {
      ...process.env,
      PATH: `${shimDir};${process.env.PATH}`,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: path.join(shimDir, 'webview2-data'),
      REFRACT_DATA_DIR: dataDir,
      REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      REFRACT_FAKE_OMP_SCENARIO: 'zero-box-556-long-notice',
    };
    mkdirSync(env.WEBVIEW2_USER_DATA_FOLDER, { recursive: true });
    const launched = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: shimDir, env });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    assertTrue(isTargetOwningPort(port, launched.targetPid), 'Phase A: CDP target is not owned by the process this run launched');
    assertExeUnchanged(exePath, exeHash, 'Phase A', 'verify-556');

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Phase A: readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Phase A: readiness green' },
    );
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Phase A: Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Phase A: repository added' },
    );
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'Phase A: New session dialog ready' },
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'Phase A: dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Phase A: composer enabled' });

    await cdp.typeIntoByLabel('Message', 'Please respond now.');
    await cdp.clickByLabel('Send message');

    const NOTICE_FINDER =
      `Array.from(document.querySelectorAll('[aria-label="Transcript"] button[aria-expanded]')).find((el) => el.textContent.includes('Zero-box sweep live check'))`;
    await cdp.waitFor(`!!(${NOTICE_FINDER})`, { timeoutMs: 30_000, label: 'Phase A: long-notice row rendered' });
    await cdp.screenshot(path.join(SHOTS_DIR, 'a01-long-notice-collapsed.png'));
    log('STEP PASS: long notice row rendered (collapsed).');

    await cdp.click(NOTICE_FINDER);
    await cdp.waitFor(`(${NOTICE_FINDER}).getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'Phase A: long notice expanded' });
    const expandedBodyFinder = `(${NOTICE_FINDER}).closest('[data-slot="collapsible"]')?.querySelector('[data-slot="collapsible-content"] div')`;
    await cdp.waitFor(`!!(${expandedBodyFinder})`, { timeoutMs: 10_000, label: 'Phase A: expanded body mounted' });

    const style = await readComputedBoxStyle(cdp, expandedBodyFinder);
    log(`verify-556: Phase A expanded-body computed style: ${JSON.stringify(style)}`);
    assertNoBox(style, 'Phase A long-notice expanded body');
    await cdp.screenshot(path.join(SHOTS_DIR, 'a02-long-notice-expanded.png'));
    results.push({ name: 'Phase A: long-notice expanded body has no box (background/border/radius)', ok: true, detail: style });
    log('STEP PASS: long-notice expanded body carries no background fill, border, or border-radius.');
  } catch (err) {
    results.push({ name: 'Phase A', ok: false, detail: String(err?.stack || err) });
    throw err;
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child);
    await safeRmSync(shimDir, 'verify-556');
    await safeRmSync(dataDir, 'verify-556');
    await safeRmSync(path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir)), 'verify-556');
    await safeRmSync(repoDir, 'verify-556');
    await safeRmSync(importSourceDir, 'verify-556');
  }
}

async function runPhaseB({ exePath, exeHash, launcherExe, log, results }) {
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-556-b-shim-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-556-b-data-'));
  const repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-556-b-repo-')), 'verify-556b');
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-556-b-import-'));
  const pidFile = path.join(shimDir, 'target.pid');
  let child, cdp;
  try {
    const port = await getFreePort();
    buildOmpShim(shimDir);
    const env = {
      ...process.env,
      PATH: `${shimDir};${process.env.PATH}`,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: path.join(shimDir, 'webview2-data'),
      REFRACT_DATA_DIR: dataDir,
      REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      // The readiness probe (`--no-session`) ignores this var; only the Session's OmpProcess reads it.
      REFRACT_FAKE_OMP_SCENARIO: 'zero-box-556-start-failed',
    };
    mkdirSync(env.WEBVIEW2_USER_DATA_FOLDER, { recursive: true });
    const launched = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: shimDir, env });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    assertTrue(isTargetOwningPort(port, launched.targetPid), 'Phase B: CDP target is not owned by the process this run launched');
    assertExeUnchanged(exePath, exeHash, 'Phase B', 'verify-556');

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Phase B: readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Phase B: readiness green' },
    );
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Phase B: Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Phase B: repository added' },
    );
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'Phase B: New session dialog ready' },
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'Phase B: dialog closed' });

    // The wait must exceed READY_CEILING_MS (180s). `[role="alert"]` scopes to the failure Alert;
    // `[data-pane-banner]` also matches the "Starting agent…" notice.
    const alertFinder = `document.querySelector('[data-pane-banner] [role="alert"]')`;
    await cdp.waitFor(`!!(${alertFinder})`, { timeoutMs: 200_000, label: 'Phase B: start-failed banner rendered' });
    const bannerTitle = await cdp.evaluate(`(${alertFinder})?.textContent ?? ''`);
    log(`verify-556: Phase B banner text: ${JSON.stringify(bannerTitle)}`);
    await cdp.screenshot(path.join(SHOTS_DIR, 'b01-start-failed-banner.png'));

    const detailsButtonFinder = `Array.from(document.querySelectorAll('[data-pane-banner] button')).find((el) => el.textContent.trim() === 'Details')`;
    await cdp.waitFor(`!!(${detailsButtonFinder})`, { timeoutMs: 15_000, label: 'Phase B: Details toggle present (startFailureDetails non-empty)' });
    await cdp.click(detailsButtonFinder);
    const preFinder = `document.querySelector('[data-pane-banner] pre[aria-label="Start failure details"]')`;
    await cdp.waitFor(`!(${preFinder}).hidden`, { timeoutMs: 10_000, label: 'Phase B: details expanded' });
    // A stray hover tooltip from the click would taint the screenshot.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
    await cdp.waitFor(`!document.querySelector('[data-slot="tooltip-content"]')`, { timeoutMs: 5_000, label: 'no tooltip showing before b02 screenshot' });

    const style = await readComputedBoxStyle(cdp, preFinder);
    log(`verify-556: Phase B details <pre> computed style: ${JSON.stringify(style)}`);
    assertNoBox(style, 'Phase B Start-failure-details <pre>');
    await cdp.screenshot(path.join(SHOTS_DIR, 'b02-start-failed-details-expanded.png'));
    results.push({ name: 'Phase B: Start-failure details <pre> has no box (background/border/radius)', ok: true, detail: style });
    log('STEP PASS: Start-failure details <pre> carries no background fill, border, or border-radius.');

    // The details are already open; clicking Details again would close them, so focus the button directly, then Tab.
    await cdp.evaluate(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
    const preFocusStyle = await cdp.evaluate(
      `(() => { const el = (${preFinder}); const s = getComputedStyle(el); return { boxShadow: s.boxShadow }; })()`,
    );
    log(`verify-556: Phase B details <pre> boxShadow before focus: ${JSON.stringify(preFocusStyle)}`);
    assertTrue(preFocusStyle.boxShadow === 'none', `expected no inset ring before focus, got boxShadow=${preFocusStyle.boxShadow}`);
    await cdp.evaluate(`(${detailsButtonFinder}).focus()`);
    await pressTab(cdp);
    await cdp.waitFor(`document.activeElement === (${preFinder})`, { timeoutMs: 5_000, label: 'Phase B: Tab moved focus onto the details region' });
    const focusStyle = await cdp.evaluate(
      `(() => { const el = (${preFinder}); const s = getComputedStyle(el); return { boxShadow: s.boxShadow, paddingLeft: s.paddingLeft, paddingTop: s.paddingTop }; })()`,
    );
    log(`verify-556: Phase B focused details <pre> style: ${JSON.stringify(focusStyle)}`);
    assertTrue(focusStyle.boxShadow !== 'none' && focusStyle.boxShadow.includes('inset'), `expected a real inset focus ring (box-shadow), got boxShadow=${focusStyle.boxShadow}`);
    assertTrue(parseFloat(focusStyle.paddingLeft) >= 3 && parseFloat(focusStyle.paddingTop) >= 3, `expected the p-1 padding to keep the 2px inset ring clear of the text (>= 3px clearance), got ${JSON.stringify(focusStyle)}`);
    await cdp.screenshot(path.join(SHOTS_DIR, 'b03-start-failed-details-focus.png'));
    results.push({ name: 'Phase B: keyboard focus on details region shows a real, text-clear focus ring', ok: true, detail: focusStyle });
    log('STEP PASS: real Tab-dispatched keyboard focus lands on the details region with a visible inset box-shadow ring, clear of the text.');
  } catch (err) {
    results.push({ name: 'Phase B', ok: false, detail: String(err?.stack || err) });
    throw err;
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child);
    await safeRmSync(shimDir, 'verify-556');
    await safeRmSync(dataDir, 'verify-556');
    await safeRmSync(path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir)), 'verify-556');
    await safeRmSync(repoDir, 'verify-556');
    await safeRmSync(importSourceDir, 'verify-556');
  }
}

/** Phase C: approval-card error Alert via renderer-side fault injection on the default `session` tape. */
async function runPhaseC({ exePath, exeHash, launcherExe, log, results }) {
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-556-c-shim-'));
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-556-c-data-'));
  const repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-556-c-repo-')), 'verify-556c');
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-556-c-import-'));
  const pidFile = path.join(shimDir, 'target.pid');
  let child, cdp;
  try {
    const port = await getFreePort();
    buildOmpShim(shimDir);
    const env = {
      ...process.env,
      PATH: `${shimDir};${process.env.PATH}`,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: path.join(shimDir, 'webview2-data'),
      REFRACT_DATA_DIR: dataDir,
      REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      // No scenario: the Session falls back to the recorded `session` tape (one approval card).
    };
    mkdirSync(env.WEBVIEW2_USER_DATA_FOLDER, { recursive: true });
    const launched = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: shimDir, env });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    assertTrue(isTargetOwningPort(port, launched.targetPid), 'Phase C: CDP target is not owned by the process this run launched');
    assertExeUnchanged(exePath, exeHash, 'Phase C', 'verify-556');

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Phase C: readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Phase C: readiness green' },
    );
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Phase C: Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Phase C: repository added' },
    );
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'Phase C: New session dialog ready' },
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'Phase C: dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Phase C: composer enabled' });

    await cdp.typeIntoByLabel('Message', 'Please respond now.');
    await cdp.clickByLabel('Send message');
    const approveButtonFinder = `Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`;
    await cdp.waitFor(`!!(${approveButtonFinder})`, { timeoutMs: 30_000, label: 'Phase C: approval card rendered' });
    await cdp.screenshot(path.join(SHOTS_DIR, 'c01-approval-card-rendered.png'));
    log('STEP PASS: approval card rendered.');

    // `window.refract` is a plain, unfrozen object, so stubbing `chat.answer` drives the same
    // `setError` path as a real `answer_request` failure.
    await cdp.evaluate(
      `(() => { window.refract.chat.answer = async () => ({ ok: false, error: { code: 'prompt-failed', message: 'verify-556: synthetic answer failure' } }); return true; })()`,
    );

    await cdp.click(approveButtonFinder);

    const cardAlertFinder = `Array.from(document.querySelectorAll('[data-slot="card"] [data-slot="alert"]')).find((el) => el.textContent.includes('verify-556: synthetic answer failure'))`;
    await cdp.waitFor(`!!(${cardAlertFinder})`, { timeoutMs: 15_000, label: 'Phase C: decision-card error Alert rendered' });

    const style = await cdp.evaluate(
      `(() => { const el = (${cardAlertFinder}); const s = getComputedStyle(el); return { borderTopWidth: s.borderTopWidth, backgroundColor: s.backgroundColor, paddingTop: s.paddingTop, paddingLeft: s.paddingLeft, borderRadius: s.borderRadius, hasIconSvg: !!el.querySelector('svg'), role: el.getAttribute('role') }; })()`,
    );
    log(`verify-556: Phase C decision-card error Alert computed style: ${JSON.stringify(style)}`);
    assertTrue(style.borderTopWidth === '0px', `Phase C decision-card error Alert: expected no border, got borderTopWidth=${style.borderTopWidth}`);
    assertTrue(style.backgroundColor === 'rgba(0, 0, 0, 0)' || style.backgroundColor === 'transparent', `Phase C decision-card error Alert: expected no background fill, got backgroundColor=${style.backgroundColor}`);
    assertTrue(style.paddingTop === '0px', `Phase C decision-card error Alert: expected no top padding, got paddingTop=${style.paddingTop}`);
    assertTrue(style.paddingLeft === '0px', `Phase C decision-card error Alert: expected no left padding, got paddingLeft=${style.paddingLeft}`);
    assertTrue(style.borderRadius === '0px', `Phase C decision-card error Alert: expected no border-radius, got borderRadius=${style.borderRadius}`);
    assertTrue(style.hasIconSvg, 'Phase C decision-card error Alert: expected the Fix 1 OctagonXIcon svg as a child');
    assertTrue(style.role === 'alert', 'Phase C decision-card error Alert: expected role="alert"');
    results.push({ name: 'Phase C: approval-card error Alert is unboxed, carries the Fix 1 icon, and role="alert" (live, renderer-stubbed answer failure)', ok: true, detail: style });
    log('STEP PASS: approval-card error Alert carries no background fill, border, border-radius or padding, has the Fix 1 icon, and role="alert".');
    await cdp.screenshot(path.join(SHOTS_DIR, 'c02-approval-card-error-alert.png'));
  } catch (err) {
    results.push({ name: 'Phase C', ok: false, detail: String(err?.stack || err) });
    throw err;
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child);
    await safeRmSync(shimDir, 'verify-556');
    await safeRmSync(dataDir, 'verify-556');
    await safeRmSync(path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir)), 'verify-556');
    await safeRmSync(repoDir, 'verify-556');
    await safeRmSync(importSourceDir, 'verify-556');
  }
}


async function main() {
  clearKnownOutputFiles(SHOTS_DIR, 'refract-556-zero-box-shots', SHOT_NAMES);
  const gitHeadSha = gitHead(REPO_ROOT);
  const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
  const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : [];
  console.log(`verify-556: git HEAD ${gitHeadSha}${dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);

  const buildDir = mkdtempSync(path.join(tmpdir(), 'refract-556-build-'));
  const launcherExe = buildLauncher(buildDir);
  const { dest: exePath, hash: exeHash } = buildAndCopyExeFresh(buildDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-556' });
  console.log(`verify-556: exe copied to ${exePath}, sha256 ${exeHash}`);
  const bundleMarkers = assertBundleMatchesStory556();

  const logPath = path.join(SHOTS_DIR, 'report.log');
  const logLines = [];
  const log = (line) => {
    console.log(line);
    logLines.push(line);
  };

  const results = [];
  let passed = true;
  try {
    await runPhaseA({ exePath, exeHash, launcherExe, log, results });
  } catch (err) {
    passed = false;
    console.error('verify-556: Phase A FAILED:', err);
  }
  try {
    await runPhaseB({ exePath, exeHash, launcherExe, log, results });
  } catch (err) {
    passed = false;
    console.error('verify-556: Phase B FAILED:', err);
  }
  try {
    await runPhaseC({ exePath, exeHash, launcherExe, log, results });
  } catch (err) {
    passed = false;
    console.error('verify-556: Phase C FAILED:', err);
  }

  writeFileSync(logPath, logLines.join('\n') + '\n');
  const report = {
    gitHead: gitHeadSha,
    dirty: dirtyLines.length ? dirtyLines : false,
    exeSha256: exeHash,
    scriptSha256: sha256OfFile(fileURLToPath(import.meta.url)),
    exitCode: passed ? 0 : 1,
    bundleInlineAlertCount: bundleMarkers.inlineAlertCount,
    results,
    screenshots: citeScreenshots(SHOTS_DIR, SHOT_NAMES.filter((n) => existsSync(path.join(SHOTS_DIR, n)))),
  };
  writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`verify-556: evidence written to ${SHOTS_DIR}`);
  await safeRmSync(buildDir, 'verify-556');
  if (!passed) process.exit(1);
  console.log('verify-556: PASS (Phases A, B, C; the question-card site RequestCard.tsx:586 and the Ask-card site AskCard.tsx:321 stay code-verified only, see assertBundleMatchesStory556).');
}

main().catch((err) => {
  console.error('verify-556: FATAL:', err);
  process.exit(1);
});
