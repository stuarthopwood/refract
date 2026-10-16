#!/usr/bin/env node
// Quiet alert rows live check (issue #560) against the scratch Tauri debug build. Reuses the
// shared CDP primitives (verify-tauri-cdp.mjs) and session-list driving helpers
// (verify-tauri-session-list-helpers.mjs) the #559/#735/#567 scripts already established; adds
// only what is new here -- the two alert rows themselves, the Memory Triage dialog, and the
// Health Check dialog reached from the alert row (distinct from the Settings-screen entry).
//
// Proves, against the real rendered DOM (CDP Accessibility domain for accessible names, never
// textContent for a name):
//   - Both alert rows appear once a repository exists: "Low memory" (forced by
//     REFRACT_FORCE_LOW_MEMORY=1, a pre-existing debug-only test knob in memory.rs -- this
//     script never touches memory.rs) and "omp 18.10.1: unverified version" (the fake-omp
//     shim's hardcoded --version answer, which readiness.rs's own documented rule already
//     treats as a warning: at or above 18.6.3 but outside the specifically re-probed 18.8.x
//     range).
//   - Every interactive control's accessible name (Open memory triage/Open Health check/both
//     Dismiss buttons), proven as a side effect of a real keyboard-only Tab walk from the
//     profile item's own name button through the cog, through both alert rows -- Enter
//     activates the Check button instead of a mouse click for that one step.
//   - That Enter activation opens the REAL HealthCheckDialog (distinct instance from the one
//     ProfileItem's own menu already reaches -- both just mount the same component): it shows
//     a visible "Passed with a warning" state word on the omp row, Done closes it, and focus
//     returns to the alert row's own Check button (not the Settings cog, not <body>).
//   - Memory Triage: lists only idle Sessions, never one still mid-attach/working. A per-row
//     Stop asks "Stop {name}'s agent?", confirms, and the Session's own status flips to
//     'stopped' (proven via window.refract.sessions.list(), not just the dialog's own DOM).
//     A second idle Session plus the bulk "Stop idle" action asks "Stop {N} idle agents?" with
//     the real count, stops every listed Session, and the dialog falls back to "No idle agents
//     to stop right now."
//   - Dismissing either alert row is immediate, LOCAL-ONLY state (never persisted): the
//     low-memory row's dismissal survives a second real memory-sampler tick (~6s) even though
//     REFRACT_FORCE_LOW_MEMORY=1 keeps the underlying condition true the whole run.
//
// Isolation (refract-tauri-live-check-isolation skill): same pattern as verify-tauri-559.mjs.
// Uses the already-frozen exe named by REFRACT_560_FROZEN_EXE (default: the path this story's
// build step froze to) rather than rebuilding, UNLESS this worktree's HEAD has moved past the
// commit that exe was built from, or the frozen file's own hash no longer matches what was
// recorded at freeze time -- either one falls back to a fresh `pnpm tauri build --debug
// --no-bundle` via the shared `buildAndCopyExeFresh` helper instead of silently trusting a
// stale or foreign exe.

import { mkdtempSync, mkdirSync, copyFileSync, existsSync, createWriteStream, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  getFreePort,
  waitForCdpTarget,
  CdpSession,
  stopLauncher,
  launchViaJobObject,
  isTargetOwningPort,
  assertExeMatchesProcess,
  createReportLogger,
  sleep
} from './verify-tauri-cdp.mjs';
import {
  getActiveElementAccessibleName,
  pressTab,
  pressEscape,
  groupTriggerFinder,
  createSessionViaQuickCreate,
  addRepository,
  openSettingsAndReturn
} from './verify-tauri-session-list-helpers.mjs';
import {
  gitHead,
  sha256OfFile,
  buildLauncher,
  makeScratchRepo,
  safeRmSync,
  citeScreenshots,
  clearKnownOutputFiles,
  buildAndCopyExeFresh
} from './verify-tauri-scratch-helpers.mjs';


