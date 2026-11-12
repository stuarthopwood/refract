#!/usr/bin/env node
// Live CDP check for issue #1831: the combined HTML-form ask card, against the scratch Tauri debug build and the REAL omp
// (18.18.3, Probe520 copy) pointed at a scratch HOME and an in-process mock model. No real model is ever called.
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-tauri-1831.mjs
// Env: REFRACT_1831_SHOTS_DIR overrides the evidence directory; REFRACT_1831_OMP_EXE overrides the real omp binary.

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
const LOG = 'verify-1831';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1831_SHOTS_DIR || 'C:/Users/shopwood/refract-live-check-1831';
const OMP_EXE = process.env.REFRACT_1831_OMP_EXE || 'C:/Users/shopwood/AppData/Local/Temp/Probe520/bin/omp-windows-x64.exe';
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
const LIVE_TITLES = `Array.from(document.querySelectorAll('*')).filter((el) => el.children.length === 0 && el.textContent.trim() === 'Questions from the agent' && !el.closest('[role="group"]'))`;
const HISTORY_CARDS = `Array.from(document.querySelectorAll('[role="group"][aria-label^="Questions from the agent"]'))`;
const FOCUS = `(() => { const a = document.activeElement; return { tag: a?.tagName ?? null, role: a?.getAttribute?.('role') ?? null, label: a?.getAttribute?.('aria-label') ?? null, isBody: !a || a === document.body }; })()`;

async function shoot(cdp, name) {
  await sleep(500);
  await cdp.screenshot(path.join(SHOTS_DIR, name));
  shotNames.push(name);
}

/** The card is taller than the window, so scroll the target into view first: a mouse event at off-screen coordinates hits nothing. */
async function clickVisible(cdp, finder) {
  await cdp.waitFor(`(() => { const el = ${finder}; if (!el) return false; el.scrollIntoView({ block: 'center' }); return true; })()`, { timeoutMs: 15_000, label: `scroll target into view: ${finder.slice(0, 80)}` });
  await sleep(150);
  await cdp.click(finder);
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
  const scratch = (label) => mkdtempSync(path.join(tmpdir(), `refract-1831-${label}-`));
  const [dataDir, importSourceDir, repoDirBase, exeDir, launcherDir, shimDir, ompHome] = ['data', 'import', 'repo', 'exe', 'launcher', 'shim', 'home'].map(scratch);
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1831');
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
    const titles = await cdp.evaluate(`${LIVE_TITLES}.length`);
    const expected = ['Which database?', 'Which features?', 'Why this stack?, required', 'Team name', 'Owner'];
    check(titles === 1 && expected.every((q, i) => headings[i] === q) && headings.length === expected.length, '1. One combined card renders for the ask (one title, five field headings in form order)', { titles, headings });
    await shoot(cdp, '01-combined-card-rendered.png');

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

    await clickVisible(cdp, SUBMIT);
    const toolResult = await waitForToolResult(mock, 1);
    const afterSubmit = await focusAfterCardLeaves(cdp);
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
    await shoot(cdp, '07-after-esc-cancel-focus.png');
    // A cancelled ask may end the turn with no further model request, so the absence is recorded rather than failed.
    const cancelResult = await waitForToolResult(mock, 2).catch((err) => `no second tool result reached the model: ${err.message}`);
    report.push({ step: 'Esc: tool result the agent received for the cancelled ask', ok: true, evidence: cancelResult });
    // The wire log is written by the omp wrapper as frames arrive, so the aborted turn end can lag the tool result by a moment.
    await sleep(1_500);
    const cancelWire = analyseCancelWire();
    check(cancelWire.found && cancelWire.isError, `6d. Wire: the ask tool_execution_end carries "${CANCEL_SENTENCE}" with isError true`, { found: cancelWire.found, isError: cancelWire.isError, result: cancelWire.result });
    check(cancelWire.aborted, '6e. Wire: the cancelled turn ends with stopReason "aborted"', { stopReason: cancelWire.stopReason, stopFrameType: cancelWire.stopFrameType });

    // 6a/6b repeated: the first runs above plus four more of each, so five of each in one session with focus recorded per run.
    const repeats = { '6a': [{ run: 1, samples: afterSubmit }], '6b': [{ run: 1, samples: afterEsc }] };
    for (let run = 2; run <= 5; run++) {
      await sendPrompt(cdp, `SECOND ask please, submit run ${run}.`);
      await cdp.waitFor(`!!${field('Proceed with the rollout?')}`, { timeoutMs: 90_000, label: `submit run ${run} card rendered` });
      await clickVisible(cdp, `Array.from(${field('Proceed with the rollout?')}?.querySelectorAll('[role="radio"]') ?? []).find((el) => document.getElementById(el.getAttribute('aria-labelledby'))?.textContent.trim() === 'Yes')`);
      await cdp.waitFor(`(${SUBMIT})?.getAttribute('aria-disabled') === 'false'`, { timeoutMs: 10_000, label: 'Submit enabled' });
      await clickVisible(cdp, SUBMIT);
      repeats['6a'].push({ run, samples: await focusAfterCardLeaves(cdp) });
      await sendPrompt(cdp, `SECOND ask please, esc run ${run}.`);
      await cdp.waitFor(`!!${field('Proceed with the rollout?')}`, { timeoutMs: 90_000, label: `esc run ${run} card rendered` });
      await clickVisible(cdp, RADIO_NO);
      await pressEscape(cdp);
      repeats['6b'].push({ run, samples: await focusAfterCardLeaves(cdp) });
    }
    for (const key of ['6a', '6b']) {
      check(repeats[key].length === 5 && repeats[key].every((r) => r.samples.every((s) => !s.isBody)), `${key} x5. document.activeElement is never body across five runs in one session`, repeats[key].map((r) => ({ run: r.run, activeElement: r.samples.map((s) => `${s.tag}${s.label ? `[${s.label}]` : ''}`) })));
    }

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
