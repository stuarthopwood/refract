#!/usr/bin/env node
// Live CDP check for issue #1941: the ask card's accessible name, keyboard pass and focus ring (reuses the #1831 harness), against the scratch Tauri debug build and the REAL omp
// (18.18.3, Probe520 copy) pointed at a scratch HOME and an in-process mock model. No real model is ever called.
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-tauri-1941.mjs
// Env: REFRACT_1941_SHOTS_DIR overrides the evidence directory; REFRACT_1831_OMP_EXE overrides the real omp binary.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getFreePort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget, gitHead, computeDirty, sha256OfFile, buildAndCopyExeFresh } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe, buildOmpShim, connectCdp, pressRealEnter, worktreesDirFor } from './verify-tauri-560-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, pressEscape } from './verify-tauri-session-list-helpers.mjs';
import { startMockModel } from './verify-tauri-1831-mock-model.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1941';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1941_SHOTS_DIR || 'C:/Users/shopwood/AppData/Local/Temp/scratch/refract-live-1941/evidence';
const OMP_EXE = process.env.REFRACT_1831_OMP_EXE || 'C:/Users/shopwood/AppData/Local/Temp/scratch/refract-live-1941/omp/omp-windows-x64.exe';
const PROFILE = 'probe520';
const MODEL = 'probe-mock/probe-model';
const WIRE_LOG = path.join(SHOTS_DIR, 'wire.jsonl');
const MOCK_LOG = path.join(SHOTS_DIR, 'mock-requests.jsonl');
const ANSWERS = { other: 'MariaDB', why: 'Boring and well understood', team: 'Core', owner: 'platform' };

const report = [];
const shotNames = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
  if (ok !== true) process.exitCode = 1;
}

const HEADINGS = `Array.from(document.querySelectorAll('p[id^="ask-form-"][id$="-heading"]'))`;
const field = (question) => `(${HEADINGS}.find((p) => p.textContent.startsWith(${JSON.stringify(question)}))?.parentElement)`;
const otherRadio = (q) => `${field(q)}?.querySelector('[role="radio"][aria-label="Other"]')`;
const otherInput = (q) => `document.querySelector('[aria-label=${JSON.stringify(`Other answer for ${q}`)}]')`;
const checkbox = (q, label) =>
  `Array.from(${field(q)}?.querySelectorAll('[role="checkbox"]') ?? []).find((el) => document.getElementById(el.getAttribute('aria-labelledby'))?.textContent.trim() === ${JSON.stringify(label)})`;
const control = (q, tag) => `${field(q)}?.querySelector('${tag}')`;
const SUBMIT = `Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim().startsWith('Submit'))`;
const LIVE_CARDS = `Array.from(document.querySelectorAll('[role="group"][aria-label="Questions from the agent"]:not([tabindex])'))`;
const HISTORY_CARDS = `Array.from(document.querySelectorAll('[role="group"][aria-label^="Questions from the agent"][tabindex="-1"]'))`;
const FOCUS = `(() => { const a = document.activeElement; return { tag: a?.tagName ?? null, role: a?.getAttribute?.('role') ?? null, label: a?.getAttribute?.('aria-label') ?? null, isBody: !a || a === document.body }; })()`;

async function shoot(cdp, name) {
  await sleep(500);
  await cdp.screenshot(path.join(SHOTS_DIR, name));
  shotNames.push(name);
}

/** Crops the screenshot to the focused element plus a margin, so the ring is visible at full resolution. */
async function shootActive(cdp, name) {
  await sleep(500);
  const r = await cdp.evaluate(`(() => { const a = document.activeElement; a.scrollIntoView({ block: 'center' }); const b = a.getBoundingClientRect(); return { x: Math.max(0, b.x - 8 + scrollX), y: Math.max(0, b.y - 8 + scrollY), width: Math.min(b.width + 16, 1400), height: Math.min(b.height + 16, 600) }; })()`);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 2 } });
  writeFileSync(path.join(SHOTS_DIR, name), Buffer.from(data, 'base64'));
  shotNames.push(name);
}

/** The card is taller than the window, so scroll the target into view first: a mouse event at off-screen coordinates hits nothing. */
async function clickVisible(cdp, finder) {
  await cdp.waitFor(`(() => { const el = ${finder}; if (!el) return false; el.scrollIntoView({ block: 'center' }); return true; })()`, { timeoutMs: 15_000, label: `scroll target into view: ${finder.slice(0, 80)}` });
  await sleep(150);
  await cdp.click(finder);
}

