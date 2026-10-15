#!/usr/bin/env node
// Ask card (issue #572) live check against the scratch Tauri debug build. Standalone script
// (same precedent as `scripts/verify-tauri-side-chat.mjs`: duplicates the small build/copy/
// launch glue rather than importing `verify-tauri.mjs`, reuses `scripts/verify-tauri-cdp.mjs`'s
// CDP primitives) -- `scripts/fixtures/omp-frames/README.md`'s own "Scenario selection" section
// calls for exactly this: a lane selecting its own fixture (`ask.jsonl`) directly via
// `REFRACT_FAKE_OMP_SCENARIO`, never through `pnpm verify:tauri`'s two committed scenarios.
//
// Drives the WHOLE repository-add / session-create / compose-and-send flow through real DOM
// input, the same way `verify-tauri.mjs`'s own `proveUs4` does (never `window.refract.*` as a
// shortcut for any of it) -- the point of this check is proving the rendered Ask card UI itself
// works (tab row, radio rows, tick-box rows, Other input, footer, answered summary) against real
// mouse clicks and real typed keystrokes, not just that the IPC round trip resolves.
//
// Scripted answer (must match `ask.jsonl`'s own `tool_execution_end.result.details.results[]`
// exactly, contracts/omp-usage.md "Chat line wire shapes"): "Postgres" on the single-choice
// Database question (the recommended option is SQLite, deliberately NOT the one clicked, so the
// proof exercises a real user choice rather than accepting the default), and "Auth" + "Search" +
// an Other answer of "Beta" on the multiple-choice Features question.
//
// Not covered here (left for a future round): a real, signed-in `omp`'s own `ask.timeout`
// handling (`ask.jsonl` carries no `timeout` key, matching `docs/spike/FINDINGS.md` item 59's
// live probe at its disabled default), and keyboard-only operation of the radio/tab groups
// themselves (every pick above is a mouse click or typed text) -- gate round 3 adds real
// keyboard Tab+Enter for ONLY the final Submit step, to prove the D17 focus-ring target is not
// clipped, not as a stand-in for full keyboard coverage of the whole card.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, existsSync, createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, launchViaJobObject, isTargetOwningPort } from './verify-tauri-cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// Unset when the caller hasn't pointed at a shared cache: `cargo`/`tauri` then fall back to
// their own default (`src-tauri/target`) -- gate-fix (round 1, code review Medium): a hard-coded
// one-machine default here tied this harness to one machine, exactly the mistake
// `verify-tauri.mjs:53-55` already records fixing once before.
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');

// Default under `os.tmpdir()` (gate round 2, code review/Low: a literal path under Stuart's own
// user directory tied this harness to one machine), overridable via `REFRACT_ASK_SHOT_DIR` for
// a run that needs its own evidence dir (e.g. a gate-fix re-run).
const ASK_SHOT_DIR = process.env.REFRACT_ASK_SHOT_DIR || path.join(tmpdir(), 'refract-572-ask-shots');

const PROMPT_MESSAGE = 'Please ask me the batch of questions now.';
// The assistant's own streamed reply token, deliberately absent from PROMPT_MESSAGE above (same
// reasoning as `verify-tauri.mjs`'s own REPLY_TOKEN: a check against it must only ever match the
// reply, never the user's own echoed prompt).
const REPLY_TOKEN = 'askdone9';

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

/** Best-effort recursive delete: a Windows file handle from the just-stopped process tree can
 * still be closing asynchronously for a moment, so EPERM/EBUSY here must never mask the proof's
 * own pass/fail result -- it is logged and otherwise ignored, never thrown. */
