#!/usr/bin/env node
// Live CDP check for #1987: inline option notes on a refract_ask Question card, opened with the N key.
// A serve-mode fake omp (the Session) replays refract_ask host_tool_call frames; the developer side is real CDP key input.
// Covers: N on an unpicked single-choice row picks it and opens the editor; Enter saves and shows "Note:"; Edit and remove work;
// Escape cancels; unpicking hides the note and re-picking restores it; a multi-select with notes on two ticked options and one
// unticked sends only the two; the 1000-character cap and counter; N typed into the Other field is a plain "n".
// Usage: REFRACT_1987_ROOT=<task folder> REFRACT_1987_EXE=<private exe copy> node scripts/verify-tauri-1987.mjs

// Set REFRACT_1987_RED=1 to run one assertion with a deliberately wrong expectation (proves the checks can fail).

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
const ROOT = process.env.REFRACT_1987_ROOT;
const EXE = process.env.REFRACT_1987_EXE;
const RED = process.env.REFRACT_1987_RED === '1';
if (!ROOT || !EXE || !path.isAbsolute(ROOT) || !path.isAbsolute(EXE)) throw new Error('set absolute REFRACT_1987_ROOT and REFRACT_1987_EXE');
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

// The label span's first text node is the option's own label; the badge and the reason come after it.
const ROW = (role, label) => `Array.from(document.querySelectorAll('[role="${role}"]')).find((el) => el.querySelector('.col-start-2.break-words')?.firstChild?.nodeValue?.trim() === ${JSON.stringify(label)})`;
const BUTTON = (aria) => `Array.from(document.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === ${JSON.stringify(aria)})`;
const EDITOR = (label) => `document.querySelector('textarea[aria-label="Note on ${label}"]')`;
const NOTE_TEXTS = `Array.from(document.querySelectorAll('p')).filter((p) => p.textContent.startsWith('Note:')).map((p) => p.textContent.replace(/\\s+/g, ' ').trim())`;
const FOCUS = `(() => { const a = document.activeElement; return { tag: a?.tagName ?? null, role: a?.getAttribute?.('role') ?? null, aria: a?.getAttribute?.('aria-label') ?? null, checked: a?.getAttribute?.('aria-checked') ?? null }; })()`;

const key = (cdp, type, k, code, vk, extra = {}) => cdp.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, ...extra });
const press = async (cdp, k, code, vk, text) => {
  await key(cdp, 'keyDown', k, code, vk, text ? { text } : {});
  await key(cdp, 'keyUp', k, code, vk);
};
const pressEnter = (cdp) => press(cdp, 'Enter', 'Enter', 13, '\r');
const pressEscape = (cdp) => press(cdp, 'Escape', 'Escape', 27);
const pressN = (cdp) => press(cdp, 'n', 'KeyN', 78, 'n');
const typeText = async (cdp, text) => cdp.send('Input.insertText', { text });