const FOCUS_DETAIL = `(() => { const a = document.activeElement; const cs = a ? getComputedStyle(a) : null; const lab = a?.getAttribute?.('aria-labelledby'); const name = a?.getAttribute?.('aria-label') || (lab ? document.getElementById(lab)?.textContent.trim() : '') || a?.textContent?.trim() || ''; return { tag: a?.tagName ?? null, role: a?.getAttribute?.('role') ?? null, name, inLiveCard: !!a?.closest?.('[role="group"][aria-label="Questions from the agent"]:not([tabindex])'), outline: cs ? cs.outlineStyle + ' ' + cs.outlineWidth : null, shadow: cs ? cs.boxShadow : null, ring: !!cs && ((cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px') || /[1-9][\\d.]*px(?:,|$)/.test(cs.boxShadow.replace(/ inset/, ''))) }; })()`;
/** A real key press (not a synthetic DOM event) so Tab moves focus and Space reaches the control's own handler. */
async function pressKey(cdp, key, vk, text) {
  await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', windowsVirtualKeyCode: vk, key, code: key === ' ' ? 'Space' : key, ...(text ? { text } : {}) });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: vk, key, code: key === ' ' ? 'Space' : key });
}
async function typeInto(cdp, finder, text) {
  await clickVisible(cdp, finder);
  await cdp.send('Input.insertText', { text });
}

async function sendPrompt(cdp, text) {
  await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'composer enabled' });
  await cdp.click(`document.querySelector('[aria-label="Message"]')`);
  await cdp.send('Input.insertText', { text });
  await pressRealEnter(cdp);
}

/** Samples focus until the live card is gone and for a further second, so a transient drop to body is still reported. */
async function focusAfterCardLeaves(cdp) {
  await cdp.waitFor(`!(${SUBMIT})`, { timeoutMs: 30_000, label: 'live card gone (no Submit button)' });
  const samples = [];
  for (let i = 0; i < 5; i++) {
    samples.push(await cdp.evaluate(FOCUS));
    await sleep(250);
  }
  return samples;
}

const readJsonl = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

/** Pairs each per-field `extension_ui_request` omp sent with the response Refract returned, from the wrapper's wire log. */
function analyseWire() {
  const lines = readJsonl(WIRE_LOG);
  const requests = lines.filter((l) => l.dir === 'omp->refract' && l.frame?.type === 'extension_ui_request' && ['select', 'input', 'editor'].includes(l.frame.method));
  const responses = new Map(lines.filter((l) => l.dir === 'refract->omp' && l.frame?.type === 'extension_ui_response').map((l) => [l.frame.id, l.frame]));
  const frames = requests.map(({ frame }) => ({ method: frame.method, title: frame.title, options: frame.options, prefill: frame.prefill, response: responses.get(frame.id) ?? null }));
  const selectOptions = frames.filter((f) => f.method === 'select').flatMap((f) => f.options ?? []);
  return {
    frames,
    methods: [...new Set(frames.map((f) => f.method))],
    selectedPrefixSeen: frames.some((f) => f.method === 'select' && /^\(\d+ selected\) /.test(f.title ?? '')),
    otherRowText: selectOptions.find((o) => /^Other/.test(o)) ?? null,
    doneRowText: selectOptions.find((o) => /Done selecting/.test(o)) ?? null
  };
}

const CANCEL_SENTENCE = 'Ask tool was cancelled by the user';