async function safeRmSync(dir) {
  if (!dir) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 2) {
        console.warn(`verify-tauri-ask: could not remove scratch dir ${dir} (left on disk): ${err.message}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
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

function buildTauriDebugNoBundle() {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const env = { ...process.env };
    if (CARGO_TARGET_DIR) {
      env.CARGO_TARGET_DIR = CARGO_TARGET_DIR;
      env.CARGO_INCREMENTAL = '0';
      env.CARGO_BUILD_JOBS = '4';
    }
    const result = spawnSync_('cmd.exe', ['/c', 'pnpm', 'exec', 'tauri', 'build', '--debug', '--no-bundle'], {
      cwd: REPO_ROOT,
      env,
      timeout: 20 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status === 0) return;
    const locked = /Access is denied/i.test(result.stderr ?? '') || /Access is denied/i.test(result.stdout ?? '');
    if (!locked || attempt === maxAttempts) {
      throw new Error(`buildTauriDebugNoBundle: build failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
    }
    console.warn(`verify-tauri-ask: build exe locked, retrying in 30s (attempt ${attempt}/${maxAttempts})...`);
    spawnSync_('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30']);
  }
}

function copyBuiltExe(destDir) {
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'refract-tauri.exe');
  const src = path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
  if (!existsSync(src)) throw new Error(`copyBuiltExe: built exe not found at ${src}`);
  copyFileSync(src, dest);
  // Gate round 3: logged so a reviewer can confirm two runs built different code rather than
  // silently reusing a stale cached binary (a sibling lane's gate once found exactly that).
  const hash = createHash('sha256').update(readFileSync(dest)).digest('hex');
  console.log(`verify-tauri-ask: copied exe sha256 ${hash} (${dest})`);
  return dest;
}

async function launchBuiltExe(launcherExe, exePath, { port, dataDir, pathPrepend, extraEnv = {}, logFile }) {
  const webview2DataDir = path.join(path.dirname(exePath), `webview2-data-${nowStamp()}`);
  mkdirSync(webview2DataDir, { recursive: true });
  const pidFile = path.join(path.dirname(exePath), `target-${nowStamp()}.pid`);
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
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

function withEvidenceDir(name) {
  const dir = path.join(tmpdir(), `refract-tauri-verify-ask-${name}-${nowStamp()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A minimal scratch git repository to add as a Repository: one commit on `main`, nothing else.
 * Never under C:/Repos/personal (AGENTS.md: never seed a repo there); always a fresh mkdtemp. */
function makeScratchRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const run = (args) => {
    const result = spawnSync_('git', ['-C', dir, ...args]);
    if (result.status !== 0) throw new Error(`makeScratchRepo: git ${args.join(' ')} failed (exit ${result.status}): ${result.stderr || result.stdout}`);
    return result;
  };
  run(['init', '-q', '-b', 'main']);
  // Persistent repo-local config (not a one-off `-c` flag): `repositories.userName`
  // (`ipc/repositories.rs`) shells out to `git config user.name` in THIS checkout, falling back
  // to the machine's own global config when the repo has none set -- a one-off `-c` flag on the
  // `commit` call below never writes that, so the "Answer:" row's own name would otherwise vary
  // by whichever machine happens to run this script.
  run(['config', 'user.name', 'Verify Tauri Ask']);
  run(['config', 'user.email', 'verify-tauri-ask@example.invalid']);
  run(['commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

function worktreesDirFor(repoDir) {
  return path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
}

async function connectCdp(port, targetPid) {
  const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
  const cdp = await CdpSession.connect(wsUrl);
  if (!isTargetOwningPort(port, targetPid)) {
    throw new Error(`verify-tauri-ask: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
  }
  return cdp;
}

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
}

/** Finds a `[role="radio"]`/`[role="checkbox"]` row by its own option label, reading the
 * label text from the row's `.font-medium` span's FIRST child text node only -- never the whole
 * element's `textContent`, which for a described option (e.g. "Postgres"/"Relational") or the
 * recommended option (the " (Recommended)" suffix lives in a sibling span inside the same
 * `.font-medium` element) would otherwise concatenate unrelated text onto the label. */
function roleLabelFinder(role, label) {
  return `(() => {
    const els = Array.from(document.querySelectorAll('[role="${role}"]'));
    return els.find((el) => {
      const labelSpan = el.querySelector('.font-medium');
      const node = labelSpan && labelSpan.firstChild;
      return !!node && typeof node.nodeValue === 'string' && node.nodeValue.trim() === ${JSON.stringify(label)};
    });
  })()`;
}

async function clickRoleLabel(cdp, role, label, opts) {
  await cdp.click(roleLabelFinder(role, label), opts);
}