// Item 6 (gate round 2, MEDIUM): throws immediately, before anything else in this script runs,
// unless CARGO_TARGET_DIR is set AND resolves to exactly the one shared cargo target dir this
// machine uses for Refract builds -- never a silent fallback to `src-tauri/target` (that
// fallback already filled this session's disk once, building a SECOND full target tree
// alongside the real one).
const REQUIRED_CARGO_TARGET_DIR = 'C:/Users/shopwood/.cargo-target/refract';
function normalizeDirForComparison(dir) {
  return path.resolve(dir).replace(/\\/g, '/').toLowerCase();
}
if (!process.env.CARGO_TARGET_DIR || normalizeDirForComparison(process.env.CARGO_TARGET_DIR) !== normalizeDirForComparison(REQUIRED_CARGO_TARGET_DIR)) {
  throw new Error(
    `verify-tauri-560: CARGO_TARGET_DIR must be set and resolve to exactly ${REQUIRED_CARGO_TARGET_DIR} (got ${JSON.stringify(process.env.CARGO_TARGET_DIR ?? null)}) -- refusing to silently fall back to src-tauri/target, which already filled this session's disk once.`
  );
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
const SHOT_DIR = process.env.REFRACT_560_SHOT_DIR || path.join(tmpdir(), 'refract-560-shots');

// This story's own frozen copy (recorded at freeze time, round 1: built from HEAD
// f3014aeb89ee74ddeab90fd08e3823c8675a4d4a). No frozen exe is currently trustworthy: TWO more
// commits of real, app-behaviour-changing fixes (f3014ae's own round-1 remediation was the
// commit that exe was frozen from, plus round-2's 96b662f on top of it, plus the current
// uncommitted round-2 remediation) have landed since that freeze, none of them exercised by any
// frozen copy -- `FROZEN_EXE_EXPECTED_GIT_HEAD` is deliberately an impossible value so
// `resolveExe` below always falls through to a fresh `buildAndCopyExeFresh` rebuild rather than
// silently reusing a stale binary that predates these fixes.
const FROZEN_EXE_DEFAULT = 'C:/Users/shopwood/AppData/Local/Temp/refract-560-scratch/refract-tauri-560.exe';
const FROZEN_EXE_EXPECTED_GIT_HEAD = 'NO-TRUSTWORTHY-FROZEN-EXE-REBUILD-REQUIRED';
const FROZEN_EXE_EXPECTED_HASH = 'NO-TRUSTWORTHY-FROZEN-EXE-REBUILD-REQUIRED';

// ---- Finders (JS expressions evaluated in the renderer; same `expr-string` convention every
// other verify-tauri-*.mjs script uses, never a literal CSS-only selector when text/role
// matching is needed). ----
const PROFILE_NAME_BUTTON = `document.querySelector('[data-profile-name-button]')`;
const TRIAGE_BUTTON = `document.querySelector('[aria-label="Open memory triage"]')`;
const DISMISS_MEMORY_BUTTON = `document.querySelector('[aria-label="Dismiss low memory alert"]')`;
const DISMISS_OMPVERSION_BUTTON = `document.querySelector('[aria-label="Dismiss unverified version alert"]')`;
// Item 12 (gate round 2): the row no longer states a Session count (`warning.liveAgents`
// counts every non-stopped agent, not just the idle ones Triage lists, so stating a number here
// implied a 1:1 match with Triage's own list that was never guaranteed) -- just "Low memory".
const LOW_MEMORY_ROW_SPAN = `Array.from(document.querySelectorAll('span')).find((el) => el.textContent.trim() === 'Low memory')`;
const OMPVERSION_ROW_SPAN = `Array.from(document.querySelectorAll('span')).find((el) => el.textContent.trim() === 'omp 18.10.1: unverified version')`;
const DIALOG = `document.querySelector('[role="dialog"]')`;
const ALERT_DIALOG = `document.querySelector('[role="alertdialog"]')`;
const DIALOG_TITLE = `document.querySelector('[data-slot="dialog-title"]')`;
const ALERT_DIALOG_TITLE = `document.querySelector('[data-slot="alert-dialog-title"]')`;
const HEALTH_LIST = `document.querySelector('[aria-label="Health checks"]')`;
const OMP_CHECK_ROW = `Array.from((${HEALTH_LIST})?.querySelectorAll('li') ?? []).find((li) => li.textContent.includes('OMP found'))`;
// The app-level `useChatAreaAnnouncer` region (App.tsx's single global `aria-live="polite"`
// region) -- distinct from any dialog-local live region, same finder convention
// verify-tauri-559.mjs's own `CHAT_AREA_ANNOUNCE_REGION` already established.
const CHAT_AREA_ANNOUNCE_REGION = `document.querySelector('[aria-live="polite"]')`;

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

function buildOmpShim(dir) {
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'omp.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', out]);
  if (result.status !== 0) throw new Error(`buildOmpShim: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

/** Same freeze-and-reuse posture as verify-tauri-559.mjs's own `copyBuiltExe`, but refuses (and
 * tells the caller to rebuild) rather than silently falling back to a shared `BUILD_OUTPUT_DIR`
 * exe that a DIFFERENT, concurrently-running lane may be mid-rebuild of -- confirmed live in
 * this exact run (`cargo`/`rustc`/`link` processes observed running, not started by this
 * script) that the shared target dir is not a safe fallback source right now. */
function resolveExe(destDir) {
  const gitHeadValue = gitHead(REPO_ROOT);
  const frozenSrc = process.env.REFRACT_560_FROZEN_EXE || FROZEN_EXE_DEFAULT;
  const frozenUsable = gitHeadValue === FROZEN_EXE_EXPECTED_GIT_HEAD && existsSync(frozenSrc) && sha256OfFile(frozenSrc).toLowerCase() === FROZEN_EXE_EXPECTED_HASH;
  if (frozenUsable) {
    mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, 'refract-tauri.exe');
    const buildTime = statSync(frozenSrc).mtime.toISOString();
    copyFileSync(frozenSrc, dest);
    const hash = sha256OfFile(dest);
    console.log(`verify-tauri-560: HEAD still ${gitHeadValue} and frozen exe hash still matches -- reusing ${frozenSrc} (copied sha256 ${hash})`);
    return { dest, hash, buildTime, gitHeadValue, rebuilt: false };
  }
  console.log(`verify-tauri-560: frozen exe no longer usable (HEAD ${gitHeadValue}, expected ${FROZEN_EXE_EXPECTED_GIT_HEAD}, frozen file ${existsSync(frozenSrc) ? 'present' : 'MISSING'}) -- rebuilding fresh.`);
  const { dest, hash } = buildAndCopyExeFresh(destDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-tauri-560' });
  return { dest, hash, buildTime: statSync(dest).mtime.toISOString(), gitHeadValue, rebuilt: true };
}

async function launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, pathPrepend, extraEnv = {}, logFile }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const webview2DataDir = path.join(path.dirname(exePath), `webview2-data-${stamp}`);
  mkdirSync(webview2DataDir, { recursive: true });
  const pidFile = path.join(path.dirname(exePath), `target-${stamp}.pid`);
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
    ...extraEnv
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

function worktreesDirFor(repoDir) {
  return path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
}

async function connectCdp(port, targetPid) {
  const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
  const cdp = await CdpSession.connect(wsUrl);
  if (!isTargetOwningPort(port, targetPid)) {
    throw new Error(`verify-tauri-560: CDP target on port ${port} is not owned by this run's own process (pid ${targetPid}) -- refusing to drive it`);
  }
  return cdp;
}

async function addRepositoryDiag(cdp, dir, evidenceDir, log) {
  try {
    await addRepository(cdp, dir);
  } catch (err) {
    const diag = await cdp.evaluate(
      `(() => ({ dialogPresent: !!document.querySelector('[role="dialog"]'), dialogInputValue: document.querySelector('[role="dialog"] input')?.value ?? null, dialogButtons: Array.from(document.querySelectorAll('[role="dialog"] button')).map((b) => b.textContent.trim()), activeElement: document.activeElement?.tagName }))()`
    );
    log(`verify-tauri-560: addRepository FAILED -- diagnostics: ${JSON.stringify(diag, null, 2)}`);
    await cdp.screenshot(path.join(evidenceDir, '99-diag-add-repository-failure.png'));
    throw err;
  }
}

