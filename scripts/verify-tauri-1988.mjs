#!/usr/bin/env node
// Live CDP check for #1988: the Asked-user line that replaces a finished refract_ask card.
// A serve-mode fake omp (the Session) replays refract_ask host_tool_call frames; the developer side is real CDP input.
// Covers: s1 answered with the recommended pick and a note (collapsed digest, expand toggle, keyboard focus ring on the card);
// s3 cancelled; s6 a spoofed `byAway: true` answer that must never read "by Away Mode".
// Not covered: s4 HTML-form answers (the fake omp only replays refract_ask host calls, no native `ask` with args.html), and
// relaunch/history scenarios (Away reload, old saved transcript), which are a follow-up.
// Usage: REFRACT_1988_ROOT=<task folder> REFRACT_1988_EXE=<private exe copy> node scripts/verify-tauri-1988.mjs

// Set REFRACT_1988_RED=1 to run one assertion with a deliberately wrong expectation (proves the checks can fail).

import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, assertExeMatchesProcess, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, sha256OfFile } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName, waitForSessionStatus } from './verify-tauri-560-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT = process.env.REFRACT_1988_ROOT;
const EXE = process.env.REFRACT_1988_EXE;
const RED = process.env.REFRACT_1988_RED === '1';
if (!ROOT || !EXE || !path.isAbsolute(ROOT) || !path.isAbsolute(EXE)) throw new Error('set absolute REFRACT_1988_ROOT and REFRACT_1988_EXE');
const EVIDENCE = path.join(ROOT, 'evidence');
for (const d of ['data', 'import', 'shim', 'launcher', 'repo', 'fake', 'serve']) mkdirSync(path.join(ROOT, d), { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });

const transcript = [];
const failures = [];
const log = (step, value) => transcript.push({ step, value });
const check = (ok, what, detail) => {
  log(`${ok ? 'PASS' : 'FAIL'}: ${what}`, detail);
  if (!ok) failures.push(`${what}: ${JSON.stringify(detail)}`);
};