async function getRoleLabelInfo(cdp, role, label) {
  return cdp.evaluate(`(() => {
    const el = ${roleLabelFinder(role, label)};
    if (!el) return null;
    return { text: el.textContent.trim(), ariaChecked: el.getAttribute('aria-checked'), dataState: el.getAttribute('data-state') };
  })()`);
}

// Gate-fix (round 1, accessibility): the tab trigger no longer carries a native `title`
// attribute (D7 -- a real Tooltip replaces it), so a tab is found by its own label span's text
// instead -- the FIRST `span` child in document order is always the truncating label span
// (`AskCard.tsx`'s own `TabsTrigger` renders it before the answered-state CheckIcon/sr-only span).
function tabFinder(label) {
  return `Array.from(document.querySelectorAll('[role="tab"]')).find((el) => { const span = el.querySelector('span'); return !!span && span.textContent.trim() === ${JSON.stringify(label)}; })`;
}

async function getTabInfo(cdp, label) {
  return cdp.evaluate(`(() => {
    const el = ${tabFinder(label)};
    return el ? { dataState: el.getAttribute('data-state'), ariaSelected: el.getAttribute('aria-selected') } : null;
  })()`);
}

function askRowTriggerFinder() {
  return `Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes('Asked user:'))`;
}

/** Gate round 3: the REAL computed accessible name of `document.activeElement` via CDP
 * Accessibility domain -- never `textContent`, which has no separator and is not what a screen
 * reader announces. `null` for both fields when nothing is focused or there is no AX node. */
async function getActiveElementAccessibleName(cdp) {
  await cdp.send('Accessibility.enable');
  const evalResult = await cdp.send('Runtime.evaluate', { expression: 'document.activeElement', returnByValue: false });
  const objectId = evalResult.result?.objectId;
  if (!objectId) return { name: null, role: null };
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { objectId });
  const node = nodes?.[0];
  return { name: node?.name?.value ?? null, role: node?.role?.value ?? null };
}

/** Gate round 3 (architect M-1): a real keyboard Tab, used to drive Submit via keyboard instead
 * of a mouse click -- Chromium suppresses `:focus-visible` after a mouse-driven focus. */
async function pressTab(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
}

/** Polls `[aria-label="Transcript"]`'s own trailing text until it ends with `finalToken`, only
 * accepting that final state if an EARLIER poll already observed a strict, non-empty, proper
 * prefix of it first (same reasoning as `verify-tauri.mjs`'s own helper of the same name: proves
 * the reply streamed in rather than painting in one shot). Also fails loudly on a "prompt
 * failed" notice. */
async function waitForStreamedReply(cdp, { finalToken, timeoutMs = 60_000, intervalMs = 250 }) {
  const deadline = Date.now() + timeoutMs;
  let sawPartialPrefix = false;
  let lastValue = '';
  while (Date.now() < deadline) {
    const { text, failedNotice } = await cdp.evaluate(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); const text = t ? t.textContent.trim() : ''; return { text, failedNotice: /prompt failed/i.test(text) }; })()`,
    );
    if (failedNotice) {
      throw new Error(`waitForStreamedReply: a "prompt failed" notice appeared in the transcript: ${text}`);
    }
    lastValue = text;
    const fullyArrived = text.endsWith(finalToken);
    if (!fullyArrived) {
      for (let len = finalToken.length - 1; len >= 1; len--) {
        if (text.endsWith(finalToken.slice(0, len))) {
          sawPartialPrefix = true;
          break;
        }
      }
    }
    if (fullyArrived && sawPartialPrefix) return text;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitForStreamedReply: timed out after ${timeoutMs}ms waiting for a streamed reply ending in "${finalToken}" (partial prefix observed: ${sawPartialPrefix}; last: ${JSON.stringify(lastValue)})`);
}

/** The Ask card live check itself: real repository-add / session-create / compose-and-send flow
 * (never `window.refract.*` as a shortcut), then real mouse clicks and typed keystrokes against
 * the rendered Ask card. */