/** Combines `CdpSession.pressEnter()`'s own `text`/`unmodifiedText` fields (needed for a native
 * default button-activation action to fire) with `pressKey`'s explicit `key`/`code` (needed for
 * Chromium to treat it as the real key per that helper's own doc comment) -- round 1 of this
 * script used `pressKey` alone (no text fields) and Enter moved focus nowhere, confirmed live:
 * the HealthCheckDialog never opened. */
async function pressRealEnter(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
}

/** `getAccessibleNameAndRole` reads `nodes[0]`'s own `name`, which is reliable for a WIDGET
 * (a button with an `aria-label`) but not for a plain text-content `<span>`: Chromium's AX tree
 * computes "name" on the role the text is naturally exposed through, often nested leaves under
 * the requested node rather than on the node itself. Round 1 used `fetchRelatives: true` and
 * scanned every returned node for the first non-null name, which actually made things WORSE,
 * confirmed live: that also pulls in ANCESTORS (up to the document root), so the first hit was
 * the document title ("Refract"), not the span. Round 2 fixed that by fetching only the exact
 * node's own DIRECT children via `Accessibility.getChildAXNodes`, but then returned just the
 * FIRST child's name -- still wrong, confirmed live again: `Low memory ({warning.liveAgents}
 * agents)` is JSX with an interpolated expression between two string literals, which React
 * renders as THREE separate sibling text nodes (`"Low memory ("`, the number, `" agents)"`),
 * each its own leaf AX node -- the first child alone is a truncated fragment. Concatenates
 * every direct child's own name in DOM order instead of stopping at the first. */
async function axText(cdp, selectorExpr) {
  await cdp.send('Accessibility.enable');
  const evalResult = await cdp.send('Runtime.evaluate', { expression: selectorExpr, returnByValue: false });
  const objectId = evalResult.result?.objectId;
  if (!objectId) return null;
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { objectId, fetchRelatives: false });
  const target = nodes?.[0];
  if (!target) return null;
  if (target.name?.value) return target.name.value;
  if (!target.nodeId) return null;
  const { nodes: children } = await cdp.send('Accessibility.getChildAXNodes', { id: target.nodeId });
  const names = (children ?? []).map((child) => child.name?.value).filter((value) => value != null);
  return names.length > 0 ? names.join('') : null;
}

/** Polls `textExpr` every `intervalMs` while `aliveExpr` stays true, collecting EVERY sampled
 * value -- not just the first or the last -- so a title/description that goes blank partway
 * through a Radix exit animation (the DOM node stays mounted for the animation's duration
 * before unmounting) is caught even though both endpoints look fine. Checks `aliveExpr` BEFORE
 * each text read (round 1 of this helper sampled text unconditionally then checked `aliveExpr`
 * after, so the loop's own final iteration -- taken the instant the container had already
 * unmounted -- always recorded a trailing `null`, confirmed live: that is this helper sampling
 * its own teardown, not the app going blank, and does not belong in the returned samples).
 * Returns once `aliveExpr` goes false or `timeoutMs` elapses. */
async function sampleWhileAlive(cdp, textExpr, aliveExpr, { intervalMs = 20, timeoutMs = 5_000 } = {}) {
  const samples = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await cdp.evaluate(aliveExpr))) break;
    samples.push(await cdp.evaluate(`${textExpr} ?? null`));
    await sleep(intervalMs);
  }
  return samples;
}

async function waitForSessionStatus(cdp, sessionId, status, { timeoutMs = 60_000 } = {}) {
  await cdp.waitFor(
    `window.refract.sessions.list().then((r) => r.ok && r.value.find((s) => s.id === ${JSON.stringify(sessionId)})?.status === ${JSON.stringify(status)})`,
    { timeoutMs, label: `session ${sessionId} reaches status ${status}` }
  );
}

/** The open button's own `data-session-open` attribute holds `session.id` directly
 * (SessionRow.tsx) -- reads it straight off the DOM instead of needing a second IPC round trip
 * just to learn which Session a quick-create click just produced. `excludeIds` (already-known
 * Session ids in this same Project) matters once a second Session exists alongside a first,
 * STOPPED one that never leaves the DOM (stopping never archives it) -- a positional "first
 * match" would silently keep re-returning the first Session instead of the new one, regardless
 * of render order. */
async function latestSessionIdAndName(cdp, repoName, excludeIds = []) {
  const result = await cdp.evaluate(
    `(() => { const group = Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoName)})); if (!group) return null; const exclude = new Set(${JSON.stringify(excludeIds)}); const btn = Array.from(group.querySelectorAll('li [data-session-open]')).find((el) => !exclude.has(el.getAttribute('data-session-open'))); if (!btn) return null; return { id: btn.getAttribute('data-session-open'), name: btn.getAttribute('aria-label').split(',')[0] }; })()`
  );
  assert(result && result.id, `a new Session must exist in ${repoName} not among ${JSON.stringify(excludeIds)} (got ${JSON.stringify(result)})`);
  return result;
}

