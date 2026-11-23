#!/usr/bin/env node
// Live CDP check for #1985 (rest): a refract_ask Question card shows each recommended option's reason and several recommended options on a multi-select.
// A serve-mode fake omp (the Session) replays refract_ask host_tool_call frames; the developer side is real CDP input.
// Covers: single choice with a long reason (preselect, Enter accepts, reason wraps in full), multi-select with two recommended
// options (nothing pre-ticked, "Use Recommended" ticks both and keeps an existing tick, then submits), and `reason` without `recommended` (invalid_input, no card).
// Usage: REFRACT_1985_ROOT=<task folder> REFRACT_1985_EXE=<private exe copy> node scripts/verify-tauri-1985-rest.mjs

import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, assertExeMatchesProcess, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, sha256OfFile } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, getAccessibleName } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName, waitForSessionStatus } from './verify-tauri-560-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT = process.env.REFRACT_1985_ROOT;
const EXE = process.env.REFRACT_1985_EXE;
if (!ROOT || !EXE || !path.isAbsolute(ROOT) || !path.isAbsolute(EXE)) throw new Error('set absolute REFRACT_1985_ROOT and REFRACT_1985_EXE');
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

const REASON_ONE = 'Fastest to ship, keeps the public API stable, and a failed cutover is undone by reverting one commit inside the maintenance window.';
const REASON_LINT = 'It is quick and catches the style drift reviewers keep flagging.';
const REASON_TESTS = 'The change touches parsing, so a regression here would reach every caller.';

// The label span's first text node is the option's own label; the badge and the reason come after it.
const ROW = (role, label) => `Array.from(document.querySelectorAll('[role="${role}"]')).find((el) => el.querySelector('.col-start-2.break-words')?.firstChild?.nodeValue?.trim() === ${JSON.stringify(label)})`;
const BUTTON = (text) => `Array.from(document.querySelectorAll('button')).find((b) => b.textContent.replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(text)}))`;
const FOCUSED_LABEL = `(() => { const a = document.activeElement; return { role: a?.getAttribute?.('role') ?? null, label: a?.querySelector?.('.col-start-2.break-words')?.firstChild?.nodeValue?.trim() ?? null, tag: a?.tagName ?? null, aria: a?.getAttribute?.('aria-label') ?? null, pane: a?.closest?.('[data-session-pane]')?.getAttribute('data-session-pane') ?? null }; })()`;
const cueOf = (role, label) => `(() => {
  const row = ${ROW(role, label)}; if (!row) return null;
  const badge = row.querySelector('[data-recommended-badge]'); const reason = row.querySelector('[data-recommended-reason]');
  const describedBy = (row.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '');
  const lineHeight = reason ? parseFloat(getComputedStyle(reason).lineHeight) : 0; const box = reason?.getBoundingClientRect();
  return { marked: row.hasAttribute('data-ask-recommended'), badge: badge?.textContent.trim() ?? null, reason: reason?.textContent ?? null, reasonColour: reason ? getComputedStyle(reason).color : null,
    reasonLines: reason ? reason.getClientRects().length : 0, reasonClipped: !!reason && reason.scrollWidth > reason.clientWidth + 1, reasonHeight: box?.height ?? 0, lineHeight,
    insideRow: !!box && box.right <= row.getBoundingClientRect().right + 0.5, describedBy, checked: row.getAttribute('aria-checked') };
})()`;

const key = (cdp, type, k, code, vk, extra = {}) => cdp.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, ...extra });
const pressEnter = async (cdp) => {
  await key(cdp, 'keyDown', 'Enter', 'Enter', 13, { text: '\r' });
  await key(cdp, 'keyUp', 'Enter', 'Enter', 13);
};