async function runAskChecks(cdp, evidenceDir, { repoDir, message }) {
  try {
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness checklist all green (Add repository enabled)' },
    );
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);

    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Repository added, session-list row rendered' },
    );

    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open, branches loaded, Create session enabled' },
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed after Create session' });

    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Session opened, agent attached, composer enabled',
    });

    await cdp.typeIntoByLabel('Message', message);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.includes(${JSON.stringify(message)}); })()`,
      { timeoutMs: 30_000, label: 'Sent message rendered in transcript' },
    );

    // --- The Ask card itself: wait for the two-question tab row. ---
    await cdp.waitFor(`document.querySelectorAll('[role="tab"]').length === 2`, { timeoutMs: 30_000, label: 'Ask card tab row rendered (2 tabs)' });
    const tabTitles = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="tab"]')).map((el) => { const span = el.querySelector('span'); return span ? span.textContent.trim() : null; })`);
    assert(JSON.stringify(tabTitles) === JSON.stringify(['Database', 'Features']), `tab row should read Database, Features in request order: ${JSON.stringify(tabTitles)}`);
    const databaseTab = await getTabInfo(cdp, 'Database');
    // Gate-fix (round 1): `data-state` is unreliable on this element (Tooltip's own asChild
    // merge overwrites it with its own open/closed value), so the active tab is read from
    // `aria-selected` instead, which Tabs sets independently and Tooltip never touches.
    assert(databaseTab && databaseTab.ariaSelected === 'true', `Database tab should be active by default (first question, never-opened tab row): ${JSON.stringify(databaseTab)}`);
    const sqliteRow = await getRoleLabelInfo(cdp, 'radio', 'SQLite');
    // D11/D31 (gate round 1): the muted marker is a comma-separated word, "SQLite, Recommended" --
    // never "(Recommended)" in parentheses.
    assert(sqliteRow && sqliteRow.text.includes(', Recommended'), `SQLite row should read ", Recommended" (recommended:1 on the Database question): ${JSON.stringify(sqliteRow)}`);
    await cdp.screenshot(path.join(ASK_SHOT_DIR, '01-tab-row-database-active.png'));

    // Click Postgres (NOT the recommended SQLite) -- a genuine user choice, not accepting the default.
    await clickRoleLabel(cdp, 'radio', 'Postgres');
    await cdp.waitFor(
      `(() => { const el = ${roleLabelFinder('radio', 'Postgres')}; return !!el && el.getAttribute('aria-checked') === 'true'; })()`,
      { timeoutMs: 15_000, label: 'Postgres row becomes checked after clicking it' },
    );
    await cdp.screenshot(path.join(ASK_SHOT_DIR, '02-postgres-selected.png'));

    // Switch to the Features tab.
    await cdp.click(tabFinder('Features'));
    await cdp.waitFor(`(() => { const el = ${tabFinder('Features')}; return !!el && el.getAttribute('aria-selected') === 'true'; })()`, {
      timeoutMs: 15_000,
      label: 'Features tab becomes active',
    });

    // Tick Auth and Search (not Billing), tick Other and type "Beta" into its Other input.
    await clickRoleLabel(cdp, 'checkbox', 'Auth');
    await cdp.waitFor(
      `(() => {
        const els = Array.from(document.querySelectorAll('[role="checkbox"]'));
        const el = els.find((e) => { const s = e.querySelector('.font-medium'); const n = s && s.firstChild; return !!n && n.nodeValue && n.nodeValue.trim() === 'Auth'; });
        return !!el && el.getAttribute('aria-checked') === 'true';
      })()`,
      { timeoutMs: 15_000, label: 'Auth checkbox becomes checked' },
    );
    await clickRoleLabel(cdp, 'checkbox', 'Search');
    await cdp.waitFor(
      `(() => {
        const els = Array.from(document.querySelectorAll('[role="checkbox"]'));
        const el = els.find((e) => { const s = e.querySelector('.font-medium'); const n = s && s.firstChild; return !!n && n.nodeValue && n.nodeValue.trim() === 'Search'; });
        return !!el && el.getAttribute('aria-checked') === 'true';
      })()`,
      { timeoutMs: 15_000, label: 'Search checkbox becomes checked' },
    );
    await clickRoleLabel(cdp, 'checkbox', 'Other');
    await cdp.waitFor(
      `(() => {
        const els = Array.from(document.querySelectorAll('[role="checkbox"]'));
        const el = els.find((e) => { const s = e.querySelector('.font-medium'); const n = s && s.firstChild; return !!n && n.nodeValue && n.nodeValue.trim() === 'Other'; });
        return !!el && el.getAttribute('aria-checked') === 'true';
      })()`,
      { timeoutMs: 15_000, label: 'Other checkbox becomes checked' },
    );
    await cdp.typeIntoByLabel('Other answer', 'Beta');
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Other answer"]'); return !!el && el.value === 'Beta'; })()`, {
      timeoutMs: 10_000,
      label: 'Other answer input reads "Beta"',
    });
    await cdp.screenshot(path.join(ASK_SHOT_DIR, '03-features-tab-ticked.png'));

    // Both questions are now complete: the primary button reads Submit, not Next.
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Submit')`,
      { timeoutMs: 15_000, label: 'Primary button reads Submit (both questions complete)' },
    );
    // Gate round 3 (architect M-1): drive Submit via REAL keyboard (Tab, Tab, Enter) from the
    // Other input's own focus, not a mouse click -- Chromium suppresses `:focus-visible` after a
    // mouse-driven focus (which is exactly why the earlier mouse-click screenshot showed no
    // ring, expected there but not proof either way for the keyboard path this decision record
    // actually cares about). Tab order: Other input -> Cancel -> Submit.
    await pressTab(cdp)
    await pressTab(cdp)
    const focusedIsSubmitButton = await cdp.evaluate(
      `!!document.activeElement && document.activeElement.tagName === 'BUTTON' && document.activeElement.textContent.trim() === 'Submit'`,
    );
    assert(focusedIsSubmitButton, 'Tab, Tab from the Other input did not land keyboard focus on the Submit button');
    await cdp.pressEnter();

    // The card resolves: its own Cancel/Submit footer is gone (no tab row, no Submit/Next button
    // left anywhere), and the transcript's own `ask` tool item supersedes it with the collapsed
    // "Asked user:" summary row.
    await cdp.waitFor(`document.querySelectorAll('[role="tab"]').length === 0`, { timeoutMs: 30_000, label: 'Ask card footer/tab row gone after Submit' });
    await cdp.waitFor(
      `!Array.from(document.querySelectorAll('button')).some((el) => { const t = el.textContent.trim(); return t === 'Submit' || t === 'Next' || t === 'Cancel'; })`,
      { timeoutMs: 15_000, label: 'No Cancel/Submit/Next button left in the document' },
    );
    await cdp.waitFor(`document.body.textContent.includes('Which database? and 1 more')`, {
      timeoutMs: 30_000,
      label: 'Collapsed "Asked user: Which database? and 1 more" summary line rendered',
    });
    const summaryRowText = await cdp.evaluate(`(() => { const el = ${askRowTriggerFinder()}; return el ? el.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
    assert(summaryRowText && summaryRowText.includes('Asked user:') && summaryRowText.includes('Which database? and 1 more'), `collapsed summary row text unexpected: ${JSON.stringify(summaryRowText)}`);

    // D17 (gate round 2): focus must land on the collapsed "Asked user:" row's own trigger, not
    // fall to <body> -- proves the ask-focus-intent handoff (AskCard -> ResolvedRequestSummary/
    // AskQuestionRow) actually fires on a REAL unmount, not just by reading the source.
    //
    // Gate round 3 (test review L-b): the earlier version checked `textContent.includes('Asked
    // user:')`, which would ALSO pass if focus had landed on the transcript viewport (the user's
    // own echoed prompt plus "Asked user:" both sit inside it) -- this now asserts strict element
    // identity against the same `askRowTriggerFinder()` the rest of this script already uses.
    const focusIsTheRow = await cdp.evaluate(`document.activeElement === ${askRowTriggerFinder()}`);
    const focusedTextContent = await cdp.evaluate(
      `(() => { const a = document.activeElement; return a ? a.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80) : null; })()`,
    );
    assert(focusedTextContent !== null, `focus fell to <body> after Submit (D17 regression): textContent ${JSON.stringify(focusedTextContent)}`);
    assert(focusIsTheRow, `focus after Submit landed on an element other than the "Asked user:" row's own trigger: textContent ${JSON.stringify(focusedTextContent)}`);
    // Gate round 3 (architect M-3, code review): `textContent` joins adjacent spans with no
    // separator and is NOT the accessible name despite round 2's field calling it that -- read
    // the real, computed accessible name through the CDP Accessibility domain instead.
    const focusedAxName = await getActiveElementAccessibleName(cdp);
    // Gate round 3 (architect M-1): is the focus ring actually visible, and if not, why -- taken
    // HERE (focus already confirmed on the row), not right after pressEnter, since the earlier
    // screenshot could race the backend round trip and capture a transitional frame.
    const ringDiag = await cdp.evaluate(`(() => {
      const el = document.activeElement;
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { matchesFocusVisible: el.matches(':focus-visible'), outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, outlineOffset: cs.outlineOffset };
    })()`);
    console.log(`verify-tauri-ask: focus after Submit -- element is the Asked-user row: ${focusIsTheRow}; textContent: ${JSON.stringify(focusedTextContent)}; real accessible name (AX tree): ${JSON.stringify(focusedAxName)}; focus-ring diagnostic: ${JSON.stringify(ringDiag)}`);
    await cdp.screenshot(path.join(ASK_SHOT_DIR, '04-submit-clicked.png'));
    // Gate round 3 (architect M-1): a tight `clip` around the row's own bounding rect, scaled up
    // -- the full-window screenshot above renders this row at under 30px tall, too small for a
    // 2px ring to read reliably by eye even when the computed style above confirms it is there.
    const rowRect = await cdp.evaluate(
      `(() => { const el = ${askRowTriggerFinder()}; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
    );
    const { data: closeUpData } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.max(rowRect.x - 8, 0), y: Math.max(rowRect.y - 8, 0), width: rowRect.width + 16, height: rowRect.height + 16, scale: 3 },
    });
    writeFileSync(path.join(ASK_SHOT_DIR, '04b-submit-focus-ring-closeup.png'), Buffer.from(closeUpData, 'base64'));

    // Expand it and assert both questions' own Answer rows.
    await cdp.click(askRowTriggerFinder());
    await cdp.waitFor(`document.body.textContent.includes('Answer: Verify Tauri Ask: Postgres')`, {
      timeoutMs: 15_000,
      label: 'Database question\'s own Answer row reads "Postgres"',
    });
    await cdp.waitFor(`document.body.textContent.includes('Answer: Verify Tauri Ask: Auth, Search, Other: Beta')`, {
      timeoutMs: 15_000,
      label: 'Features question\'s own Answer row reads "Auth, Search, Other: Beta"',
    });
    await cdp.screenshot(path.join(ASK_SHOT_DIR, '05-resolved-summary-expanded.png'));

    // The turn itself completes after the Ask card resolves: the assistant's own streamed reply
    // (ask.jsonl's own distinct token) still arrives, proving the structured-dialog answer let the
    // rest of the turn proceed normally, not just that the dialog's own round trip resolved.
    await waitForStreamedReply(cdp, { finalToken: REPLY_TOKEN, timeoutMs: 30_000 });

    console.log('PASS: Ask card tab row, radio rows, tick-box rows, Other input, footer, and the resolved/expanded answered summary all verified against real DOM input.');
  } catch (err) {
    const diag = await cdp.evaluate(`({ bodyText: document.body?.innerText?.slice(0, 2000) })`).catch(() => ({ bodyText: '(evaluate failed)' }));
    console.error('verify-tauri-ask: FAIL; page diagnostics:', JSON.stringify(diag, null, 2));
    await cdp.screenshot(path.join(evidenceDir, 'diag-failure.png')).catch(() => {});
    throw err;
  }
}

async function main() {
  mkdirSync(ASK_SHOT_DIR, { recursive: true });
  let shimDir, dataDir, importSourceDir, repoDir, exeDir, evidenceDir;
  let child;
  let cdp;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-ask-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-ask-data-'));
    // Isolation (refract-tauri-live-check-isolation skill): an EMPTY scratch import source, so a
    // debug build's one-time Electron-registry import never reads Stuart's real `%APPDATA%\pinion`.
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-ask-import-src-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-ask-repo-')));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-ask-exe-'));
    evidenceDir = withEvidenceDir('run');

    console.log(`verify-tauri-ask: data dir ${dataDir}`);
    console.log(`verify-tauri-ask: evidence dir ${evidenceDir}`);
    console.log(`verify-tauri-ask: screenshot dir ${ASK_SHOT_DIR}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    console.log('verify-tauri-ask: building (tauri build --debug --no-bundle)...');
    buildTauriDebugNoBundle();

    const exePath = copyBuiltExe(exeDir);
    const port = await getFreePort();
    const debugLogPath = path.join(evidenceDir, 'fake-omp-invocations.log');
    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(evidenceDir, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: debugLogPath,
        REFRACT_FAKE_OMP_SCENARIO: 'ask',
      },
    });
    child = launched.child;
    cdp = await connectCdp(port, launched.targetPid);

    await runAskChecks(cdp, evidenceDir, { repoDir, message: PROMPT_MESSAGE });

    // Gate-fix (round 1, test review Medium): the scripted tape answers with a fixed reply
    // regardless of what Refract actually sent, so the resolved summary rendering correctly
    // proves only that `ask.jsonl`'s own scripted `details.results[]` matches what this script
    // expects -- it does NOT by itself prove the D4 wire payload (`buildAnswers`'s real output).
    // `REFRACT_FAKE_OMP_DEBUG_LOG` above already logs every RECV'd command verbatim; pull the
    // real `extension_ui_response` out of it here so the exact payload can be quoted as evidence.
    const debugLogText = readFileSync(debugLogPath, 'utf8');
    const recvAnswerLine = debugLogText
      .split('\n')
      .find((line) => line.includes('RECV') && line.includes('"extension_ui_response"') && line.includes('"answers"'));
    assert(!!recvAnswerLine, `no RECV extension_ui_response line with an "answers" payload found in ${debugLogPath}`);
    const recvMatch = recvAnswerLine.match(/RECV (\{.*\}) \(waitingFor/);
    assert(!!recvMatch, `RECV line did not match the expected "RECV <json> (waitingFor...)" shape: ${recvAnswerLine}`);
    const sentPayload = JSON.parse(recvMatch[1]);
    assert(sentPayload.type === 'extension_ui_response', `sent payload has the wrong type: ${JSON.stringify(sentPayload)}`);
    assert(Array.isArray(sentPayload.answers) && sentPayload.answers.length === 2, `sent payload should carry exactly 2 answers: ${JSON.stringify(sentPayload)}`);
    const [dbAnswer, featuresAnswer] = sentPayload.answers;
    assert(dbAnswer.id === 'db' && JSON.stringify(dbAnswer.selectedOptions) === JSON.stringify(['Postgres']) && dbAnswer.customInput === undefined, `db answer did not match the real click (Postgres, no customInput): ${JSON.stringify(dbAnswer)}`);
    assert(
      featuresAnswer.id === 'features' &&
        JSON.stringify(featuresAnswer.selectedOptions) === JSON.stringify(['Auth', 'Search']) &&
        featuresAnswer.customInput === 'Beta',
      `features answer did not match the real ticks/typing (Auth, Search, Other: Beta): ${JSON.stringify(featuresAnswer)}`
    );
    console.log(`REAL extension_ui_response sent by Refract (D4 wire payload, from ${debugLogPath}):`);
    console.log(JSON.stringify(sentPayload));

    console.log(`verify-tauri-ask: ALL PASS. Evidence: ${evidenceDir}. Screenshots: ${ASK_SHOT_DIR}`);
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child);
    await safeRmSync(shimDir);
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    if (repoDir) await safeRmSync(worktreesDirFor(repoDir));
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-ask: FAIL');
  console.error(err);
  process.exitCode = 1;
});