async function runChecks(cdp, evidenceDir, log, { repoDir, repoName }) {
  const notExercised = [];

  // Wraps the real `window.refract.sessions.stopAgent` bridge once, early (before any Stop is
  // clicked), to count invocations -- Item 2's busy-guard assertion below proves a second real
  // Enter keypress on an already-"Stopping…" button does not reach the IPC call a second time.
  // `fake-omp-invocations.log` (REFRACT_FAKE_OMP_DEBUG_LOG) only records the fake-omp CHILD
  // PROCESS's own argv per spawn, not per-call `sessions.stopAgent` IPC traffic into the Rust
  // backend, so it cannot answer this; this in-page counter is the direct equivalent.
  await cdp.evaluate(`(() => { window.__stopAgentCallCount = 0; const orig = window.refract.sessions.stopAgent.bind(window.refract.sessions); window.refract.sessions.stopAgent = (...args) => { window.__stopAgentCallCount++; return orig(...args); }; })()`);

  // ---- Setup: readiness green, one scratch repository, one idle Session (sessionA) ----
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness green' }
  );
  await addRepositoryDiag(cdp, repoDir, evidenceDir, log);
  await cdp.waitFor(groupTriggerFinder(repoName) + ' !== undefined', { timeoutMs: 15_000, label: 'Repository group rendered' });
  log('STEP PASS: readiness green, scratch repository added.');

  await createSessionViaQuickCreate(cdp, repoName);
  const sessionA = await latestSessionIdAndName(cdp, repoName, []);
  await waitForSessionStatus(cdp, sessionA.id, 'idle');
  log(`STEP PASS: Session "${sessionA.name}" (${sessionA.id}) created and reached idle.`);

  // ---- Item 1: both alert rows appear, with the exact text/labels ----
  await cdp.waitFor(LOW_MEMORY_ROW_SPAN + ' !== undefined', { timeoutMs: 30_000, label: 'Low memory alert row appears (REFRACT_FORCE_LOW_MEMORY=1)' });
  const memoryRowName = await axText(cdp, LOW_MEMORY_ROW_SPAN);
  assert(memoryRowName === 'Low memory', `low-memory row's own accessible name must read exactly "Low memory" (got ${JSON.stringify(memoryRowName)})`);
  log(`STEP PASS: low-memory alert row present, accessible name ${JSON.stringify(memoryRowName)}.`);

  await cdp.waitFor(OMPVERSION_ROW_SPAN + ' !== undefined', { timeoutMs: 30_000, label: 'Unverified omp version alert row appears' });
  const ompRowName = await axText(cdp, OMPVERSION_ROW_SPAN);
  assert(ompRowName === 'omp 18.10.1: unverified version', `omp-version row's own accessible name must be exactly "omp 18.10.1: unverified version" (got ${JSON.stringify(ompRowName)})`);
  log('STEP PASS: unverified-omp-version alert row present with the exact expected text, with zero extra setup beyond the normal fake-omp harness launch.');
  await cdp.screenshot(path.join(evidenceDir, '01-both-alert-rows.png'));

  // ---- Items 7 & 8: a real keyboard-only Tab walk from the profile name button, through the
  // cog, through both alert rows -- reading every control's own accessible name off the
  // Accessibility domain as it goes (never textContent) -- then Enter (not a click) on Check to
  // open the real HealthCheckDialog, satisfying item 5 (the warning state word, Done, and the
  // focus-return) in the same pass. ----
  await cdp.evaluate(`(() => { const el = ${PROFILE_NAME_BUTTON}; el?.focus(); return !!el; })()`);
  const nameButtonAx = await getActiveElementAccessibleName(cdp);
  assert(nameButtonAx.role === 'button', `the profile item's own name control must be a button (got role ${JSON.stringify(nameButtonAx.role)}, name ${JSON.stringify(nameButtonAx.name)})`);
  const tabOrder = [{ step: 'start (profile name button)', ...nameButtonAx }];

  await pressTab(cdp);
  let active = await getActiveElementAccessibleName(cdp);
  assert(active.name === 'Settings', `Tab from the name button must land on the Settings cog (got ${JSON.stringify(active)})`);
  tabOrder.push({ step: 'Tab 1', ...active });

  await pressTab(cdp);
  active = await getActiveElementAccessibleName(cdp);
  assert(active.name === 'Open memory triage', `Tab from Settings must land on the Triage button (got ${JSON.stringify(active)})`);
  tabOrder.push({ step: 'Tab 2', ...active });

  await pressTab(cdp);
  active = await getActiveElementAccessibleName(cdp);
  assert(active.name === 'Dismiss low memory alert', `Tab from Triage must land on the low-memory Dismiss button (got ${JSON.stringify(active)})`);
  tabOrder.push({ step: 'Tab 3', ...active });

  await pressTab(cdp);
  active = await getActiveElementAccessibleName(cdp);
  assert(active.name === 'Open Health check', `Tab from the low-memory Dismiss button must land on the Check button (got ${JSON.stringify(active)})`);
  tabOrder.push({ step: 'Tab 4', ...active });
  log(`STEP PASS: real Tab order from the profile name button: ${tabOrder.map((s) => `${s.step}=${JSON.stringify(s.name)}`).join(' -> ')}.`);

  await pressRealEnter(cdp);
  await cdp.waitFor(`(${DIALOG_TITLE})?.textContent.trim() === 'Health check'`, { timeoutMs: 10_000, label: 'HealthCheckDialog opened via Enter (not a click)' });
  log('STEP PASS: Enter on the focused Check button opened the real HealthCheckDialog (keyboard-only activation).');

  await cdp.waitFor(`(${OMP_CHECK_ROW})?.textContent.includes('Passed with a warning')`, { timeoutMs: 20_000, label: 'omp row shows "Passed with a warning"' });
  const ompCheckRowName = await axText(cdp, `(${OMP_CHECK_ROW})?.querySelector('span')?.querySelector('span')`); // CheckRow.tsx: the li's own FIRST span is the label span, and the state word is a span NESTED inside that one -- a warning Check ALSO renders a later sibling hint span at the li level, so ".pop()" (last span overall) grabbed that hint text in round 1, confirmed live, instead of the state word
  assert((ompCheckRowName ?? '').includes('Passed with a warning'), `the omp CheckRow's own rendered state word must be "Passed with a warning" (got ${JSON.stringify(ompCheckRowName)}), never an invented string`);
  log(`STEP PASS: HealthCheckDialog's omp row renders its own real state word: ${JSON.stringify(ompCheckRowName)}.`);
  await cdp.screenshot(path.join(evidenceDir, '02-health-check-dialog-warning.png'));

  const preDoneActive = await getActiveElementAccessibleName(cdp);
  assert(preDoneActive.name === 'Done', `Done must still be focused (it is auto-focused on open and nothing should have stolen focus) (got ${JSON.stringify(preDoneActive)})`);
  await pressRealEnter(cdp);
  await cdp.waitFor(`!(${DIALOG})`, { timeoutMs: 10_000, label: 'HealthCheckDialog closed via Enter on Done' });
  const postCloseActive = await getActiveElementAccessibleName(cdp);
  assert(postCloseActive.name === 'Open Health check', `Done must return focus to the alert row's own Check button, not <body>/the Settings cog (got ${JSON.stringify(postCloseActive)})`);
  log('STEP PASS: Done closes HealthCheckDialog and returns focus to the alert row\'s own Check button (never <body>).');

  await pressTab(cdp);
  active = await getActiveElementAccessibleName(cdp);
  assert(active.name === 'Dismiss unverified version alert', `Tab from Check must land on the omp-version Dismiss button (got ${JSON.stringify(active)})`);
  tabOrder.push({ step: 'Tab 5 (post Health-check close)', ...active });
  log(`STEP PASS: full documented Tab order confirmed: ${tabOrder.map((s) => JSON.stringify(s.name)).join(' -> ')}.`);

  // ---- Item 2: Memory Triage -- lists the idle Session, per-row Stop with confirmation ----
  await cdp.evaluate(`document.activeElement?.blur()`);
  await cdp.click(TRIAGE_BUTTON);
  await cdp.waitFor(`(${DIALOG_TITLE})?.textContent.trim() === 'Free up memory'`, { timeoutMs: 10_000, label: 'MemoryTriageDialog opened' });
  const sessionARow = `Array.from(document.querySelectorAll('[role="dialog"] li')).find((li) => li.textContent.includes(${JSON.stringify(sessionA.name)}))`;
  await cdp.waitFor(sessionARow + ' !== undefined', { timeoutMs: 10_000, label: `Session "${sessionA.name}" listed in Triage` });
  const sessionARowText = await cdp.evaluate(`(${sessionARow})?.textContent`);
  assert(sessionARowText.includes(repoName), `Session row must show its own repository name (got ${JSON.stringify(sessionARowText)})`);
  assert(/Idle (just now|\d+m)/.test(sessionARowText), `Session row must show "Idle <relative time>" (got ${JSON.stringify(sessionARowText)})`);
  log(`STEP PASS: Triage lists the idle Session with its repository and relative time: ${JSON.stringify(sessionARowText)}.`);

  await cdp.click(`(${sessionARow})?.querySelector('button')`);
  await cdp.waitFor(`(${ALERT_DIALOG_TITLE})?.textContent.trim() === ${JSON.stringify(`Stop ${sessionA.name}'s agent?`)}`, { timeoutMs: 10_000, label: 'per-Session Stop confirmation opened' });
  log('STEP PASS: the Session\'s own Stop button opens a confirmation naming that exact Session.');

  // Item 5a (round 2, for the next live run): Escape closes the per-row confirm WITHOUT
  // stopping anything, then a second Escape closes the Triage Dialog itself, landing focus
  // back on the alert row's own Triage button -- never <body>, never left inside the (now
  // closed) Dialog.
  await pressEscape(cdp);
  await cdp.waitFor(`!(${ALERT_DIALOG})`, { timeoutMs: 10_000, label: 'per-Session confirmation closed via Escape (no stop)' });
  await pressEscape(cdp);
  await cdp.waitFor(`!(${DIALOG})`, { timeoutMs: 10_000, label: 'Triage Dialog closed via a second Escape' });
  const postEscapeCancelActive = await getActiveElementAccessibleName(cdp);
  assert(
    postEscapeCancelActive.name === 'Open memory triage',
    `Escape-cancelling the per-Session confirm then the Dialog must return focus to "Open memory triage" (got ${JSON.stringify(postEscapeCancelActive)})`
  );
  await waitForSessionStatus(cdp, sessionA.id, 'idle');
  log('STEP PASS: Escape-cancelling the per-Session confirm never stops the Session, and a second Escape returns focus to the alert row\'s own Triage button.');

  // Re-open the Dialog and the SAME Session's confirm to actually perform the stop below.
  await cdp.click(TRIAGE_BUTTON);
  await cdp.waitFor(`(${DIALOG_TITLE})?.textContent.trim() === 'Free up memory'`, { timeoutMs: 10_000, label: 'MemoryTriageDialog reopened' });
  await cdp.click(`(${sessionARow})?.querySelector('button')`);
  await cdp.waitFor(`(${ALERT_DIALOG_TITLE})?.textContent.trim() === ${JSON.stringify(`Stop ${sessionA.name}'s agent?`)}`, { timeoutMs: 10_000, label: 'per-Session Stop confirmation reopened' });

  // Item 5b (round 2): the title is sampled TWICE against the same expected exact string --
  // immediately on open (just above/below) and again right before the destructive click -- so
  // neither moment is ever blank/undefined/stale.
  const titleAtOpen = await cdp.evaluate(`(${ALERT_DIALOG_TITLE})?.textContent.trim()`);
  assert(
    titleAtOpen === `Stop ${sessionA.name}'s agent?`,
    `the per-Session confirm's own title immediately after opening must read exactly "Stop ${sessionA.name}'s agent?" (got ${JSON.stringify(titleAtOpen)})`
  );
  const singleStopActionExpr = `Array.from((${ALERT_DIALOG})?.querySelectorAll('button') ?? []).find((b) => b.textContent.trim() !== 'Cancel')`;
  await cdp.evaluate(`(${singleStopActionExpr})?.focus()`);
  const titleBeforeClick = await cdp.evaluate(`(${ALERT_DIALOG_TITLE})?.textContent.trim()`);
  assert(
    titleBeforeClick === `Stop ${sessionA.name}'s agent?`,
    `the per-Session confirm's own title right before the destructive Stop click must still read exactly "Stop ${sessionA.name}'s agent?" (got ${JSON.stringify(titleBeforeClick)})`
  );
  log(`STEP PASS: the per-Session confirm's own title read the exact expected string at both sampled moments (open: ${JSON.stringify(titleAtOpen)}, pre-click: ${JSON.stringify(titleBeforeClick)}).`);
  await cdp.click(singleStopActionExpr);

  // Item 5c (round 2): the Stop button's own visible text is read BEFORE the second Enter
  // fires -- if it does not read "Stopping…" at that exact moment (e.g. the first call already
  // settled faster than this script's own round trip to read it), this sub-check is recorded
  // NOT EXERCISED rather than silently passed or falsely failed.
  const stopButtonTextBeforeSecondEnter = await cdp.evaluate(`(${singleStopActionExpr})?.textContent.trim()`);
  if (stopButtonTextBeforeSecondEnter === 'Stopping…') {
    log('STEP PASS: the Stop button read "Stopping…" immediately before the second Enter, confirming the busy guard is actually being exercised.');
  } else {
    notExercised.push(
      `Item 5c busy-guard-text sub-check: the Stop button read ${JSON.stringify(stopButtonTextBeforeSecondEnter)}, not "Stopping…", at the moment this script sampled it (the first stopAgent call likely already settled before the sample) -- the busy-guard COUNT assertion below still ran, but this specific textual sub-check did not.`
    );
  }
  // Gate-round-1 remediation (busy guard in handleConfirmStop): a second real Enter on the SAME
  // button while it reads "Stopping…" must not reach stopAgent a second time -- fired with no
  // intervening await for the first call to settle, while the real IPC stop is still in flight.
  await pressRealEnter(cdp);
  const singleTitleSamples = await sampleWhileAlive(cdp, `(${ALERT_DIALOG_TITLE})?.textContent.trim()`, `!!(${ALERT_DIALOG})`);
  assert(singleTitleSamples.length > 0, 'expected at least one title sample while the per-Session confirmation was still mounted and closing');
  assert(
    singleTitleSamples.every((text) => typeof text === 'string' && text.length > 0 && text !== 'undefined' && !/Stop (undefined|null)'s agent\?/.test(text)),
    `the per-Session confirmation's own title must never go blank/undefined during the close animation -- the last-known target name must stay latched (got samples ${JSON.stringify(singleTitleSamples)})`
  );
  log(`STEP PASS: the per-Session confirmation's own title stayed real and non-blank through every sampled frame of the close animation (${singleTitleSamples.length} samples: ${JSON.stringify(singleTitleSamples)}).`);
  await waitForSessionStatus(cdp, sessionA.id, 'stopped');
  await cdp.waitFor(sessionARow + ' === undefined', { timeoutMs: 10_000, label: `Session "${sessionA.name}" no longer listed as idle` });
  const emptyAfterSingleStop = await cdp.evaluate(`(${DIALOG})?.textContent.includes('No idle agents to stop right now.')`);
  assert(emptyAfterSingleStop === true, 'Triage must fall back to the empty-state copy once its only idle Session is stopped');
  const stopAgentCallsAfterSingleStop = await cdp.evaluate('window.__stopAgentCallCount');
  assert(stopAgentCallsAfterSingleStop === 1, `a second real Enter keypress on an already-"Stopping…" Stop button must not fire a second stopAgent IPC call (got ${stopAgentCallsAfterSingleStop} calls)`);
  log('STEP PASS: the busy guard held -- exactly one real stopAgent call reached the IPC bridge despite a second real Enter keypress while "Stopping…".');
  const postStopActive = await getActiveElementAccessibleName(cdp);
  assert(
    postStopActive.role === 'heading' && postStopActive.name === 'Free up memory',
    `focus after a successful single Stop must land on a genuine, named, connected control, never <body> -- with no idle Sessions remaining (this Session was the only one), focusAfterStop()'s own documented fallback order lands on the dialog's own heading (role=heading name="Free up memory"); got role=${JSON.stringify(postStopActive.role)} name=${JSON.stringify(postStopActive.name)}`
  );
  log(`STEP PASS: confirming Stop actually stopped the agent (sessions.list() status now 'stopped'), the row is gone, the dialog shows the empty-state copy, and focus landed on a real connected control: the dialog's own heading (role=${JSON.stringify(postStopActive.role)} name=${JSON.stringify(postStopActive.name)}), never <body>.`);
  await cdp.screenshot(path.join(evidenceDir, '03-triage-dialog-after-stop-A.png'));
  await pressEscape(cdp);
  await cdp.waitFor(`!(${DIALOG})`, { timeoutMs: 10_000, label: 'Triage dialog closed via Escape' });

  // ---- Item 3: a second idle Session, bulk "Stop idle" ----
  await createSessionViaQuickCreate(cdp, repoName);
  const sessionB = await latestSessionIdAndName(cdp, repoName, [sessionA.id]);
  assert(sessionB.id !== sessionA.id, 'the second quick-create must produce a genuinely new Session id');
  await waitForSessionStatus(cdp, sessionB.id, 'idle');
  log(`STEP PASS: second Session "${sessionB.name}" (${sessionB.id}) created and reached idle.`);

  await cdp.click(TRIAGE_BUTTON);
  await cdp.waitFor(`(${DIALOG_TITLE})?.textContent.trim() === 'Free up memory'`, { timeoutMs: 10_000, label: 'MemoryTriageDialog reopened' });
  const sessionBRow = `Array.from(document.querySelectorAll('[role="dialog"] li')).find((li) => li.textContent.includes(${JSON.stringify(sessionB.name)}))`;
  await cdp.waitFor(sessionBRow + ' !== undefined', { timeoutMs: 10_000, label: `Session "${sessionB.name}" listed in Triage` });
  const stillHasSessionA = await cdp.evaluate(`(${DIALOG})?.textContent.includes(${JSON.stringify(sessionA.name)})`);
  assert(stillHasSessionA === false, `the already-stopped Session "${sessionA.name}" must never reappear (status filter is by construction, not a one-time snapshot)`);
  await cdp.click(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent.trim() === 'Stop idle')`);
  const bulkTitle = await cdp.evaluate(`(${ALERT_DIALOG_TITLE})?.textContent.trim()`);
  assert(bulkTitle === 'Stop 1 idle agent?', `the bulk confirmation must name the real idle count (got ${JSON.stringify(bulkTitle)})`);
  const ALERT_DIALOG_DESCRIPTION = `document.querySelector('[data-slot="alert-dialog-description"]')`;
  const bulkDescription = await cdp.evaluate(`(${ALERT_DIALOG_DESCRIPTION})?.textContent.trim()`);
  assert(
    (bulkDescription ?? '').includes(sessionB.name),
    `the bulk confirmation's own description must NAME the Session(s) being stopped, not just the count (got ${JSON.stringify(bulkDescription)})`
  );
  log('STEP PASS: "Stop idle" confirms with the real, current idle count, and its description names the Session(s) being stopped.');

  // Item 5a (round 2): Escape closes the bulk confirm WITHOUT stopping anything, then a second
  // Escape closes the Triage Dialog itself, landing focus back on "Open memory triage".
  await pressEscape(cdp);
  await cdp.waitFor(`!(${ALERT_DIALOG})`, { timeoutMs: 10_000, label: 'bulk confirmation closed via Escape (no stop)' });
  await pressEscape(cdp);
  await cdp.waitFor(`!(${DIALOG})`, { timeoutMs: 10_000, label: 'Triage Dialog closed via a second Escape' });
  const postBulkEscapeActive = await getActiveElementAccessibleName(cdp);
  assert(
    postBulkEscapeActive.name === 'Open memory triage',
    `Escape-cancelling the bulk confirm then the Dialog must return focus to "Open memory triage" (got ${JSON.stringify(postBulkEscapeActive)})`
  );
  await waitForSessionStatus(cdp, sessionB.id, 'idle');
  log('STEP PASS: Escape-cancelling the bulk confirm never stops any Session, and a second Escape returns focus to the alert row\'s own Triage button.');

  // Re-open the Dialog and "Stop idle" again to actually perform the bulk stop below.
  await cdp.click(TRIAGE_BUTTON);
  await cdp.waitFor(`(${DIALOG_TITLE})?.textContent.trim() === 'Free up memory'`, { timeoutMs: 10_000, label: 'MemoryTriageDialog reopened for the real bulk stop' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent.trim() === 'Stop idle')`);
  await cdp.waitFor(`(${ALERT_DIALOG_TITLE})?.textContent.trim() === 'Stop 1 idle agent?'`, { timeoutMs: 10_000, label: 'bulk confirmation reopened' });
  await cdp.click(`Array.from((${ALERT_DIALOG})?.querySelectorAll('button') ?? []).find((b) => b.textContent.trim() === 'Stop idle')`);
  await waitForSessionStatus(cdp, sessionB.id, 'stopped');
  await cdp.waitFor(`!(${ALERT_DIALOG})`, { timeoutMs: 10_000, label: 'bulk confirmation closed after Stop idle' });
  await cdp.waitFor(`(${DIALOG})?.textContent.includes('No idle agents to stop right now.')`, { timeoutMs: 10_000, label: 'Triage falls back to empty state after bulk stop' });
  log('STEP PASS: bulk "Stop idle" stopped every listed Session and the dialog now shows the empty-state copy.');
  await cdp.screenshot(path.join(evidenceDir, '04-triage-dialog-empty-after-bulk-stop.png'));
  await pressEscape(cdp);
  await cdp.waitFor(`!(${DIALOG})`, { timeoutMs: 10_000, label: 'Triage dialog closed via Escape' });

  // ---- Item 4: dismissing the low-memory row is immediate and LOCAL-only (survives a second
  // real memory-sampler tick, ~6s, even though REFRACT_FORCE_LOW_MEMORY=1 never stops being
  // true) ----
  await cdp.click(DISMISS_MEMORY_BUTTON);
  await cdp.waitFor(LOW_MEMORY_ROW_SPAN + ' === undefined', { timeoutMs: 5_000, label: 'low-memory row removed immediately on Dismiss' });
  assert((await cdp.evaluate(OMPVERSION_ROW_SPAN + ' !== undefined')) === true, 'dismissing the low-memory row must not affect the unrelated omp-version row');
  log('STEP PASS: dismissing the low-memory row hides it immediately without touching the other row.');
  await sleep(7_000); // longer than memory.rs's own 5s SAMPLE_INTERVAL_MS -- at least one more real sample tick
  assert((await cdp.evaluate(LOW_MEMORY_ROW_SPAN + ' === undefined')) === true, 'the low-memory row must NOT reappear on its own after a further sampler tick -- dismissal is local React state, never re-derived from the store');
  log('STEP PASS: the dismissed low-memory row did not return after a further real sampler tick, confirming dismissal is local-only state, not read back from the store.');

  // ---- Item 6: dismissing the unverified-version row, via Tab + Enter (item 5d, round 2) --
  // the low-memory row is already gone at this point, so the real Tab order from the profile
  // name button is just: Settings -> Check -> Dismiss. ----
  await cdp.evaluate(`(() => { const el = ${PROFILE_NAME_BUTTON}; el?.focus(); return !!el; })()`);
  await pressTab(cdp);
  await pressTab(cdp);
  await pressTab(cdp);
  const preKeyboardDismissActive = await getActiveElementAccessibleName(cdp);
  assert(
    preKeyboardDismissActive.name === 'Dismiss unverified version alert',
    `real Tab order (Name -> Settings -> Check -> Dismiss) must land on the omp-version Dismiss button (got ${JSON.stringify(preKeyboardDismissActive)})`
  );
  await pressRealEnter(cdp);
  await cdp.waitFor(OMPVERSION_ROW_SPAN + ' === undefined', { timeoutMs: 5_000, label: 'omp-version row removed immediately on keyboard-driven Dismiss' });
  const postKeyboardDismissActive = await getActiveElementAccessibleName(cdp);
  const postKeyboardDismissConnected = await cdp.evaluate(`document.activeElement !== document.body && document.activeElement?.isConnected === true`);
  assert(
    postKeyboardDismissConnected === true && !!postKeyboardDismissActive.name,
    `after a keyboard-driven Dismiss (Tab + Enter), focus must land on a real, named, connected control, never <body> (got connected=${postKeyboardDismissConnected}, ${JSON.stringify(postKeyboardDismissActive)})`
  );
  log(`STEP PASS: dismissing the unverified-version row via Tab + Enter hides it immediately and leaves focus on a real connected control: role=${JSON.stringify(postKeyboardDismissActive.role)} name=${JSON.stringify(postKeyboardDismissActive.name)}.`);
  await cdp.screenshot(path.join(evidenceDir, '05-both-rows-dismissed.png'));

  // ---- Item 5e (round 2): a Settings round trip must not resurrect a dismissed row or
  // re-announce it -- reuses `openSettingsAndReturn` (verify-tauri-session-list-helpers.mjs)
  // rather than a duplicate in-script Settings round trip. ----
  const announceTextBeforeRoundTrip = await cdp.evaluate(`(${CHAT_AREA_ANNOUNCE_REGION})?.textContent ?? null`);
  await openSettingsAndReturn(cdp);
  await sleep(500); // lets any stray re-announce effect actually commit before sampling
  const announceTextAfterRoundTrip = await cdp.evaluate(`(${CHAT_AREA_ANNOUNCE_REGION})?.textContent ?? null`);
  assert(
    (await cdp.evaluate(LOW_MEMORY_ROW_SPAN + ' === undefined')) === true && (await cdp.evaluate(OMPVERSION_ROW_SPAN + ' === undefined')) === true,
    'both previously-dismissed rows must stay dismissed after a Settings round trip'
  );
  assert(
    announceTextAfterRoundTrip === announceTextBeforeRoundTrip,
    `the chat-area announcement region's own text must NOT change (re-announce either alert) after a Settings round trip over an already-dismissed row (before ${JSON.stringify(announceTextBeforeRoundTrip)}, after ${JSON.stringify(announceTextAfterRoundTrip)})`
  );
  log('STEP PASS: a Settings round trip leaves both dismissed rows dismissed and never re-announces them.');

  if (notExercised.length > 0) {
    for (const item of notExercised) log(`NOT EXERCISED: ${item}`);
  }
  return { notExercised };
}

async function main() {
  clearKnownOutputFiles(SHOT_DIR, 'refract-560-', [
    '01-both-alert-rows.png', '02-health-check-dialog-warning.png', '03-triage-dialog-after-stop-A.png',
    '04-triage-dialog-empty-after-bulk-stop.png', '05-both-rows-dismissed.png',
    '99-diag-add-repository-failure.png', 'report.json', 'report.txt', 'app.log', 'fake-omp-invocations.log'
  ]);
  const log = createReportLogger(path.join(SHOT_DIR, 'report.txt'));
  let shimDir, dataDir, importSourceDir, repoDir, exeDir;
  let child, cdp;
  let exitCode = 0;
  let notExercised = [];

  const realRegistryPath = path.join(process.env.APPDATA ?? '', 'refract-tauri', 'registry.json');
  const realRegistryStatBefore = existsSync(realRegistryPath) ? statSync(realRegistryPath) : null;

  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-560-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-560-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-560-import-src-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-560-repo-')), 'refract-560-repo');
    const repoName = path.basename(repoDir);
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-560-exe-'));

    log(`verify-tauri-560: data dir ${dataDir}`);
    log(`verify-tauri-560: evidence dir ${SHOT_DIR}`);
    log(`verify-tauri-560: Project ${repoDir} (name "${repoName}")`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const { dest: exePath, hash: exeHash, buildTime: exeBuildTime, gitHeadValue, rebuilt } = resolveExe(exeDir);

    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(SHOT_DIR, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(SHOT_DIR, 'fake-omp-invocations.log'),
        REFRACT_FORCE_LOW_MEMORY: '1'
      }
    });
    child = launched.child;
    cdp = await connectCdp(port, launched.targetPid);
    assertExeMatchesProcess(launched.targetPid, exePath, exeHash);
    log(`verify-tauri-560: launched, pid ${launched.targetPid}, exe sha256 ${exeHash} (asserted against the process's own exe path), rebuilt=${rebuilt}`);

    const result = await runChecks(cdp, SHOT_DIR, log, { repoDir, repoName });
    notExercised = result.notExercised;

    // Isolation proof (refract-tauri-live-check-isolation skill): the scratch REFRACT_DATA_DIR
    // actually took effect (its own registry.json exists -- RegistryStore::open only creates it
    // on the first WRITE, e.g. the add-repository step runChecks just did, never merely on
    // open, so this is checked after runChecks rather than right after launch), and Stuart's
    // real profile under %APPDATA%\refract-tauri was never touched by this run.
    const scratchRegistryPath = path.join(dataDir, 'registry.json');
    assert(existsSync(scratchRegistryPath), `the scratch REFRACT_DATA_DIR must have its own registry.json (got none at ${scratchRegistryPath}) -- the override may not have taken effect`);
    log(`verify-tauri-560: isolation confirmed -- scratch data dir has its own registry.json at ${scratchRegistryPath}.`);

    const realRegistryStatAfter = existsSync(realRegistryPath) ? statSync(realRegistryPath) : null;
    const realProfileUntouched =
      (realRegistryStatBefore === null) === (realRegistryStatAfter === null) &&
      (realRegistryStatBefore === null || realRegistryStatBefore.mtimeMs === realRegistryStatAfter.mtimeMs);
    assert(realProfileUntouched, `Stuart's real %APPDATA%\\refract-tauri\\registry.json must be untouched by this run (before ${JSON.stringify(realRegistryStatBefore?.mtimeMs)}, after ${JSON.stringify(realRegistryStatAfter?.mtimeMs)})`);
    log('verify-tauri-560: confirmed the real %APPDATA%\\refract-tauri\\registry.json mtime is unchanged by this run.');

    log(`verify-tauri-560: ALL PASS. Evidence and screenshots: ${SHOT_DIR}`);
    const screenshots = citeScreenshots(SHOT_DIR, [
      '01-both-alert-rows.png', '02-health-check-dialog-warning.png', '03-triage-dialog-after-stop-A.png',
      '04-triage-dialog-empty-after-bulk-stop.png', '05-both-rows-dismissed.png'
    ]);
    writeFileSync(
      path.join(SHOT_DIR, 'report.json'),
      JSON.stringify(
        {
          gitHead: gitHeadValue,
          exitCode: 0,
          frozenExe: { path: exePath, sha256AtRunTime: exeHash, buildTime: exeBuildTime, rebuilt },
          notExercised,
          screenshots,
          finishedAt: new Date().toISOString()
        },
        null,
        2
      )
    );
  } catch (err) {
    exitCode = 1;
    writeFileSync(
      path.join(SHOT_DIR, 'report.json'),
      JSON.stringify(
        {
          gitHead: gitHead(REPO_ROOT),
          exitCode: 1,
          error: String(err?.message ?? err),
          notExercised,
          finishedAt: new Date().toISOString()
        },
        null,
        2
      )
    );
    throw err;
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child);
    await safeRmSync(shimDir);
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    if (repoDir) await safeRmSync(worktreesDirFor(repoDir));
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    // Deliberately NOT removing SHOT_DIR: its STEP-PASS report and screenshots are this run's
    // own audit trail (same convention as verify-tauri-559.mjs).
    process.exitCode = exitCode;
  }
}

main().catch((err) => {
  console.error('verify-tauri-560: FAIL');
  console.error(err);
  process.exitCode = 1;
});