const ROW = (role, label) => `Array.from(document.querySelectorAll('[role="${role}"]')).find((el) => el.querySelector('.col-start-2.break-words')?.firstChild?.nodeValue?.trim() === ${JSON.stringify(label)})`;
const EDITOR = (label) => `document.querySelector('textarea[aria-label="Note on ${label}"]')`;
const BUTTON_TEXT = (text) => `Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
// Finished lines are transcript rows; the newest is the last in the DOM, so each scenario reads the last one.
const LINE = `(Array.from(document.querySelectorAll('div[role=group][aria-label^="Questions from the agent"]')).at(-1))`;
const LINE_COUNT = `document.querySelectorAll('div[role=group][aria-label^="Questions from the agent"]').length`;
const TOGGLE = `${LINE}?.querySelector('button[aria-expanded]')`;
// The toggle's own text ends with its Expand/Collapse affordance.
const squash = (expr) => `(${expr})?.textContent.replace(/\\s+/g, ' ').replace(/(Expand|Collapse)$/, '').trim() ?? null`;

const key = (cdp, type, k, code, vk, extra = {}) => cdp.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, ...extra });
const press = async (cdp, k, code, vk, text) => {
  await key(cdp, 'keyDown', k, code, vk, text ? { text } : {});
  await key(cdp, 'keyUp', k, code, vk);
};
const pressEnter = (cdp) => press(cdp, 'Enter', 'Enter', 13, '\r');
const pressN = (cdp) => press(cdp, 'n', 'KeyN', 78, 'n');

async function main() {
  const dataDir = path.join(ROOT, 'data');
  const recordFile = path.join(ROOT, 'fake', 'host-tools.jsonl');
  const callsFile = path.join(ROOT, 'fake', 'host-calls.jsonl');
  const debugLog = path.join(ROOT, 'fake', 'invocations.log');
  for (const f of [recordFile, callsFile]) writeFileSync(f, '');
  const repoDir = makeScratchRepo(path.join(ROOT, 'repo'), 'verify-1988');
  const repoName = path.basename(repoDir);
  const shimDir = path.join(ROOT, 'shim');
  buildOmpShim(shimDir);
  const launcherExe = buildLauncher(path.join(ROOT, 'launcher'));
  const env = {
    REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
    REFRACT_FAKE_OMP_NODE: process.execPath,
    REFRACT_FAKE_OMP_SCENARIO: 'conversations-1861',
    REFRACT_FAKE_OMP_SERVE_ROOT: path.join(ROOT, 'serve'),
    REFRACT_FAKE_OMP_DEBUG_LOG: debugLog,
    REFRACT_FAKE_OMP_HOST_TOOL_RECORD: recordFile,
    REFRACT_FAKE_OMP_HOST_TOOL_CALLS: callsFile
  };
  const exeSha256 = sha256OfFile(EXE);
  log('provenance', { gitHead: gitHead(REPO_ROOT), exe: EXE, exeSha256, dataDir, red: RED });

  const records = () => readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let n = 0;
  const calls = new Map();
  const send = (args, pid) => {
    const id = `hc-${++n}`;
    const requestId = `t-${n}`;
    // Real omp also streams the tool row; the finished line is built from that row, not from the host call.
    for (const frame of [{ type: 'tool_execution_start', toolCallId: requestId, toolName: 'refract_ask', args }, { type: 'host_tool_call', id, toolCallId: requestId, toolName: 'refract_ask', arguments: args }]) {
      appendFileSync(callsFile, `${JSON.stringify({ ...frame, __pid: pid })}\n`);
    }
    // The host keys a refract_ask card by the frame id, not by toolCallId.
    const call = { id, requestId: id, toolCallId: requestId, pid };
    calls.set(id, call);
    return call;
  };
  const result = async (id, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = records().find((r) => r.frame.type === 'host_tool_result' && r.frame.id === id);
      if (hit) {
        const settled = { isError: hit.frame.isError === true, text: hit.frame.result.content.map((c) => c.text).join('\n') };
        const call = calls.get(id);
        appendFileSync(callsFile, `${JSON.stringify({ type: 'tool_execution_end', toolCallId: call.toolCallId, toolName: 'refract_ask', result: { content: [{ type: 'text', text: settled.text }] }, isError: settled.isError, __pid: call.pid })}\n`);
        return settled;
      }
      await sleep(150);
    }
    throw new Error(`no host_tool_result for ${id} within ${timeoutMs} ms`);
  };

  let app;
  try {
    const port = await getFreePort();
    app = await launchBuiltExeWithEnv(launcherExe, EXE, { port, dataDir, importSourceDir: path.join(ROOT, 'import'), pathPrepend: shimDir, logFile: path.join(ROOT, 'app.log'), extraEnv: env });
    const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, app.targetPid)) throw new Error(`CDP target on port ${port} is not owned by pid ${app.targetPid}`);
    assertExeMatchesProcess(app.targetPid, EXE, exeSha256);
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    const session = await latestSessionIdAndName(cdp, repoName, []);
    await waitForSessionStatus(cdp, session.id, 'idle');
    const pid = await (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const hit = records().find((r) => r.frame.type === 'set_host_tools');
        if (hit) return hit.pid;
        await sleep(200);
      }
      throw new Error('omp never registered host tools');
    })();
    const shot = async (name) => {
      mkdirSync(EVIDENCE, { recursive: true });
      await sleep(400);
      await cdp.evaluate(`${LINE}?.scrollIntoView({ block: 'center' })`);
      await sleep(200);
      await cdp.screenshot(path.join(EVIDENCE, name));
    };
    // The newest line's header text and digest, read once the line count has grown past `before`.
    const lineAfter = async (before, label) => {
      await cdp.waitFor(`${LINE_COUNT} > ${before} && !!(${TOGGLE})`, { timeoutMs: 20_000, label });
      return cdp.evaluate(`({ header: ${squash(TOGGLE)}, digest: Array.from(${LINE}.querySelectorAll('li[data-asked-digest]')).map((li) => li.textContent.replace(/\\s+/g, ' ').trim()), recommendedMarks: ${LINE}.querySelectorAll('[data-recommended-mark]').length, expanded: ${TOGGLE}.getAttribute('aria-expanded') })`);
    };
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'composer enabled' });
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);

    // s1. Answered with the recommended pick and a note.
    const options = [{ label: 'Expand then contract', recommended: true }, { label: 'Big-bang cutover' }];
    const s1 = send({ questions: [{ id: 'strategy', header: 'Migration', question: 'How should we roll out the schema change?', options }] }, pid);
    await cdp.waitFor(`!!(${ROW('radio', 'Expand then contract')})`, { timeoutMs: 20_000, label: 'single-choice card' });
    await sleep(400);
    await cdp.evaluate(`(${ROW('radio', 'Expand then contract')}).focus()`);
    await pressN(cdp);
    await cdp.waitFor(`!!(${EDITOR('Expand then contract')})`, { timeoutMs: 10_000, label: 'note editor open' });
    await cdp.send('Input.insertText', { text: 'Keep both shapes for a week' });
    await pressEnter(cdp);
    await cdp.waitFor(`!(${EDITOR('Expand then contract')})`, { timeoutMs: 10_000, label: 'note saved' });
    await pressEnter(cdp);
    const r1 = await result(s1.id);
    check(!r1.isError && /Expand then contract/.test(r1.text), 's1a. The recommended pick with a note was submitted', r1);
    const l1 = await lineAfter(0, 'answered line');
    const expectedHeader = RED ? 'Questions from the agent · 1 answered by Away Mode' : 'Questions from the agent · 1 answered';
    check(l1.header === expectedHeader, 's1b. Collapsed header reads "· 1 answered"', l1.header);
    check(l1.expanded === 'false', 's1c. The line starts collapsed (aria-expanded false)', l1.expanded);
    check(l1.digest.length === 1 && l1.digest[0].includes('→ Expand then contract'), 's1d. The digest row shows "→ {label}"', l1.digest);
    check(l1.recommendedMarks === 1, 's1e. The recommended mark is present on the picked answer', l1.recommendedMarks);
    check(l1.digest[0]?.includes('Keep both shapes for a week'), 's1f. The note shows beside the answer in the digest', l1.digest);
    // Submitting by key moves focus from the closing card to the finished line, so the ring is what a keyboard user sees.
    await cdp.waitFor(`document.activeElement === ${LINE}`, { timeoutMs: 10_000, label: 'focus on the line card' }).catch(() => {});
    const focus = await cdp.evaluate(`(() => { const a = document.activeElement; return { isLine: a === ${LINE}, tabIndex: a?.getAttribute?.('tabindex') ?? null, boxShadow: a ? getComputedStyle(a).boxShadow : null }; })()`);
    check(focus.isLine && !!focus.boxShadow && focus.boxShadow !== 'none', 's1g. Keyboard focus rests on the card root with a visible ring (non-none box-shadow)', focus);
    await shot('s1-collapsed.png');
    await cdp.click(TOGGLE);
    await cdp.waitFor(`${TOGGLE}.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 10_000, label: 'line expanded' });
    const expanded = await cdp.evaluate(`({ expanded: ${TOGGLE}.getAttribute('aria-expanded'), questions: Array.from(${LINE}.querySelectorAll('[data-asked-question]')).map((el) => el.textContent.replace(/\\s+/g, ' ').trim()), answers: Array.from(${LINE}.querySelectorAll('[data-asked-answer]')).map((el) => el.textContent.replace(/\\s+/g, ' ').trim()) })`);
    check(expanded.expanded === 'true' && expanded.questions.length === 1 && expanded.questions[0].includes('How should we roll out the schema change?'), 's1h. Clicking the toggle expands the line and shows the question', expanded);
    check(expanded.answers.length === 1 && expanded.answers[0].includes('Note:') && expanded.answers[0].includes('Keep both shapes for a week'), 's1i. The expanded answer carries "Note:" with the note text', expanded.answers);
    await shot('s1-expanded.png');

    // s3. Cancelled.
    const s3 = send({ questions: [{ id: 'cut', question: 'Should we cut over tonight?', options: [{ label: 'Yes' }, { label: 'No' }] }] }, pid);
    await cdp.waitFor(`!!(${ROW('radio', 'No')})`, { timeoutMs: 20_000, label: 'cancel card' });
    await sleep(400);
    await cdp.click(BUTTON_TEXT('Cancel'));
    const r3 = await result(s3.id);
    check(/cancelled/i.test(r3.text), 's3a. The cancel reached the agent', r3);
    const l3 = await lineAfter(1, 'cancelled line');
    check(l3.header === 'Questions from the agent · cancelled', 's3b. Header reads "· cancelled"', l3.header);
    check(l3.digest.length === 1 && l3.digest[0].includes('→ no answer'), 's3c. The digest row shows "→ no answer"', l3.digest);
    await shot('s3-cancelled.png');

    // s6. A renderer-supplied byAway must never relabel the line: only the host's own flag counts.
    const s6 = send({ questions: [{ id: 'db', question: 'Which database?', options: [{ label: 'Postgres', recommended: true }, { label: 'SQLite' }] }] }, pid);
    await cdp.waitFor(`!!(${ROW('radio', 'SQLite')})`, { timeoutMs: 20_000, label: 'spoof card' });
    const spoof = await cdp.evaluate(`window.refract.chat.answer(${JSON.stringify(session.id)}, ${JSON.stringify(s6.requestId)}, { answers: [{ id: 'db', selectedOptions: ['Postgres'] }], byAway: true })`);
    check(spoof?.ok === true, 's6a. The spoofed chat.answer was accepted by the host', spoof);
    await result(s6.id);
    const l6 = await lineAfter(2, 'spoofed line');
    check(l6.header === 'Questions from the agent · 1 answered' && !/by Away Mode/.test(l6.header), 's6b. Header reads plain "· 1 answered", never "by Away Mode"', l6.header);
    check(l6.digest.length === 1 && l6.digest[0].includes('→ Postgres'), 's6c. The digest still shows the answer', l6.digest);
    await shot('s6-spoofed-by-away.png');
    cdp.close();
  } catch (err) {
    failures.push(`exception: ${err?.stack ?? err}`);
    log('exception', String(err?.stack ?? err));
  } finally {
    if (app?.child) await stopLauncher(app.child).catch(() => {});
  }
  const verdict = failures.length ? 'FAILED' : 'PASSED';
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(path.join(EVIDENCE, RED ? 'transcript-red.json' : 'transcript.json'), JSON.stringify({ verdict, failures, transcript }, null, 2));
  console.log(transcript.map((t) => `${t.step}${t.value === null || t.value === undefined ? '' : ` :: ${JSON.stringify(t.value)}`}`).join('\n'));
  console.log(`\nverify-1988: ${verdict}`);
  process.exitCode = failures.length ? 1 : 0;
}

main();