async function main() {
  const dataDir = path.join(ROOT, 'data');
  const recordFile = path.join(ROOT, 'fake', 'host-tools.jsonl');
  const callsFile = path.join(ROOT, 'fake', 'host-calls.jsonl');
  const debugLog = path.join(ROOT, 'fake', 'invocations.log');
  for (const f of [recordFile, callsFile]) writeFileSync(f, '');
  const repoDir = makeScratchRepo(path.join(ROOT, 'repo'), 'verify-1985-rest');
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
  log('provenance', { gitHead: gitHead(REPO_ROOT), exe: EXE, exeSha256, dataDir });

  const records = () => readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let n = 0;
  // refract_ask has no timer, so the call is sent now and its result awaited separately, after the developer acts.
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
    const tools = records().find((r) => r.frame.type === 'set_host_tools').frame.tools.map((t) => t.name);
    check(tools.includes('refract_ask'), 'the Session registered refract_ask', tools);

    // A real ask arrives after the developer sent a prompt, so focus sits in their own (empty) composer; a card never pulls focus out of another pane.
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'composer enabled' });
    log('focus before the composer click (what the first live run had when the card opened)', await cdp.evaluate(FOCUSED_LABEL));
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);
    log('focus after the composer click', await cdp.evaluate(FOCUSED_LABEL));

    // 1. Single choice: one recommended option with a long reason.
    const one = send({ questions: [{ id: 'strategy', header: 'Migration', question: 'How should we roll out the schema change?', options: [{ label: 'Expand then contract', description: 'Two releases, no downtime' }, { label: 'Big-bang cutover', recommended: true, reason: REASON_ONE }, { label: 'Dual write', description: 'Write both shapes for a week' }] }] }, pid);
    await cdp.waitFor(`!!(${ROW('radio', 'Big-bang cutover')})`, { timeoutMs: 20_000, label: 'single-choice card' });
    await sleep(400);
    const c1 = await cdp.evaluate(cueOf('radio', 'Big-bang cutover'));
    const plain = await cdp.evaluate(cueOf('radio', 'Dual write'));
    check(c1.marked && c1.badge === 'Recommended' && c1.reason === `· ${REASON_ONE}`, '1a. The recommended row shows "Recommended" then the full reason as "· {reason}"', c1);
    check(c1.reasonLines >= 2 && !c1.reasonClipped && c1.insideRow, '1b. The long reason wraps over several lines, is not clipped and stays inside the row', { lines: c1.reasonLines, clipped: c1.reasonClipped, inside: c1.insideRow });
    check(c1.describedBy.includes(REASON_ONE), '1c. The reason is part of the row\'s accessible description', c1.describedBy);
    const mutedColour = await cdp.evaluate(`getComputedStyle(${ROW('radio', 'Big-bang cutover')}.querySelector('.text-xs.text-muted-foreground, [data-recommended-reason]')).color`);
    check(c1.reasonColour === mutedColour && plain.reason === null && plain.badge === null, '1d. The reason is muted text and a plain row shows no cue or reason', { reasonColour: c1.reasonColour, plain });
    const name1 = await getAccessibleName(cdp, ROW('radio', 'Big-bang cutover'));
    check(String(name1?.name ?? name1).replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim() === 'Big-bang cutover, Recommended', '1e. The accessible name stays "Big-bang cutover, Recommended" (the reason is the description, not the name)', name1);
    check(c1.checked === 'true' && (await cdp.evaluate(FOCUSED_LABEL)).label === 'Big-bang cutover', '1f. The recommended row is preselected and focused', { checked: c1.checked, focus: await cdp.evaluate(FOCUSED_LABEL) });
    await shot('01-single-choice-reason.png');
    await pressEnter(cdp);
    const r1 = await result(one);
    check(!r1.isError && /Big-bang cutover/.test(r1.text) && !/Expand then contract|Dual write/.test(r1.text), '1g. Enter on the recommended row accepts it and the agent receives it', r1);
    await cdp.waitFor(`!(${ROW('radio', 'Big-bang cutover')})`, { timeoutMs: 15_000, label: 'single-choice card closed' });

    // 2. Multi-select: two recommended options, one plain option the developer ticks first.
    const two = send({ questions: [{ id: 'checks', header: 'Checks', question: 'Which checks should run before merge?', multi: true, options: [{ label: 'Lint', recommended: true, reason: REASON_LINT }, { label: 'Tests', recommended: true, reason: REASON_TESTS }, { label: 'Docs build' }] }] }, pid);
    await cdp.waitFor(`!!(${ROW('checkbox', 'Lint')})`, { timeoutMs: 20_000, label: 'multi-select card' });
    await sleep(400);
    const lint = await cdp.evaluate(cueOf('checkbox', 'Lint'));
    const tests = await cdp.evaluate(cueOf('checkbox', 'Tests'));
    const docs = await cdp.evaluate(cueOf('checkbox', 'Docs build'));
    check(lint.marked && tests.marked && lint.badge === 'Recommended' && tests.badge === 'Recommended' && !docs.marked && docs.badge === null, '2a. Both recommended rows carry the cue and the tint marker; the plain row does not', { lint, tests, docs });
    check(lint.reason === `· ${REASON_LINT}` && tests.reason === `· ${REASON_TESTS}` && lint.describedBy.includes(REASON_LINT) && tests.describedBy.includes(REASON_TESTS), '2b. Each recommended row shows its own reason, also in its description', { lint: lint.reason, tests: tests.reason });
    const ticked = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="checkbox"]')).filter((el) => el.getAttribute('aria-checked') === 'true').length`);
    check(ticked === 0, '2c. Nothing is pre-ticked on a multi-select', ticked);
    const useName = await getAccessibleName(cdp, BUTTON('Use Recommended'));
    check(String(useName?.name ?? useName).trim() === 'Use recommended: Lint, Tests', '2d. "Use Recommended" names every recommended option', useName);
    await cdp.click(ROW('checkbox', 'Docs build'));
    await cdp.waitFor(`(${ROW('checkbox', 'Docs build')})?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 10_000, label: 'Docs build ticked' });
    await shot('02-multi-two-recommended.png');
    await cdp.click(BUTTON('Use Recommended'));
    const r2 = await result(two);
    check(!r2.isError && /Lint/.test(r2.text) && /Tests/.test(r2.text) && /Docs build/.test(r2.text), '2e. "Use Recommended" ticked both recommended options, kept the existing tick, and submitted', r2);
    await cdp.waitFor(`!(${ROW('checkbox', 'Lint')})`, { timeoutMs: 15_000, label: 'multi-select card closed' });

    // 3. reason without recommended: a tool error, no card.
    const bad = send({ questions: [{ id: 'colour', question: 'Which colour?', options: [{ label: 'Red', reason: 'It is my favourite' }, { label: 'Blue' }] }] }, pid);
    const r3 = await result(bad);
    await sleep(1500);
    const card = await cdp.evaluate(`({ radios: document.querySelectorAll('[role="radio"]').length, text: document.body.innerText.includes('Which colour?') })`);
    check(r3.isError && /invalid_input|colour/.test(r3.text) && /Red/.test(r3.text) && /recommended/i.test(r3.text), '3a. A reason on a non-recommended option fails with an error naming the question and the option', r3);
    check(card.radios === 0 && !card.text, '3b. No card is shown for the rejected call', card);
    await shot('03-reason-without-recommended-rejected.png');
    cdp.close();
  } catch (err) {
    failures.push(`exception: ${err?.stack ?? err}`);
    log('exception', String(err?.stack ?? err));
  } finally {
    if (app?.child) await stopLauncher(app.child).catch(() => {});
  }
  const verdict = failures.length ? 'FAILED' : 'PASSED';
  writeFileSync(path.join(EVIDENCE, 'transcript.json'), JSON.stringify({ verdict, failures, transcript }, null, 2));
  console.log(transcript.map((t) => `${t.step}${t.value === null || t.value === undefined ? '' : ` :: ${JSON.stringify(t.value)}`}`).join('\n'));
  console.log(`\nverify-1985-rest: ${verdict}`);
  process.exitCode = failures.length ? 1 : 0;
}

main();
