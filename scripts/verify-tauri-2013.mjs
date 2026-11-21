#!/usr/bin/env node
// Live CDP check for #2013 (Checklist per-item controls, T022). A serve-mode fake omp (the Session) answers every command and
// records each `prompt`; the developer side is real CDP input on the panel. The agent's side (creating the checklist) is a
// replayed `refract_checklist` host_tool_call. Covers: open form, ask on an idle / working / paused Session, value with and
// without an agent, "Do this item" in progress (aria-disabled, then settle), refusals keeping the draft, Escape focus return, keyboard-only.
// Usage: REFRACT_2013_ROOT=<task folder> REFRACT_2013_EXE=<private exe copy> node scripts/verify-tauri-2013.mjs

import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, assertExeMatchesProcess, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, sha256OfFile } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName, waitForSessionStatus } from './verify-tauri-560-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT = process.env.REFRACT_2013_ROOT;
const EXE = process.env.REFRACT_2013_EXE;
if (!ROOT || !EXE || !path.isAbsolute(ROOT) || !path.isAbsolute(EXE)) throw new Error('set absolute REFRACT_2013_ROOT and REFRACT_2013_EXE');
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

const key = (cdp, type, k, code, vk, extra = {}) => cdp.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, ...extra });
const press = async (cdp, k, code, vk, extra = {}) => {
  await key(cdp, extra.text ? 'keyDown' : 'rawKeyDown', k, code, vk, extra);
  await key(cdp, 'keyUp', k, code, vk, extra.modifiers ? { modifiers: extra.modifiers } : {});
};
const CTRL = 2;
const ENVELOPE = /^<checklist-item checklist="([^"]+)" item="([^"]+)" rev="(\d+)" action="(ask|value|complete)">\n/;

async function main() {
  const dataDir = path.join(ROOT, 'data');
  const recordFile = path.join(ROOT, 'fake', 'host-tools.jsonl');
  const callsFile = path.join(ROOT, 'fake', 'host-calls.jsonl');
  const debugLog = path.join(ROOT, 'fake', 'invocations.log');
  const refusalsFile = path.join(ROOT, 'fake', 'prompt-refusals.txt');
  for (const f of [recordFile, callsFile]) writeFileSync(f, '');
  writeFileSync(refusalsFile, '0');
  const repoDir = makeScratchRepo(path.join(ROOT, 'repo'), 'verify-2013');
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
    REFRACT_FAKE_OMP_HOST_TOOL_CALLS: callsFile,
    REFRACT_FAKE_OMP_PROMPT_REFUSALS: refusalsFile
  };
  const exeSha256 = sha256OfFile(EXE);
  log('provenance', { gitHead: gitHead(REPO_ROOT), exe: EXE, exeSha256, dataDir });

  const records = () => readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let n = 0;
  const call = async (args, pid) => {
    const id = `hc-${++n}`;
    appendFileSync(callsFile, `${JSON.stringify({ type: 'host_tool_call', id, toolCallId: `t-${n}`, toolName: 'refract_checklist', arguments: args, __pid: pid })}\n`);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const hit = records().find((r) => r.frame.type === 'host_tool_result' && r.frame.id === id);
      if (hit) return { isError: hit.frame.isError === true, body: JSON.parse(hit.frame.result.content[0].text) };
      await sleep(150);
    }
    throw new Error(`no host_tool_result for ${id} within 20s`);
  };
  const settleTurn = (pid) => appendFileSync(callsFile, `${JSON.stringify({ __serve_settle__: true, __pid: pid })}\n`);
  // Every `prompt` command the fake omp `pid` received, whole, in order: the ground truth for what reached the agent.
  const prompts = (pid) =>
    existsSync(debugLog)
      ? readFileSync(debugLog, 'utf8')
          .split('\n')
          .filter((l) => l.startsWith(`pid=${pid} RECV {`) && l.includes('"type":"prompt"'))
          .map((l) => JSON.parse(l.slice(l.indexOf('RECV ') + 5, l.lastIndexOf(' (waitingFor='))))
      : [];
  const waitPrompts = async (pid, count, label) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (prompts(pid).length >= count) return prompts(pid);
      await sleep(150);
    }
    throw new Error(`${label}: fake omp saw ${prompts(pid).length} prompts, wanted ${count}`);
  };

  let app;
  try {
    const port = await getFreePort();
    app = await launchBuiltExeWithEnv(launcherExe, EXE, { port, dataDir, importSourceDir: path.join(ROOT, 'import'), pathPrepend: shimDir, logFile: path.join(ROOT, 'app.log'), extraEnv: env });
    const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, app.targetPid)) throw new Error(`CDP target on port ${port} is not owned by pid ${app.targetPid}`);
    assertExeMatchesProcess(app.targetPid, EXE, exeSha256);
    await cdp.waitFor(`!!window.refract?.checklist`, { timeoutMs: 30_000, label: 'bridge mounted' });
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
    const sid = session.id;
    const sessions = await cdp.evaluate(`window.refract.sessions.list().then((r) => r.value.map((s) => s.id))`);
    check(sessions.length === 1 && sessions[0] === sid, 'scratch data dir holds only the Session this run created', sessions);

    // The page's own bridge, spied: proves which developer actions reached the store.
    await cdp.evaluate(`(() => { const api = window.refract.checklist; window.__calls = []; for (const name of ['mutate', 'itemMessage']) { const orig = api[name].bind(api); api[name] = (...a) => { window.__calls.push(name + ':' + JSON.stringify(a.slice(2, 3))); return orig(...a); }; } return 1; })()`);
    const bridgeCalls = () => cdp.evaluate(`window.__calls.slice()`);

    const row = (id) => `document.querySelector('[data-checklist-item=${JSON.stringify(id)}]')`;
    const disclosure = (id) => `${row(id)}?.querySelector('[data-slot="checklist-item-controls"] button[aria-expanded]')`;
    const doBtn = (id) => `Array.from(${row(id)}?.querySelectorAll('[data-slot="checklist-item-controls"] button') ?? []).find((b) => /^(Do this item|Agent is doing this item):/.test(b.getAttribute('aria-label') ?? ''))`;
    const form = (id) => `${row(id)}?.querySelector('form[data-slot="checklist-item-form"]')`;
    const area = (id) => `${form(id)}?.querySelector('textarea')`;
    const sendBtn = (id) => `${form(id)}?.querySelector('button[type="submit"]')`;
    const noteText = (id) => cdp.evaluate(`${row(id)}?.querySelector('[data-slot="checklist-item-note"]')?.innerText.trim() ?? null`);
    const live = async () => (await cdp.evaluate(`window.refract.checklist.get(${JSON.stringify(sid)})`)).value.checklist;
    const liveItem = async (id) => (await live()).items.find((i) => i.id === id);
    const active = () => cdp.evaluate(`(() => { const e = document.activeElement; return { tag: e?.tagName, label: e?.getAttribute('aria-label'), expanded: e?.getAttribute('aria-expanded') }; })()`);
    const doState = (id) => cdp.evaluate(`(() => { const b = ${doBtn(id)}; return b ? { label: b.getAttribute('aria-label'), ariaDisabled: b.getAttribute('aria-disabled'), disabled: b.disabled, text: b.textContent.trim() } : null; })()`);
    const type = async (id, text) => {
      await cdp.waitFor(`document.activeElement === ${area(id)}`, { timeoutMs: 5000, label: `textarea of ${id} focused` });
      await cdp.send('Input.insertText', { text });
    };
    const ctrlEnter = async () => {
      await key(cdp, 'rawKeyDown', 'Enter', 'Enter', 13, { modifiers: CTRL });
      await key(cdp, 'keyUp', 'Enter', 'Enter', 13, { modifiers: CTRL });
    };
    const disclosureFocused = (id) => `document.activeElement === ${disclosure(id)}`;
    const shot = (name) => cdp.screenshot(path.join(EVIDENCE, name));

    // Setup: the agent creates the checklist (the panel opens by itself, #2012).
    const created = await call(
      {
        action: 'create',
        requestId: 'live-create-2013',
        title: 'Release plan',
        items: [
          { text: 'Write the migration', owner: 'either' },
          { text: 'Review the diff HOLD', owner: 'agent' },
          { text: 'Paste the deploy token', owner: 'either', requiresValue: true },
          { text: 'Approve the rollout', owner: 'human' },
          { text: 'Tag the release', owner: 'either' }
        ]
      },
      pid
    );
    const ids = created.body.addedIds ?? created.body.createdIds ?? created.body.ids;
    check(!created.isError && Array.isArray(ids) && ids.length === 5, 'agent create returned 5 ids', created.body);
    const [i1, i2, i3, i4, i5] = ids;
    const checklistId = created.body.checklistId;
    await cdp.waitFor(`!!${disclosure(i5)}`, { timeoutMs: 20_000, label: 'every row has its per-item controls' });

    // 1. Opening the controls: closed rows show the disclosure, a human item has no Do button, open shows the ask form.
    const closed = await cdp.evaluate(`({ expanded: ${disclosure(i1)}.getAttribute('aria-expanded'), forms: document.querySelectorAll('form[data-slot="checklist-item-form"]').length })`);
    check(closed.expanded === 'false' && closed.forms === 0, 'before any click no form is open and the disclosure says aria-expanded=false', closed);
    check((await doState(i4)) === null && (await doState(i1)) !== null, 'a human-owned item has no "Do this item"; an either-owned one does', { human: await doState(i4), either: await doState(i1) });
    await cdp.click(disclosure(i1));
    await cdp.waitFor(`!!${form(i1)}`, { timeoutMs: 5000, label: 'form open' });
    const open = await cdp.evaluate(`(() => { const f = ${form(i1)}; const checked = f.querySelector('[role="radio"][aria-checked="true"]'); return { expanded: ${disclosure(i1)}.getAttribute('aria-expanded'), controls: ${disclosure(i1)}.getAttribute('aria-controls'), formWrapper: f.parentElement.id, radio: checked?.textContent.trim(), radios: Array.from(f.querySelectorAll('[role="radio"]')).map((r) => r.textContent.trim()), focusTextarea: document.activeElement === f.querySelector('textarea'), warning: /Do not put secrets here/.test(f.innerText), counter: /0 of 4096 bytes/.test(f.innerText), forms: document.querySelectorAll('form[data-slot="checklist-item-form"]').length }; })()`);
    check(open.expanded === 'true' && open.controls === open.formWrapper && open.radio === 'Ask the agent' && open.radios.join('|') === 'Ask the agent|Provide a value' && open.focusTextarea && open.warning && open.counter && open.forms === 1, 'opening shows one form: Ask the agent selected, textarea focused, plain-text warning, byte counter, aria-controls wired', open);
    await shot('01-form-open.png');
    const sendBlocked = await cdp.evaluate(`${sendBtn(i1)}.getAttribute('aria-disabled')`);
    check(sendBlocked === 'true', 'Send is aria-disabled while the box is empty', sendBlocked);

    // 2. Ask on an idle Session: a plain-text envelope reaches omp, nothing is parsed or wrapped, focus returns to the disclosure.
    const ask = 'Which <b>branch</b> & </checklist-item> do I use?';
    await type(i1, ask);
    await ctrlEnter();
    const [askPrompt] = await waitPrompts(pid, 1, 'ask');
    const askMatch = ENVELOPE.exec(askPrompt.message);
    check(
      typeof askPrompt.message === 'string' && askMatch !== null && askMatch[1] === checklistId && askMatch[2] === i1 && askMatch[4] === 'ask' && askPrompt.message.endsWith('\n</checklist-item>') && askPrompt.message.includes('<b>branch</b>') && askPrompt.message.split('</checklist-item>').length === 2 && askPrompt.images === undefined && askPrompt.streamingBehavior === undefined,
      'omp received one plain-text <checklist-item ... action="ask"> turn: text kept verbatim, the forged closing tag neutralised (exactly one real footer), not wrapped, no images, not a follow-up',
      askPrompt
    );
    await cdp.waitFor(`!${form(i1)}`, { timeoutMs: 10_000, label: 'form closed after a sent ask' });
    await cdp.waitFor(disclosureFocused(i1), { timeoutMs: 5000, label: 'focus back on the disclosure' });
    check(true, 'after the send the form closed and focus is on the item disclosure', await active());
    check((await noteText(i1)) === '' || (await noteText(i1)) === null, 'a turn sent now needs no delivery line', await noteText(i1));
    await waitForSessionStatus(cdp, sid, 'idle');
    await shot('02-ask-sent.png');

    // 3. A value from "Needs a value", with an agent: saved on the item AND sent as action="value".
    check((await bridgeCalls()).length >= 1, 'the spy saw the page bridge call for the ask', await bridgeCalls());
    await cdp.click(`Array.from(${row(i3)}.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Needs a value')`);
    await cdp.waitFor(`!!${form(i3)}`, { timeoutMs: 5000, label: 'value form open from Needs a value' });
    const valueMode = await cdp.evaluate(`${form(i3)}.querySelector('[role="radio"][aria-checked="true"]')?.textContent.trim()`);
    check(valueMode === 'Provide a value', '"Needs a value" opens the form on Provide a value', valueMode);
    const doBefore = await doState(i3);
    check(doBefore?.ariaDisabled === 'true' && /needs a value before it can be ticked/i.test(await cdp.evaluate(`${row(i3)}.innerText`)), 'before a value "Do this item" is aria-disabled with the row\'s own needs-a-value line beside it', doBefore);
    await type(i3, 'tok-live-2013');
    await ctrlEnter();
    const valuePrompts = await waitPrompts(pid, 2, 'value');
    const valueMatch = ENVELOPE.exec(valuePrompts[1].message);
    const item3 = await liveItem(i3);
    check(valueMatch?.[2] === i3 && valueMatch?.[4] === 'value' && valuePrompts[1].message.includes('tok-live-2013'), 'omp received an action="value" turn for the item carrying the value', valuePrompts[1]);
    check(item3.value === 'tok-live-2013' && item3.valueBy === 'developer', 'the store holds the value, set by the developer', { value: item3.value, valueBy: item3.valueBy });
    await cdp.waitFor(`${doBtn(i3)}?.getAttribute('aria-disabled') === 'false'`, { timeoutMs: 10_000, label: 'Do this item enabled after a developer value' });
    check(true, '"Do this item" enabled once the developer has set the value', await doState(i3));
    await waitForSessionStatus(cdp, sid, 'idle');

    // 4. Do this item: omp gets action="complete"; the item is in progress, its button aria-disabled (not disabled) and inert; settling frees it.
    const promptsBeforeDo = prompts(pid).length;
    await cdp.click(doBtn(i2));
    const doPrompts = await waitPrompts(pid, promptsBeforeDo + 1, 'do item');
    const doMsg = doPrompts[promptsBeforeDo].message;
    const doMatch = ENVELOPE.exec(doMsg);
    check(doMatch?.[2] === i2 && doMatch?.[4] === 'complete' && doMsg.includes('Review the diff HOLD') && doMsg.endsWith('\n</checklist-item>'), 'omp received an action="complete" turn quoting the step', doMsg);
    await cdp.waitFor(`/^Agent is doing this item:/.test(${doBtn(i2)}?.getAttribute('aria-label') ?? '')`, { timeoutMs: 10_000, label: 'item in progress' });
    const working = await doState(i2);
    const stored2 = await liveItem(i2);
    check(stored2.status === 'in_progress' && working.ariaDisabled === 'true' && working.disabled === false && working.label === 'Agent is doing this item: Review the diff HOLD', 'item is in_progress; its button reads "Agent is doing this item", aria-disabled=true and not disabled', { status: stored2.status, working });
    await shot('04-do-item-in-progress.png');
    await cdp.click(doBtn(i2));
    await sleep(700);
    check(prompts(pid).length === promptsBeforeDo + 1, 'clicking the in-progress button sends nothing more', prompts(pid).length);
    await cdp.evaluate(`${doBtn(i2)}.focus(); 1`);
    check((await cdp.evaluate(`document.activeElement === ${doBtn(i2)}`)) === true, 'the aria-disabled button still takes focus (it is not `disabled`)', await active());

    // 5. Queued: a send while the turn is held says so in words.
    check((await cdp.evaluate(`window.refract.sessions.list().then((r) => r.value.find((s) => s.id === ${JSON.stringify(sid)}).status)`)) === 'working', 'the Session is working while the item is held', 'working');
    await cdp.click(disclosure(i5));
    await cdp.waitFor(`!!${form(i5)}`, { timeoutMs: 5000, label: 'form on i5' });
    await type(i5, 'Queue this one');
    await ctrlEnter();
    await cdp.waitFor(`/Queued after the current turn/.test(${row(i5)}?.innerText ?? '')`, { timeoutMs: 10_000, label: 'queued line' });
    const queuedPrompts = await waitPrompts(pid, promptsBeforeDo + 2, 'queued');
    check(queuedPrompts[promptsBeforeDo + 1].streamingBehavior === 'followUp' && ENVELOPE.exec(queuedPrompts[promptsBeforeDo + 1].message)?.[4] === 'ask', 'a send to a working Session went as a follow-up and the row says "Queued after the current turn"', queuedPrompts[promptsBeforeDo + 1]);
    await shot('05-queued-line.png');
    await sleep(1200);
    await waitForSessionStatus(cdp, sid, 'idle', { timeoutMs: 30_000 });
    await cdp.waitFor(`/^Do this item:/.test(${doBtn(i2)}?.getAttribute('aria-label') ?? '')`, { timeoutMs: 15_000, label: 'item settles back' });
    const settled = await liveItem(i2);
    check(settled.status !== 'in_progress' && (await doState(i2)).ariaDisabled === 'false', 'when the turn ended the item left in_progress and "Do this item" is live again', { status: settled.status, state: await doState(i2) });
    // keep the queued note from masking later lines
    await cdp.evaluate(`${row(i5)}?.querySelector('[data-slot="checklist-item-note"]') ? 1 : 0`);

    // 6. Held: a paused Session keeps the turn; resume delivers it.
    const pauseRes = await cdp.evaluate(`window.refract.chat.pause(${JSON.stringify(sid)})`);
    check(pauseRes.ok === true, 'pause accepted', pauseRes);
    await cdp.waitFor(`window.refract.sessions.list().then((r) => r.value.find((s) => s.id === ${JSON.stringify(sid)}).pause === 'paused')`, { timeoutMs: 15_000, label: 'paused' });
    const countPaused = prompts(pid).length;
    await cdp.click(disclosure(i1));
    await cdp.waitFor(`!!${form(i1)}`, { timeoutMs: 5000, label: 'form on i1 (paused)' });
    await type(i1, 'Ask while paused');
    await ctrlEnter();
    await cdp.waitFor(`/Held until you resume/.test(${row(i1)}?.innerText ?? '')`, { timeoutMs: 10_000, label: 'held line' });
    await sleep(800);
    check(prompts(pid).length === countPaused, 'a paused Session did not hand the turn to omp yet', { before: countPaused, after: prompts(pid).length });
    await shot('06-held-line.png');
    await cdp.evaluate(`window.refract.chat.resume(${JSON.stringify(sid)})`);
    const resumed = await waitPrompts(pid, countPaused + 1, 'after resume');
    // A held turn resumes verbatim: the envelope is the whole message (#2013 fix 73bfee03).
    check(/^<checklist-item checklist="p1" item="i1" rev="\d+" action="ask">\nAsk while paused\n<\/checklist-item>$/.test(resumed[countPaused].message), 'resume delivered the held ask to omp verbatim (the envelope is the whole message)', resumed[countPaused]);
    await waitForSessionStatus(cdp, sid, 'idle', { timeoutMs: 30_000 });

    // 7. Refusals: omp refuses; the draft stays, the alert names what is safe.
    writeFileSync(refusalsFile, '1');
    const countRefuse = prompts(pid).length;
    await cdp.click(disclosure(i1));
    await cdp.waitFor(`!!${form(i1)}`, { timeoutMs: 5000, label: 'form on i1 (refuse)' });
    await type(i1, 'This one is refused');
    await ctrlEnter();
    await cdp.waitFor(`/Not sent/.test(${row(i1)}?.innerText ?? '')`, { timeoutMs: 15_000, label: 'refusal line' });
    const refused = await cdp.evaluate(`(() => { const f = ${form(i1)}; return { formOpen: !!f, draft: f?.querySelector('textarea').value, note: ${row(i1)}.querySelector('[data-slot="checklist-item-note"]').innerText.trim(), alert: !!${row(i1)}.querySelector('[data-slot="checklist-item-note"] [role="alert"]') }; })()`);
    check(refused.formOpen && refused.draft === 'This one is refused' && /Not sent\. Your question is still in the box\./.test(refused.note) && /The agent did not take it\./.test(refused.note), 'a refused ask keeps the form and the draft and says "Not sent. Your question is still in the box." with the reason', refused);
    check(prompts(pid).length === countRefuse + 1 && refused.alert, 'the refused prompt reached omp once (so the refusal was real) and the line is an alert', { count: prompts(pid).length - countRefuse, alert: refused.alert });
    await shot('07-refusal-keeps-draft.png');
    await cdp.evaluate(`${sendBtn(i1)}.click(); 1`);
    await waitPrompts(pid, countRefuse + 2, 'retry');
    await cdp.waitFor(`!${form(i1)}`, { timeoutMs: 10_000, label: 'form closes on the retry' });
    check(true, 'retrying the same draft went through and closed the form', await noteText(i1));
    await waitForSessionStatus(cdp, sid, 'idle', { timeoutMs: 30_000 });
    // A refused "Do this item": the item stays as it was.
    writeFileSync(refusalsFile, '1');
    await cdp.click(doBtn(i5));
    await cdp.waitFor(`/Not sent/.test(${row(i5)}?.innerText ?? '')`, { timeoutMs: 15_000, label: 'do refusal line' });
    const doRefused = { note: await noteText(i5), status: (await liveItem(i5)).status, button: await doState(i5) };
    check(/Not sent\. The item is unchanged\./.test(doRefused.note) && doRefused.status !== 'in_progress' && doRefused.button.ariaDisabled === 'false', 'a refused "Do this item" says the item is unchanged, and it is not in progress', doRefused);

    // 8. Escape: closes the form, keeps the draft, focus on the disclosure.
    await cdp.click(disclosure(i4));
    await cdp.waitFor(`!!${form(i4)}`, { timeoutMs: 5000, label: 'form on human item' });
    await type(i4, 'half-typed');
    await press(cdp, 'Escape', 'Escape', 27);
    await cdp.waitFor(`!${form(i4)}`, { timeoutMs: 5000, label: 'Escape closed the form' });
    const afterEsc = await active();
    check((await cdp.evaluate(disclosureFocused(i4))) === true && afterEsc.expanded === 'false', 'Escape closed the form and put focus on that item\'s disclosure (aria-expanded=false)', afterEsc);
    await shot('09-escape-focus-return.png');
    await cdp.click(disclosure(i4));
    await cdp.waitFor(`!!${form(i4)}`, { timeoutMs: 5000, label: 'form reopened' });
    check((await cdp.evaluate(`${area(i4)}.value`)) === 'half-typed', 'reopening restores the half-typed draft', await cdp.evaluate(`${area(i4)}.value`));
    check((await cdp.evaluate(`document.querySelectorAll('form[data-slot="checklist-item-form"]').length`)) === 1, 'only one form is ever open', 1);
    await press(cdp, 'Escape', 'Escape', 27);
    await cdp.waitFor(`!${form(i4)}`, { timeoutMs: 5000, label: 'closed again' });

    // 9. Keyboard only: Tab to the disclosure, Enter opens, type, Ctrl+Enter sends, Tab to Do this item, Space does it.
    await cdp.evaluate(`(() => { const sel = 'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'; const all = Array.from(document.querySelectorAll(sel)).filter((e) => e.getClientRects().length); const i = all.findIndex((e) => e.closest('[data-checklist-item]')); all[i - 1].focus(); return 1; })()`);
    const trail = [];
    let reached = false;
    for (let t = 0; t < 80 && !reached; t++) {
      await press(cdp, 'Tab', 'Tab', 9);
      reached = await cdp.evaluate(disclosureFocused(i5));
      trail.push((await active()).label);
    }
    check(reached, 'Tab alone reaches the disclosure of the last item', trail);
    // The ring fades in on a transition; sampling at once reads the transparent start colour.
    await sleep(600);
    const ring = await cdp.evaluate(`(() => { const s = getComputedStyle(document.activeElement); return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, boxShadow: s.boxShadow, focusVisible: document.activeElement.matches(':focus-visible') }; })()`);
    const painted = ring.boxShadow.split(/,\s*(?=rgb|oklch|color|lab|hsl)/).some((layer) => !layer.startsWith('rgba(0, 0, 0, 0)') && layer !== 'none');
    check(ring.focusVisible && (painted || (ring.outlineStyle !== 'none' && ring.outlineWidth !== '0px')), 'keyboard focus ring is visible on the disclosure', ring);
    await press(cdp, 'Enter', 'Enter', 13, { text: '\r' });
    await cdp.waitFor(`!!${form(i5)}`, { timeoutMs: 5000, label: 'Enter opened the form' });
    const keyCount = prompts(pid).length;
    await type(i5, 'Keyboard only question');
    await ctrlEnter();
    await waitPrompts(pid, keyCount + 1, 'keyboard ask');
    await cdp.waitFor(`!${form(i5)} && ${disclosureFocused(i5)}`, { timeoutMs: 10_000, label: 'form closed, focus back on disclosure' });
    const ringAfter = await cdp.evaluate(`document.activeElement.matches(':focus-visible')`);
    check(ringAfter === true, 'after a keyboard send focus is back on the disclosure with its focus ring', ringAfter);
    await waitForSessionStatus(cdp, sid, 'idle', { timeoutMs: 30_000 });
    await shot('08-keyboard-focus-ring.png');
    await press(cdp, 'Tab', 'Tab', 9);
    const next = await active();
    check(/^Do this item: Tag the release/.test(next.label ?? ''), 'Tab from the disclosure reaches "Do this item"', next);
    await press(cdp, ' ', 'Space', 32, { text: ' ' });
    const spacePrompts = await waitPrompts(pid, keyCount + 2, 'space do');
    check(ENVELOPE.exec(spacePrompts[keyCount + 1].message)?.[4] === 'complete' && ENVELOPE.exec(spacePrompts[keyCount + 1].message)?.[2] === i5, 'Space on "Do this item" sent the complete turn', spacePrompts[keyCount + 1].message);
    await waitForSessionStatus(cdp, sid, 'idle', { timeoutMs: 30_000 });
    settleTurn(pid);

    // 10. No agent: the form opens on the value, asking is off with its reason, a value saves with no prompt.
    const stop = await cdp.evaluate(`window.refract.sessions.stopAgent(${JSON.stringify(sid)})`);
    check(stop.ok === true, 'agent stopped', stop);
    await cdp.waitFor(`window.refract.sessions.list().then((r) => r.value.find((s) => s.id === ${JSON.stringify(sid)}).status === 'stopped')`, { timeoutMs: 20_000, label: 'Session stopped' });
    const promptsStopped = prompts(pid).length;
    const callsStopped = (await bridgeCalls()).length;
    await cdp.click(disclosure(i1));
    await cdp.waitFor(`!!${form(i1)}`, { timeoutMs: 5000, label: 'form with no agent' });
    const noAgent = await cdp.evaluate(`(() => { const f = ${form(i1)}; const radios = Array.from(f.querySelectorAll('[role="radio"]')); return { checked: f.querySelector('[role="radio"][aria-checked="true"]')?.textContent.trim(), askDisabled: radios.find((r) => r.textContent.trim() === 'Ask the agent').disabled || radios.find((r) => r.textContent.trim() === 'Ask the agent').getAttribute('aria-disabled'), reason: /The agent is not running, so it cannot be asked/.test(f.innerText), button: f.querySelector('button[type="submit"]').textContent.trim() }; })()`);
    check(noAgent.checked === 'Provide a value' && noAgent.askDisabled && noAgent.reason && noAgent.button === 'Save value', 'with no agent the form opens on Provide a value, Ask is off with its reason beside it, the button reads "Save value"', noAgent);
    const doNoAgent = await doState(i3);
    // The not-running hint shows only where the developer is working, so focus the button first.
    await cdp.evaluate(`${doBtn(i3)}.focus(); 1`);
    await cdp.waitFor(`/The agent is not running, so it cannot do this item/.test(${row(i3)}.innerText)`, { timeoutMs: 5000, label: 'not-running hint on focus' });
    check(doNoAgent?.ariaDisabled === 'true', '"Do this item" is aria-disabled with the not-running reason shown on focus', doNoAgent);
    await cdp.evaluate(`${form(i1)}.querySelector('textarea').focus(); 1`);
    await type(i1, 'saved-with-no-agent');
    await cdp.click(sendBtn(i1));
    await cdp.waitFor(`/Value saved on the item/.test(${row(i1)}?.innerText ?? '')`, { timeoutMs: 15_000, label: 'saved line' });
    const savedItem = await liveItem(i1);
    const calls = (await bridgeCalls()).slice(callsStopped);
    check(savedItem.value === 'saved-with-no-agent' && savedItem.valueBy === 'developer', 'the store holds the value, set by the developer', { value: savedItem.value, valueBy: savedItem.valueBy });
    check(prompts(pid).length === promptsStopped && calls.length === 1 && calls[0].startsWith('mutate:'), 'saving with no agent went through checklist.mutate only: no prompt, no item message', { promptsStopped, now: prompts(pid).length, calls });
    check(/Value saved on the item/.test(await noteText(i1)), 'the row says "Value saved on the item"', await noteText(i1));
    await shot('03-value-saved-no-agent.png');
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
  console.log(`\nverify-2013: ${verdict}`);
  if (app?.targetPid) console.log(`launched pid: ${app.targetPid}`);
  process.exitCode = failures.length ? 1 : 0;
}

main();