async function main() {
  const dataDir = path.join(ROOT, 'data');
  const recordFile = path.join(ROOT, 'fake', 'host-tools.jsonl');
  const callsFile = path.join(ROOT, 'fake', 'host-calls.jsonl');
  const debugLog = path.join(ROOT, 'fake', 'invocations.log');
  for (const f of [recordFile, callsFile]) writeFileSync(f, '');
  const repoDir = makeScratchRepo(path.join(ROOT, 'repo'), 'verify-1987');
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
  const send = (args, pid) => {
    const id = `hc-${++n}`;
    appendFileSync(callsFile, `${JSON.stringify({ type: 'host_tool_call', id, toolCallId: `t-${n}`, toolName: 'refract_ask', arguments: args, __pid: pid })}\n`);
    return id;
  };
  const result = async (id, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = records().find((r) => r.frame.type === 'host_tool_result' && r.frame.id === id);
      if (hit) return { isError: hit.frame.isError === true, text: hit.frame.result.content.map((c) => c.text).join('\n') };
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
      await sleep(400);
      await cdp.screenshot(path.join(EVIDENCE, name));
    };
    const focusRow = (role, label) => cdp.evaluate(`(${ROW(role, label)}).focus()`);
    const checked = (role, label) => cdp.evaluate(`(${ROW(role, label)})?.getAttribute('aria-checked')`);
    // A real ask arrives after the developer sent a prompt, so focus sits in their own composer; a card never pulls focus out of another pane.
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'composer enabled' });
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);

    // 1. Single choice: N on an unpicked row picks it and opens the editor.
    const one = send({ questions: [{ id: 'strategy', header: 'Migration', question: 'How should we roll out the schema change?', options: [{ label: 'Expand then contract' }, { label: 'Big-bang cutover' }, { label: 'Dual write' }] }] }, pid);
    await cdp.waitFor(`!!(${ROW('radio', 'Dual write')})`, { timeoutMs: 20_000, label: 'single-choice card' });
    await sleep(400);
    const hint = await cdp.evaluate(`document.body.innerText.includes('to add a note to selected option')`);
    check(hint, '1a. The footer hint "Press N to add a note to selected option" is shown', hint);
    await focusRow('radio', 'Dual write');
    check((await checked('radio', 'Dual write')) !== 'true', '1b. Setup: the focused row is not picked yet', await checked('radio', 'Dual write'));
    await pressN(cdp);
    await cdp.waitFor(`!!(${EDITOR('Dual write')})`, { timeoutMs: 10_000, label: 'note editor open' });
    check((await checked('radio', 'Dual write')) === 'true', '1c. N picked the unpicked row', await checked('radio', 'Dual write'));
    const f1 = await cdp.evaluate(FOCUS);
    check(f1.tag === 'TEXTAREA' && f1.aria === 'Note on Dual write', '1d. The editor opened and holds focus', f1);
    await shot('01-n-picks-and-opens-editor.png');
    await typeText(cdp, 'Keep the old shape for a week');
    await pressEnter(cdp);
    await cdp.waitFor(`${NOTE_TEXTS}.length === 1`, { timeoutMs: 10_000, label: 'note saved' });
    const saved = await cdp.evaluate(NOTE_TEXTS);
    const expectedSaved = RED ? 'Note: WRONG on purpose' : 'Note: Keep the old shape for a week';
    check(saved[0] === expectedSaved, '1e. Enter saved the note and it renders as "Note: {text}"', saved);
    const stillOpen = await cdp.evaluate(`!!(${ROW('radio', 'Dual write')})`);
    check(stillOpen, '1f. Enter in the editor did not submit the card', stillOpen);
    await shot('02-note-saved.png');

    // Edit, then Escape cancels the edit and returns focus to the row.
    await cdp.click(BUTTON('Edit note on Dual write'));
    await cdp.waitFor(`!!(${EDITOR('Dual write')})`, { timeoutMs: 10_000, label: 'editor reopened' });
    const prefilled = await cdp.evaluate(`${EDITOR('Dual write')}.value`);
    check(prefilled === 'Keep the old shape for a week', '1g. Edit reopens the editor with the saved text', prefilled);
    await typeText(cdp, ' and then drop it');
    await pressEscape(cdp);
    await cdp.waitFor(`!(${EDITOR('Dual write')})`, { timeoutMs: 10_000, label: 'editor closed' });
    const afterEsc = { notes: await cdp.evaluate(NOTE_TEXTS), focus: await cdp.evaluate(FOCUS) };
    check(afterEsc.notes[0] === 'Note: Keep the old shape for a week' && afterEsc.focus.role === 'radio', '1h. Escape cancelled the edit (text unchanged) and focus returned to the row', afterEsc);

    // Unpick hides the note, re-picking restores it.
    await cdp.click(ROW('radio', 'Big-bang cutover'));
    await cdp.waitFor(`${NOTE_TEXTS}.length === 0`, { timeoutMs: 10_000, label: 'note hidden' });
    check(true, '1i. Picking another option hides the unpicked option\'s note', await cdp.evaluate(NOTE_TEXTS));
    await cdp.click(ROW('radio', 'Dual write'));
    await cdp.waitFor(`${NOTE_TEXTS}.length === 1`, { timeoutMs: 10_000, label: 'note restored' });
    check((await cdp.evaluate(NOTE_TEXTS))[0] === 'Note: Keep the old shape for a week', '1j. Picking it again restores the same note', await cdp.evaluate(NOTE_TEXTS));

    // Remove (x).
    await cdp.click(BUTTON('Remove note on Dual write'));
    await cdp.waitFor(`${NOTE_TEXTS}.length === 0 && !!(${BUTTON('Add a note to Dual write')})`, { timeoutMs: 10_000, label: 'note removed' });
    check(true, '1k. Remove deleted the note and offered "Add a note" again', await cdp.evaluate(NOTE_TEXTS));

    // 1000-character cap and counter.
    await focusRow('radio', 'Dual write');
    await pressN(cdp);
    await cdp.waitFor(`!!(${EDITOR('Dual write')})`, { timeoutMs: 10_000, label: 'editor open for the cap' });
    await typeText(cdp, 'x'.repeat(1200));
    // The counter sits in the editor's own block; the first role=status on the page is another live region.
    const cap = await cdp.evaluate(`({ length: ${EDITOR('Dual write')}.value.length, counter: ${EDITOR('Dual write')}.closest('div.ml-6')?.querySelector('[role="status"]')?.textContent ?? null })`);
    check(cap.length === 1000 && cap.counter === '1000/1000', '1l. The editor stops at 1000 characters and the counter shows 1000/1000', cap);
    await shot('03-cap-counter.png');
    await pressEscape(cdp);
    await cdp.waitFor(`!(${EDITOR('Dual write')})`, { timeoutMs: 10_000, label: 'cap editor closed' });
    await cdp.click(ROW('radio', 'Big-bang cutover'));
    await pressEnter(cdp);
    const r1 = await result(one);
    check(!r1.isError && /Big-bang cutover/.test(r1.text) && !/Note on/.test(r1.text), '1m. A cancelled note is not sent; the picked option is', r1);
    await cdp.waitFor(`!(${ROW('radio', 'Big-bang cutover')})`, { timeoutMs: 15_000, label: 'single-choice card closed' });

    // 2. Multi-select: notes on two ticked options, one on an option unticked afterwards; only the two are sent.
    const two = send({ questions: [{ id: 'checks', header: 'Checks', question: 'Which checks should run before merge?', multi: true, options: [{ label: 'Lint' }, { label: 'Tests' }, { label: 'Docs build' }] }] }, pid);
    await cdp.waitFor(`!!(${ROW('checkbox', 'Docs build')})`, { timeoutMs: 20_000, label: 'multi-select card' });
    await sleep(400);
    for (const [label, text] of [['Lint', 'Fast only'], ['Tests', 'Unit tests'], ['Docs build', 'Skip this one']]) {
      await focusRow('checkbox', label);
      await pressN(cdp);
      await cdp.waitFor(`!!(${EDITOR(label)})`, { timeoutMs: 10_000, label: `editor for ${label}` });
      await typeText(cdp, text);
      await pressEnter(cdp);
      await cdp.waitFor(`!${EDITOR(label)}`, { timeoutMs: 10_000, label: `editor for ${label} closed` });
    }
    check((await cdp.evaluate(NOTE_TEXTS)).length === 3, '2a. N ticked and noted three options', await cdp.evaluate(NOTE_TEXTS));
    await cdp.click(ROW('checkbox', 'Docs build'));
    await cdp.waitFor(`${NOTE_TEXTS}.length === 2`, { timeoutMs: 10_000, label: 'third note hidden' });
    await shot('04-multi-notes.png');
    await focusRow('checkbox', 'Lint');
    await pressEnter(cdp);
    const r2 = await result(two);
    // The host names options by letter (A, B), not label: "Note on A: ...".
    check(!r2.isError && /Picked: A "Lint", B "Tests"\./.test(r2.text) && /\n Note on A: Fast only\./.test(r2.text) && /\n Note on B: Unit tests\./.test(r2.text) && !/Docs build|Skip this one|Note on C/.test(r2.text), '2b. Only the notes on the two ticked options are sent (" Note on A: ...")', r2);
    await cdp.waitFor(`!(${ROW('checkbox', 'Lint')})`, { timeoutMs: 15_000, label: 'multi-select card closed' });

    // 3. N inside the Other text field types an n and opens no editor.
    const three = send({ questions: [{ id: 'name', question: 'What should it be called?', options: [{ label: 'Alpha' }, { label: 'Beta' }] }] }, pid);
    await cdp.waitFor(`!!(${ROW('radio', 'Beta')})`, { timeoutMs: 20_000, label: 'other card' });
    await sleep(400);
    await cdp.click(`document.querySelector('input[aria-label="Other answer"]')`);
    await pressN(cdp);
    const other = await cdp.evaluate(`({ value: document.querySelector('input[aria-label="Other answer"]').value, editors: document.querySelectorAll('textarea[aria-label^="Note on"]').length })`);
    check(other.value === 'n' && other.editors === 0, '3a. N in the Other field typed an "n" and opened no note editor', other);
    await shot('05-n-in-other.png');
    await cdp.evaluate(`document.querySelector('input[aria-label="Other answer"]').blur()`);
    await cdp.click(ROW('radio', 'Alpha'));
    await pressEnter(cdp);
    await result(three);
    cdp.close();
  } catch (err) {
    failures.push(`exception: ${err?.stack ?? err}`);
    log('exception', String(err?.stack ?? err));
  } finally {
    if (app?.child) await stopLauncher(app.child).catch(() => {});
  }
  const verdict = failures.length ? 'FAILED' : 'PASSED';
  writeFileSync(path.join(EVIDENCE, RED ? 'transcript-red.json' : 'transcript.json'), JSON.stringify({ verdict, failures, transcript }, null, 2));
  console.log(transcript.map((t) => `${t.step}${t.value === null || t.value === undefined ? '' : ` :: ${JSON.stringify(t.value)}`}`).join('\n'));
  console.log(`\nverify-1987: ${verdict}`);
  process.exitCode = failures.length ? 1 : 0;
}

main();