/** Finds, in the wire log, the ask `tool_execution_end` carrying the cancel sentence and whether the turn then ended with stopReason "aborted". */
function analyseCancelWire() {
  const lines = readJsonl(WIRE_LOG).filter((l) => l.dir === 'omp->refract');
  const endIdx = lines.findIndex((l) => l.frame?.type === 'tool_execution_end' && l.frame.toolName === 'ask' && JSON.stringify(l.frame.result ?? '').includes(CANCEL_SENTENCE));
  const end = endIdx < 0 ? null : lines[endIdx].frame;
  const stop = endIdx < 0 ? undefined : lines.slice(endIdx).find((l) => JSON.stringify(l.frame ?? '').includes('"stopReason":"aborted"'));
  return { found: end !== null, isError: end?.isError === true, aborted: stop !== undefined, stopReason: stop ? 'aborted' : null, stopFrameType: stop?.frame?.type ?? null, result: end?.result ?? null };
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  writeFileSync(WIRE_LOG, '');
  writeFileSync(MOCK_LOG, '');
  const scratch = (label) => mkdtempSync(path.join(tmpdir(), `refract-1941-${label}-`));
  const [dataDir, importSourceDir, repoDirBase, exeDir, launcherDir, shimDir, ompHome] = ['data', 'import', 'repo', 'exe', 'launcher', 'shim', 'home'].map(scratch);
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1941');
  const dirs = [dataDir, importSourceDir, repoDirBase, worktreesDirFor(repoDir), exeDir, launcherDir, shimDir, ompHome];
  let cdp;
  let child;
  let mock;
  try {
    if (!existsSync(OMP_EXE)) throw new Error(`real omp binary not found at ${OMP_EXE}`);
    const agentDir = path.join(ompHome, '.omp', 'profiles', PROFILE, 'agent');
    mkdirSync(agentDir, { recursive: true });
    const mockPort = await getFreePort();
    writeFileSync(path.join(agentDir, 'models.yml'), ['providers:', '  probe-mock:', `    baseUrl: http://127.0.0.1:${mockPort}/v1`, '    auth: none', '    api: openai-completions', '    models:', '      - id: probe-model', '        name: Probe Model', '        api: openai-completions', '        contextWindow: 8000', '        maxTokens: 1000', ''].join('\n'));
    writeFileSync(path.join(agentDir, 'config.yml'), `modelRoles:\n  default: ${MODEL}\n`);
    mock = await startMockModel({ port: mockPort, logFile: MOCK_LOG });

    const launcherExe = buildLauncher(launcherDir);
    buildOmpShim(shimDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    report.push({ step: 'build identity', ok: true, evidence: { head: gitHead(REPO_ROOT), dirty: computeDirty(REPO_ROOT), exeSha256: built.hash, exeMtime: built.mtime, builtDuringThisRun: built.builtDuringThisRun, ompExe: OMP_EXE, ompExeSha256: sha256OfFile(OMP_EXE) } });
    check([exeDir, dataDir, importSourceDir, ompHome].every((d) => d.startsWith(tmpdir())), 'Isolation: exe, data dir, import source and omp HOME are scratch dirs; the real ~/.omp is never used', { dataDir, ompHome });

    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, built.dest, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-1831-omp-wrapper.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_1831_OMP_EXE: OMP_EXE,
        REFRACT_1831_OMP_HOME: ompHome,
        REFRACT_1831_WIRE_LOG: WIRE_LOG,
        REFRACT_1831_MODEL: MODEL,
        REFRACT_1831_PROFILE: PROFILE
      }
    });
    child = launched.child;
    cdp = await connectCdp(port, launched.targetPid);

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]') || !!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 60_000, label: 'Readiness or main screen' });
    if (await cdp.evaluate(`!document.querySelector('[aria-label="Settings"]')`)) {
      await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 90_000, label: 'Readiness green' });
      await addRepository(cdp, repoDir);
    }
    await createSessionViaQuickCreate(cdp, path.basename(repoDir));
    await sendPrompt(cdp, 'Use the ask tool to ask me about the stack.');

    // 1. One combined card for the whole form.
    await cdp.waitFor(`!!${field('Which database?')} && !!${field('Owner')}`, { timeoutMs: 90_000, label: 'combined ask card rendered' });
    const headings = await cdp.evaluate(`${HEADINGS}.map((p) => p.textContent)`);
    const titles = await cdp.evaluate(`${LIVE_CARDS}.length`);
    const expected = ['Which database?', 'Which features?', 'Why this stack?, required', 'Team name', 'Owner'];
    check(titles === 1 && expected.every((q, i) => headings[i] === q) && headings.length === expected.length, '1. One combined card renders for the ask (one live group, five field headings in form order)', { titles, headings });
    await shoot(cdp, '01-combined-card-rendered.png');

    // A11y 1. The live card is one named group that is not itself a focus target; its name matches the finished-card prefix.
    const liveCard = await cdp.evaluate(`(() => { const g = ${LIVE_CARDS}; return { count: g.length, label: g[0]?.getAttribute('aria-label') ?? null, hasSubmit: !!g[0]?.querySelector('button[aria-disabled]'), tabindex: g[0]?.getAttribute('tabindex') ?? null }; })()`);
    check(liveCard.count === 1 && liveCard.label === 'Questions from the agent' && liveCard.hasSubmit && liveCard.tabindex === null, 'A1. The live card is one role="group" named "Questions from the agent", not a tab stop', liveCard);

    // A11y 2. Keyboard-only: Tab through the card; every stop is inside it, has an accessible name and a visible focus ring.
    await cdp.evaluate(`(() => { const c = ${field('Which database?')}; c.querySelector('[role="radio"]').focus(); })()`);
    const stops = [];
    for (let i = 0; i < 14; i++) {
      stops.push(await cdp.evaluate(FOCUS_DETAIL));
      await pressKey(cdp, 'Tab', 9);
      await sleep(120);
    }
    await shoot(cdp, '01b-keyboard-focus-ring.png');
    const inCard = stops.filter((s) => s.inLiveCard);
    check(inCard.length >= 5 && inCard.every((s) => s.name), 'A2. Tabbing through the live card: every stop has an accessible name', stops);
    // Text fields mark focus with a border colour instead of a ring, so they are recorded in A2 but not asserted here.
    check(inCard.filter((s) => s.tag === 'BUTTON').every((s) => s.ring), 'A3. Every focused button/radio/checkbox in the card shows a visible focus ring (outline or non-zero box-shadow spread)', inCard.map((s) => ({ name: s.name, outline: s.outline, shadow: s.shadow })));
    check(inCard.some((s) => s.tag === 'BUTTON' && /^Submit/.test(s.name)) && inCard.some((s) => s.tag === 'BUTTON' && /^Cancel/.test(s.name)), 'A4. Keyboard reaches both Submit and Cancel', inCard.map((s) => s.name));

    // A11y 5. Space toggles a checkbox from the keyboard.
    await cdp.evaluate(`(${checkbox('Which features?', 'Auth')}).focus()`);
    await pressKey(cdp, ' ', 32, ' ');
    await sleep(200);
    const afterSpace = await cdp.evaluate(`(${checkbox('Which features?', 'Auth')}).getAttribute('aria-checked')`);
    await pressKey(cdp, ' ', 32, ' ');
    await sleep(200);
    const afterSpace2 = await cdp.evaluate(`(${checkbox('Which features?', 'Auth')}).getAttribute('aria-checked')`);
    check(afterSpace === 'true' && afterSpace2 === 'false', 'A5. Space toggles a checkbox on and off', { afterSpace, afterSpace2 });

    // 2. Submit stays aria-disabled until the required textarea is filled.
    const submitState = () => cdp.evaluate(`(${SUBMIT})?.getAttribute('aria-disabled')`);
    const initial = await submitState();
    await clickVisible(cdp, otherRadio('Which database?'));
    await cdp.waitFor(`!!${otherInput('Which database?')}`, { timeoutMs: 10_000, label: 'Other answer input shown' });
    await shoot(cdp, '02-other-row-selected-input-shown.png');
    await typeInto(cdp, otherInput('Which database?'), ANSWERS.other);
    await clickVisible(cdp, checkbox('Which features?', 'Auth'));
    await typeInto(cdp, control('Team name', 'input'), ANSWERS.team);
    const beforeRequired = await submitState();
    await shoot(cdp, '03-submit-disabled-required-textarea-empty.png');
    await typeInto(cdp, control('Why this stack?', 'textarea'), ANSWERS.why);
    await cdp.waitFor(`(${SUBMIT})?.getAttribute('aria-disabled') === 'false'`, { timeoutMs: 10_000, label: 'Submit enabled once the textarea is filled' }).catch(() => {});
    const afterRequired = await submitState();
    check(initial === 'true' && beforeRequired === 'true' && afterRequired === 'false', '2. Submit is aria-disabled until the required textarea is filled', { initial, beforeRequired, afterRequired });
    await shoot(cdp, '04-submit-enabled-all-answers-filled.png');

    // Submit by keyboard: reach the button with real Tab presses (a programmatic focus() after a mouse click is not :focus-visible, so it would show no ring) and press a real Enter.
    for (let i = 0; i < 6 && !(await cdp.evaluate(`document.activeElement === (${SUBMIT})`)); i++) {
      await pressKey(cdp, 'Tab', 9);
      await sleep(100);
    }
    const submitFocus = await cdp.evaluate(FOCUS_DETAIL);
    check(/^Submit/.test(submitFocus.name) && submitFocus.ring, 'A7. The focused Submit button has an accessible name and a visible focus ring', submitFocus);
    await shootActive(cdp, '01c-submit-focus-ring-cropped.png');
    await pressRealEnter(cdp);
    const toolResult = await waitForToolResult(mock, 1);
    const afterSubmit = await focusAfterCardLeaves(cdp);
    const restingFocus = await cdp.evaluate(FOCUS_DETAIL);
    await shootActive(cdp, '05b-resting-card-focus-ring-cropped.png');
    check(/^Questions from the agent: Which database/.test(restingFocus.name) && restingFocus.role === 'group' && restingFocus.ring, 'A6. After Enter-Submit, focus rests on the finished card: named by its first question, with a visible ring', restingFocus);
    check(afterSubmit.every((s) => !s.isBody), '6a. After Submit, document.activeElement is not body (sampled for 1s)', afterSubmit);
    await shoot(cdp, '05-after-submit-history-card-focus.png');

    const wire = analyseWire();
    check(toolResult.includes(ANSWERS.other), '3. Other with text is answered (the agent received the typed value)', { toolResult });
    const doneFrame = wire.frames.find((f) => f.method === 'select' && (f.options ?? []).some((o) => /Done selecting/.test(o)) && /^Which features\?/.test((f.title ?? '').replace(/^\(\d+ selected\) /, '')));
    const doneFrames = wire.frames.filter((f) => f.method === 'select' && f.title?.endsWith('Which features?'));
    const doneAnswered = doneFrames.at(-1)?.response?.value ?? null;
    check(!!doneFrame && /Done selecting/.test(String(doneAnswered)), '4. The checkbox Done row is sent automatically (last features frame answered with the Done row)', { doneAnswered, featureFrames: doneFrames.map((f) => ({ title: f.title, answered: f.response?.value ?? null })) });
    const needles = [ANSWERS.other, 'Auth', ANSWERS.why, ANSWERS.team, ANSWERS.owner];
    check(needles.every((n) => toolResult.includes(n)), '5. The agent tool result contains every answer', { toolResult, needles });
    writeFileSync(path.join(SHOTS_DIR, 'agent-tool-result.txt'), toolResult);

    // 6b. Esc on a second ask, with focus inside the card.
    await sendPrompt(cdp, 'SECOND ask please.');
    await cdp.waitFor(`!!${field('Proceed with the rollout?')}`, { timeoutMs: 90_000, label: 'second ask card rendered' });
    const RADIO_NO = `Array.from(${field('Proceed with the rollout?')}?.querySelectorAll('[role="radio"]') ?? []).find((el) => document.getElementById(el.getAttribute('aria-labelledby'))?.textContent.trim() === 'No')`;
    // Esc inside a text input must leave the card alone; only Esc elsewhere in the card cancels.
    await clickVisible(cdp, control('Note', 'input'));
    await pressEscape(cdp);
    await sleep(800);
    const submitAfterInputEsc = await cdp.evaluate(`(() => { const s = ${SUBMIT}; const a = document.activeElement; return { submitPresent: !!s, submitAriaDisabled: s?.getAttribute('aria-disabled') ?? null, focusedTag: a?.tagName ?? null, focusedInNoteInput: a === ${control('Note', 'input')} }; })()`);
    check(submitAfterInputEsc.submitPresent, '6f. Esc inside a text input does not cancel the card (Submit still present)', submitAfterInputEsc);
    await clickVisible(cdp, RADIO_NO);
    await shoot(cdp, '06-second-ask-focus-in-card-before-esc.png');
    await pressEscape(cdp);
    // The card shows its Cancelled note only until the replacement row mounts, so it is captured before waiting for focus to settle.
    const sawCancelled = await cdp.waitFor(`Array.from(document.querySelectorAll('[role="status"]')).some((el) => el.textContent.trim() === 'Cancelled')`, { timeoutMs: 5_000, label: 'Cancelled note on the card' }).then(() => true, () => false);
    await shoot(cdp, '06b-cancelled-card-state.png');
    check(sawCancelled, '6c. After Esc, the card shows its Cancelled state', { sawCancelled });
    const afterEsc = await focusAfterCardLeaves(cdp);
    check(afterEsc.every((s) => !s.isBody), '6b. After Esc on a second ask, document.activeElement is not body (sampled for 1s)', afterEsc);
    const escFocus = await cdp.evaluate(FOCUS_DETAIL);
    check(!!escFocus.name && escFocus.ring, '6g. After Esc, the focused element has an accessible name and a visible focus ring', escFocus);
    await shoot(cdp, '07-after-esc-cancel-focus.png');
    // A cancelled ask may end the turn with no further model request, so the absence is recorded rather than failed.
    const cancelResult = await waitForToolResult(mock, 2).catch((err) => `no second tool result reached the model: ${err.message}`);
    report.push({ step: 'Esc: tool result the agent received for the cancelled ask', ok: true, evidence: cancelResult });
    // The wire log is written by the omp wrapper as frames arrive, so the aborted turn end can lag the tool result by a moment.
    await sleep(1_500);
    const cancelWire = analyseCancelWire();
    check(cancelWire.found && cancelWire.isError, `6d. Wire: the ask tool_execution_end carries "${CANCEL_SENTENCE}" with isError true`, { found: cancelWire.found, isError: cancelWire.isError, result: cancelWire.result });
    check(cancelWire.aborted, '6e. Wire: the cancelled turn ends with stopReason "aborted"', { stopReason: cancelWire.stopReason, stopFrameType: cancelWire.stopFrameType });


    // 7. After a reload the read-only history card shows the answers.
    await cdp.send('Page.reload');
    const OPEN_FIRST_SESSION = `Array.from(document.querySelectorAll('[data-repository-id] li')).map((li) => Array.from(li.querySelectorAll('button')).find((b) => !(b.getAttribute('aria-label') || '').startsWith('More actions')))[0]`;
    await cdp.waitFor(`!!(${OPEN_FIRST_SESSION})`, { timeoutMs: 60_000, label: 'session list after reload' });
    const sawCard = await cdp.waitFor(`${HISTORY_CARDS}.length > 0`, { timeoutMs: 8_000 }).catch(() => false);
    if (!sawCard) await cdp.click(OPEN_FIRST_SESSION);
    await cdp.waitFor(`${HISTORY_CARDS}.some((c) => c.textContent.includes('Which database?'))`, { timeoutMs: 60_000, label: 'history card for the first ask' });
    const FIRST_CARD = `${HISTORY_CARDS}.find((c) => c.textContent.includes('Which database?'))`;
    // With a dozen asks in the session the first card sits in a deferred-render region where innerText is empty, so read the DOM text.
    const historyText = await cdp.evaluate(`${FIRST_CARD}.textContent`);
    check(needles.every((n) => historyText.includes(n)), '7. After a reload, the read-only history card shows the answers (DOM text of the first ask card)', { historyText });
    await shoot(cdp, '08-history-card-after-reload.png');

    report.push({ step: 'wire observations (omp 18.18.3)', ok: true, evidence: wire });
    check(wire.methods.includes('input') && wire.methods.includes('editor'), 'Wire: text fields arrive as input and textareas/prefilled inputs as editor', wire.frames.map((f) => `${f.method}: ${f.title}`));
    check(wire.selectedPrefixSeen, 'Wire: a "(N selected) " prefix appears on the checkbox-group select prompt', wire.frames.filter((f) => f.method === 'select').map((f) => f.title));
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    console.error(err);
    try { if (cdp) await cdp.screenshot(path.join(SHOTS_DIR, '99-crash.png')); } catch {}
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    if (mock) mock.server.close();
    const hashes = {};
    for (const name of [...shotNames, 'wire.jsonl', 'mock-requests.jsonl', 'agent-tool-result.txt']) {
      const file = path.join(SHOTS_DIR, name);
      if (existsSync(file)) hashes[name] = sha256OfFile(file);
    }
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(path.join(SHOTS_DIR, 'sha256.json'), JSON.stringify(hashes, null, 2));
    for (const dir of dirs) await safeRmSync(dir, LOG);
  }
  const failed = report.filter((r) => !r.ok);
  console.log(`${LOG}: ${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`}; evidence in ${SHOTS_DIR}`);
}

/** Waits for the Nth request whose last message is a tool result and returns that body: what the agent actually received. */
async function waitForToolResult(mock, nth) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const results = mock.requests.filter((r) => r.lastRole === 'tool');
    if (results.length >= nth) return results[nth - 1].lastContent;
    await sleep(250);
  }
  throw new Error(`the mock model never received tool result #${nth}`);
}

main();
