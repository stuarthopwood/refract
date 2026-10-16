#!/usr/bin/env node
// Live CDP check for issue #556 (zero-box sweep: NoticeRow's long-notice expansion, ChatPane's
// Start-failure details <pre>), required before the draft PR.
//
// Two independent phases against the SAME freshly built, freshly copied, sha256-pinned exe:
//
//   Phase A (fake omp, REFRACT_FAKE_OMP_SCENARIO=zero-box-556-long-notice): a scratch Session
//     whose one turn emits a `notice` frame over NoticeRow.tsx's 160-char LONG_NOTICE_CHARS
//     threshold -- deterministic, no model cost, no dependence on a real model ever choosing to
//     emit a long warning. Expands it and asserts the expanded body's own computed style carries
//     no background fill, no border and no border-radius (the box this story removes).
//
//   Phase B (fake omp, REFRACT_FAKE_OMP_SCENARIO=zero-box-556-start-failed): the Session's own
//     `OmpProcess` runs the fake-omp shim, which under this scenario never emits a `ready` frame
//     at all -- the renderer's own `READY_CEILING_MS` (180s) start-failure timeout then lands the
//     Session on stopReason `start-failed` with a real detail string. Expands "Details" and
//     asserts the same no-box properties on the `<pre>`, plus a real Tab-dispatched
//     keyboard-focus check that the focus ring (an inset box-shadow) lands clear of the text.
//
// Phase C (fake omp, default `session` scenario -- the real, recorded tool-approval turn the
//     same tape `verify-tauri.mjs`'s own `proveUs4` flow drives): renders a real approval card,
//     then stubs `window.refract.chat.answer` (a plain, never-frozen object assigned by
//     `tauri-bridge/entry.ts:16`) via `Runtime.evaluate` to return `{ ok: false, error }` the
//     next time it is called, and clicks Approve with a real CDP `Input.dispatchMouseEvent`
//     click. This drives the EXACT same React `setError`/render path a real `answer_request`
//     failure would, with no backend, process, or fake-omp engine change, and asserts the
//     resulting decision-card error Alert's computed style (no border/background/padding/
//     radius), the Fix 1 `OctagonXIcon` child, and `role="alert"`. This sidesteps the earlier,
//     genuinely-unreachable attempt below: killing the Session's own fake-omp child process to
//     force `SessionAgent::answer_request`'s `agent-not-running` error does NOT work, because
//     `agent/frame.rs:340`'s `handle_exit` calls `settle_turn_pending()` on EVERY process exit
//     (crash or otherwise), resolving any still-pending request to `Cancelled` before a click on
//     Approve can ever reach `answer_request` -- confirmed live in gate round 2 (the transcript
//     already read "...Cancelled" and the card had unmounted within the 3s window after the
//     kill). Only the approval-card site (`RequestCard.tsx:419`) is covered this way; the
//     generic question-card site (`RequestCard.tsx:586`) has no existing fixture that drives
//     `extension_ui_request` method `confirm`/`input` without a fake-omp engine change, so it
//     stays CODE-VERIFIED ONLY via `assertBundleMatchesStory556` below, same as the Ask-card
//     site (`AskCard.tsx:321`).
//
// None of the three phases spends a real model turn or touches Stuart's real omp profile/
// Sessions (REFRACT_DATA_DIR/REFRACT_IMPORT_SOURCE_DIR are scratch; all three phases run the
// fake-omp shim, no real `omp` process or profile is ever touched).
//
// NOT exercised live: the Subagents panel's own long-notice instance (`SubagentPanel.tsx:290`
// reuses the exact same `NoticeRow` component with no panel-specific className override --
// confirmed by reading the source, not by a separate live capture). Building a real per-subagent
// transcript stream containing a `notice` item is blocked on issue #712 (`subagent_lifecycle`
// not yet subscribed in this build, per `docs/PLAN.md`'s own #563 row), so the Subagents panel
// never receives live per-item subagent content to expand in the first place.

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
} from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
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

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function assertTrue(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

/** Compiles the native PATH shim (same source `verify-tauri.mjs`'s own `buildOmpShim` compiles;
 * not exported from that file, so this is a local copy of the same bare `rustc` call). */
function buildOmpShim(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-omp-shim.rs');
  const out = path.join(dir, 'omp.exe');
  const result = spawnSync('rustc', ['--edition', '2021', '-O', src, '-o', out], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`buildOmpShim: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

/** Ties the exe under test to this story's own commits: greps the just-built renderer bundle
 * (`out/tauri-web/assets/*.js`) for the two edited classNames (the NEW, unboxed strings) and
 * confirms the two OLD boxed strings are gone. Cheap, real proof this build really contains
 * #556's edit, independent of git-log reasoning about timing (same pattern #558/#570 use). */
function assertBundleMatchesStory556() {
  const assetsDir = path.join(REPO_ROOT, 'out', 'tauri-web', 'assets');
  const files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
  let combined = '';
  for (const f of files) combined += readFileSync(path.join(assetsDir, f), 'utf8');
  // Collapsed by esbuild/rollup's own minifier into one literal string per className prop, so a
  // plain substring match is exact -- no whitespace/ordering ambiguity to account for.
  assertTrue(combined.includes('max-h-60 overflow-y-auto text-xs whitespace-pre-wrap text-muted-foreground'), 'built bundle is missing NoticeRow.tsx\'s new unboxed expansion className');
  assertTrue(!combined.includes('max-h-60 overflow-y-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap text-muted-foreground'), 'built bundle still contains NoticeRow.tsx\'s OLD boxed expansion className');
  assertTrue(combined.includes('p-1 text-xs text-muted-foreground outline-none'), 'built bundle is missing ChatPane.tsx\'s new unboxed Start-failure-details className');
  assertTrue(!combined.includes('rounded-md bg-muted p-2 text-xs outline-none'), 'built bundle still contains ChatPane.tsx\'s OLD boxed Start-failure-details className');
  // Fix 1 (gate round 2, M1): the new `box="inline"` Alert variant's own className string
  // (`alert.tsx`'s `cva` config, a literal object value -- unaffected by JSX prop-name
  // minification, unlike asserting the call-site `box="inline"` prop text itself would be).
  // Gate round 2 (test reviewer): a single `.includes()` can't distinguish "the variant exists"
  // from "all three call sites actually reference it" -- a global occurrence count tied to the
  // three edited call sites (AskCard.tsx:321, RequestCard.tsx:419, RequestCard.tsx:586) is a
  // low-risk, minifier-agnostic proxy (exact-match split/count, not a fragile proximity scan of
  // minified output).
  const inlineAlertMarker = 'border-0 bg-transparent px-0 py-0 rounded-none';
  const inlineAlertCount = combined.split(inlineAlertMarker).length - 1;
  assertTrue(inlineAlertCount >= 3, `built bundle has the Fix 1 Alert box="inline" variant className only ${inlineAlertCount} time(s), expected >= 3 (one per call site)`);
  console.log('verify-556: bundle marker check PASS (new unboxed classNames present, old boxed classNames absent, Fix 1 inline Alert variant present).');
  return { inlineAlertCount };
}

async function pressTab(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
}

/** Reads the real computed style of the first element matching `finderExpr` -- never guesses
 * from class names. */
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
  const stamp = nowStamp();
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
    // Fix 3 (gate round 2, carried from round 1): capture AFTER the assertion passes, matching
    // b03's already-correct order, so a failing assertion can never be masked by a screenshot
    // that looks fine.
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
      // `--no-session` (the readiness probe's own scratch process) always forces `readiness`
      // regardless of this var, so readiness goes green normally; only the SESSION's own
      // `OmpProcess` -- spawned once "Create session" is clicked below -- reads this and never
      // emits `ready` at all, deterministically producing a real `start-failed` Session.
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

    // The fake `omp` never emits `ready` at all (zero-box-556-start-failed.jsonl): the real
    // Rust launch path runs out its own `READY_CEILING_MS` (180s, src-tauri/src/omp/process.rs)
    // before recording the start failure, so this wait is sized well above that ceiling.
    // `[data-pane-banner]` alone also matches `SessionStartNotice.tsx`'s own "Starting agent…"
    // notice (same attribute, a DIFFERENT element) -- `[role="alert"]` scopes to the real
    // failure `<Alert>` specifically (`alert.tsx`'s own `role="alert"`).
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
    // Fix 9 (gate round 2, capture-artifact finding): the sidebar can still show a stray hover
    // tooltip from the click above -- move the pointer to a dead corner and wait for it to
    // actually leave the DOM before shooting, same convention as `verify-tauri-559.mjs`.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 });
    await cdp.waitFor(`!document.querySelector('[data-slot="tooltip-content"]')`, { timeoutMs: 5_000, label: 'no tooltip showing before b02 screenshot' });

    const style = await readComputedBoxStyle(cdp, preFinder);
    log(`verify-556: Phase B details <pre> computed style: ${JSON.stringify(style)}`);
    assertNoBox(style, 'Phase B Start-failure-details <pre>');
    // Fix 3 (gate round 2 round-2, carried from round 1): the screenshot proves what the
    // assertion above already confirmed -- capture AFTER the assertion passes, not before, so
    // a failing assertion can never be masked by a screenshot that looks fine.
    await cdp.screenshot(path.join(SHOTS_DIR, 'b02-start-failed-details-expanded.png'));
    results.push({ name: 'Phase B: Start-failure details <pre> has no box (background/border/radius)', ok: true, detail: style });
    log('STEP PASS: Start-failure details <pre> carries no background fill, border, or border-radius.');

    // Real Tab-dispatched keyboard focus onto the details region: the details are ALREADY open
    // from the assertion above -- clicking the Details button again here would just toggle it
    // closed, hiding the `<pre>` before Tab could ever reach it. Positions focus on the Details
    // button itself via a direct `.focus()` call (never re-clicking it, so `detailsOpen` stays
    // true), then a real `Input.dispatchKeyEvent` Tab moves focus the rest of the way -- the
    // one thing this step actually proves.
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

/** Phase C (gate round 2, Fix 2): live-verifies the approval-card error Alert (Fix 1,
 * `RequestCard.tsx:419`) by renderer-side fault injection -- no process-kill, no backend or
 * fake-omp engine change. Reuses the default `session` fake-omp scenario verbatim (the same
 * tape `verify-tauri.mjs`'s own `proveUs4` flow drives): one streamed turn that raises a real
 * approval card and waits for `extension_ui_response`. */
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
      // No REFRACT_FAKE_OMP_SCENARIO: the Session's own OmpProcess falls back to the
      // genuinely-recorded `session` tape (one streamed turn, one real approval card).
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

    // Renderer-side fault injection (three independent gate-round-2 reviewers' route): stubs
    // the SAME `window.refract.chat.answer` the real Tauri IPC bridge installs at
    // `tauri-bridge/entry.ts:16` (`window.refract = refract`, a plain, never-frozen object), so
    // clicking Approve below drives the EXACT same React `setError`/render path a real
    // `answer_request` failure would -- no backend, process, or fake-omp engine change.
    await cdp.evaluate(
      `(() => { window.refract.chat.answer = async () => ({ ok: false, error: { code: 'prompt-failed', message: 'verify-556: synthetic answer failure' } }); return true; })()`,
    );

    // Real CDP `Input.dispatchMouseEvent` click (via `cdp.click`), not a DOM event dispatch.
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
    // Screenshot AFTER all assertions pass (Fix 3 convention, same reasoning as a02/b02/b03).
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
  console.log(`verify-556: git HEAD ${gitHeadSha}`);

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

  writeFileSync(path.join(SHOTS_DIR, 'report.log'), logLines.join('\n') + '\n');
  const report = {
    gitHead: gitHeadSha,
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
