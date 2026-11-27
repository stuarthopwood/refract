#!/usr/bin/env node
// Live CDP check for #696 (FR-195..FR-198): the Conversation tree dialog in the header's Conversation switcher. The scratch debug
// exe runs against the fake `omp` in serve mode with a seeded tree (REFRACT_FAKE_OMP_TREE_SEED: a model_change root, messages and a
// label entry), so get_tree / navigate_tree / fork / set_label answer like OMP 18.22.2. All data is scratch (REFRACT_DATA_DIR,
// REFRACT_OMP_SESSIONS_DIR = the fake's serve root), never the real %APPDATA%\refract-tauri or ~/.omp.
// Usage: CARGO_TARGET_DIR=<shared target> node scripts/verify-tauri-696.mjs

import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, existsSync, readFileSync, statSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, assertExeUnchanged } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName, waitForSessionStatus } from './verify-tauri-560-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TASK_DIR = process.env.REFRACT_696_DIR || path.join(tmpdir(), 'scratch', 'live-696');
const EVIDENCE_DIR = path.join(TASK_DIR, 'evidence');
const LOG = 'verify-696';

const NOT_IDLE_REASON = 'Rewind and Fork are available only while the agent is idle.';
const ts = (minute) => new Date(Date.UTC(2026, 0, 1, 10, minute)).toISOString();
const msg = (role, text) => ({ role, content: [{ type: 'text', text }], timestamp: 0 });
// model_change root; a label entry sits between the first user message and its reply, as OMP appends it at the leaf.
const ID = { root: 'e0000001', u1: 'e0000002', label: 'e0000003', a1: 'e0000004', u2: 'e0000005', a2: 'e0000006' };
const SEED_ENTRIES = [
  { type: 'model_change', id: ID.root, parentId: null, timestamp: ts(0), model: 'example-provider/example-model-1' },
  { type: 'message', id: ID.u1, parentId: ID.root, timestamp: ts(1), message: msg('user', 'Fix the build') },
  { type: 'label', id: ID.label, parentId: ID.u1, timestamp: ts(1), targetId: ID.u1, label: 'Start' },
  { type: 'message', id: ID.a1, parentId: ID.label, timestamp: ts(2), message: msg('assistant', 'Looking at the build.') },
  { type: 'message', id: ID.u2, parentId: ID.a1, timestamp: ts(3), message: msg('user', 'Add tests for it') },
  { type: 'message', id: ID.a2, parentId: ID.u2, timestamp: ts(4), message: msg('assistant', 'Tests added.') }
];

const DIALOG = `document.querySelector('[role="dialog"]')`;
const ALERT = `document.querySelector('[data-slot="alert-dialog-content"]')`;
const rowOf = (text) => `Array.from(document.querySelectorAll('[role="dialog"] [data-slot="conversation-tree-row"]')).find((li) => li.querySelector('p')?.textContent === ${JSON.stringify(text)})`;
const treeButton = (id) => `document.querySelector('[data-session-pane="${id}"] [aria-label="Conversation tree"]') ?? document.querySelector('[aria-label="Conversation tree"]')`;
const composer = (id) => `document.querySelector('[data-session-pane="${id}"] [aria-label="Message"]')`;
const sessionLi = (id) => `document.querySelector('[data-session-open="${id}"]')?.closest('li')`;
const chevron = (id) => `(${sessionLi(id)})?.querySelector('[data-testid="session-conversations"] button[aria-expanded]')`;
const groupOf = (id) => `document.getElementById('${id}-conversations')`;

async function main() {
  const failures = [];
  let passed = 0;
  const results = [];
  let current = null;
  const check = (condition, message) => {
    if (condition) passed += 1;
    else failures.push(`${current?.name ?? '-'}: ${message}`);
    current?.[condition ? 'pass' : 'fail'].push(message);
    if (!condition) console.error(`${LOG}: FAIL: ${message}`);
  };
  const realRegistry = path.join(process.env.APPDATA ?? '', 'refract-tauri', 'registry.json');
  const realRegistryMtimeBefore = existsSync(realRegistry) ? statSync(realRegistry).mtimeMs : null;
  let child, cdp, exeHash, runDir;
  const shots = [];
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const buildOutputDir = requireSharedCargoTarget(REPO_ROOT);
    runDir = mkdtempSync(path.join(TASK_DIR, 'run-'));
    const dirs = Object.fromEntries(['shim', 'data', 'import', 'repo', 'exe', 'launcher', 'serve'].map((n) => [n, path.join(runDir, n)]));
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    const repoDir = makeScratchRepo(path.join(dirs.repo, 'proj696'), 'verify-696');
    const repoName = path.basename(repoDir);
    const seedPath = path.join(dirs.exe, 'tree-seed.json');
    const recordFile = path.join(dirs.exe, 'host-tools.jsonl');
    const callsFile = path.join(dirs.exe, 'host-calls.jsonl');
    writeFileSync(seedPath, JSON.stringify({ entries: SEED_ENTRIES }));
    writeFileSync(recordFile, '');
    writeFileSync(callsFile, '');

    buildOmpShim(dirs.shim);
    const launcherExe = buildLauncher(dirs.launcher);
    const built = buildAndCopyExeFresh(dirs.exe, buildOutputDir, REPO_ROOT, { label: LOG });
    exeHash = built.hash;
    const port = await getFreePort();
    const launched = await launchBuiltExeWithEnv(launcherExe, built.dest, {
      port,
      dataDir: dirs.data,
      importSourceDir: dirs.import,
      pathPrepend: dirs.shim,
      logFile: path.join(dirs.exe, 'app.log'),
      extraEnv: {
        REFRACT_OMP_SESSIONS_DIR: dirs.serve,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'conversations-1861',
        REFRACT_FAKE_OMP_SERVE_ROOT: dirs.serve,
        REFRACT_FAKE_OMP_TREE_SEED: seedPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(dirs.exe, 'fake-omp-invocations.log'),
        REFRACT_FAKE_OMP_HOST_TOOL_RECORD: recordFile,
        REFRACT_FAKE_OMP_HOST_TOOL_CALLS: callsFile
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`${LOG}: CDP target on port ${port} is not owned by pid ${launched.targetPid}`);
    assertExeUnchanged(built.dest, exeHash, 'after launch', LOG);
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });

    const shot = async (name) => {
      await cdp.screenshot(path.join(EVIDENCE_DIR, name));
      shots.push(name);
    };
    const scenario = async (name, title, fn) => {
      current = { name, title, pass: [], fail: [] };
      try {
        await fn();
      } catch (err) {
        current.fail.push(`threw: ${err?.message ?? err}`);
        failures.push(`${name}: threw: ${err?.stack ?? err}`);
        console.error(`${LOG}: ${name} threw:`, err?.stack ?? err);
        await shot(`zz-${name}-error.png`).catch(() => {});
      }
      results.push({ name, title, verdict: current.fail.length === 0 && current.pass.length > 0 ? 'PASS' : 'FAIL', pass: current.pass, fail: current.fail });
      console.log(`${LOG}: [${results.at(-1).verdict}] ${name}: ${title}`);
      current = null;
    };

    const records = () => readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const knownPids = [];
    const newPid = async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const hit = records().find((r) => r.frame.type === 'set_host_tools' && !knownPids.includes(r.pid));
        if (hit) return (knownPids.push(hit.pid), hit.pid);
        await sleep(200);
      }
      throw new Error('no new omp process registered its host tools within 30s');
    };
    const sessionRow = (id) => cdp.evaluate(`window.refract.sessions.list().then((r) => r.value.find((s) => s.id === ${JSON.stringify(id)}))`);
    const ipcConversations = async (id) => {
      const r = await cdp.evaluate(`window.refract.conversations.list(${JSON.stringify(id)})`);
      if (!r.ok) throw new Error(`conversations.list failed: ${JSON.stringify(r)}`);
      return r.value;
    };
    const ipcTree = async (id) => {
      const r = await cdp.evaluate(`window.refract.conversations.tree(${JSON.stringify(id)})`);
      if (!r.ok) throw new Error(`conversations.tree failed: ${JSON.stringify(r)}`);
      return r.value;
    };
    const newSession = async (label) => {
      const before = (await cdp.evaluate(`window.refract.sessions.list().then((r) => r.value.map((s) => s.id))`)) ?? [];
      await createSessionViaQuickCreate(cdp, repoName);
      const found = await latestSessionIdAndName(cdp, repoName, before);
      const pid = await newPid();
      await waitForSessionStatus(cdp, found.id, 'idle');
      const sent = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(found.id)}, ${JSON.stringify(`First message of ${label}`)})`);
      if (!sent.ok) throw new Error(`chat.send failed: ${JSON.stringify(sent)}`);
      await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && r.value.some((s) => s.id === ${JSON.stringify(found.id)} && s.sessionDir && s.currentConversation))`, { timeoutMs: 30_000, label: `${label} has a Conversation` });
      await waitForSessionStatus(cdp, found.id, 'idle');
      return { id: found.id, pid, row: await sessionRow(found.id) };
    };
    const openSession = async (id) => {
      await cdp.click(`document.querySelector('[data-session-open="${id}"]')`);
      await cdp.waitFor(`document.querySelector('[data-session-open="${id}"]')?.getAttribute('aria-current') === 'true'`, { timeoutMs: 10_000, label: `Session ${id} open` });
      await sleep(300);
    };
    const key = async (name, code) => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
    };
    const openTree = async (id) => {
      await cdp.click(treeButton(id));
      await cdp.waitFor(`${DIALOG}?.textContent.includes('Conversation tree') && document.querySelectorAll('[role="dialog"] [data-slot="conversation-tree-row"]').length > 0`, { timeoutMs: 15_000, label: 'tree dialog rows' });
      await sleep(300);
    };
    const closeDialog = async () => {
      await key('Escape', 27);
      // After a Rewind the dialog reopens without focus inside it, so Escape alone may not reach it; the Close button is the fallback.
      await sleep(500);
      if (await cdp.evaluate(`!!${DIALOG}`)) await cdp.click(`${DIALOG}.querySelector('[data-slot="dialog-close"], button:has(svg.lucide-x)')`);
      await cdp.waitFor(`!${DIALOG}`, { timeoutMs: 10_000, label: 'dialog closed' });
    };
    const readRows = () =>
      cdp.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] [data-slot="conversation-tree-row"]')).map((li) => ({
        id: li.dataset.entryId,
        who: li.querySelector('span')?.textContent ?? '',
        text: li.querySelector('p')?.textContent ?? '',
        current: li.getAttribute('aria-current') === 'true',
        indent: li.style.marginLeft,
        badges: Array.from(li.querySelectorAll('[data-slot="badge"]')).map((b) => b.textContent.trim()),
        rewindDisabled: li.querySelector('[aria-label^="Rewind to here"]')?.getAttribute('aria-disabled') ?? null,
        forkDisabled: li.querySelector('[aria-label^="Fork from here"]')?.getAttribute('aria-disabled') ?? null,
        describedBy: li.querySelector('[aria-label^="Rewind to here"]')?.getAttribute('aria-describedby') ?? null
      }))`);
    const rowIn = (text) => cdp.evaluate(`(() => { const li = ${rowOf(text)}; return li ? { text: li.innerText, badges: Array.from(li.querySelectorAll('[data-slot="badge"]')).map((b) => b.textContent.trim()) } : null; })()`);

    await addRepository(cdp, repoDir);

    // --- 1 and 2 share Session A. ---
    const a = await newSession('A');
    await openSession(a.id);
    await scenario('s1-messages-with-labels', 'the tree dialog lists messages only, with their labels', async () => {
      await openTree(a.id);
      const rows = await readRows();
      const texts = rows.map((r) => r.text);
      check(JSON.stringify(texts) === JSON.stringify(['Fix the build', 'Looking at the build.', 'Add tests for it', 'Tests added.', 'First message of A', 'Noted.']), `rows are the six messages in order (got ${JSON.stringify(texts)})`);
      check(rows.every((r) => r.who === 'You' || r.who === 'Agent'), `every row is a You/Agent message, no model_change or label rows (got ${JSON.stringify(rows.map((r) => r.who))})`);
      const dialogText = await cdp.evaluate(`${DIALOG}.innerText`);
      check(!/model_change|example-model|\bStart\b.*\bStart\b/.test(dialogText), 'no model_change entry text leaks into the dialog');
      check(rows[0]?.badges.includes('Start'), `the labelled message shows its label "Start" (badges ${JSON.stringify(rows[0]?.badges)})`);
      check(rows.slice(1).every((r) => !r.badges.some((b) => b !== 'Current')), 'unlabelled messages carry no label badge');
      check(JSON.stringify(rows.map((r) => r.indent)) === JSON.stringify(['0rem', '0.75rem', '1.5rem', '2.25rem', '3rem', '3.75rem']), `a label entry between messages does not break the nesting (indents ${JSON.stringify(rows.map((r) => r.indent))})`);
      check(rows.at(-1)?.current === true && rows.filter((r) => r.current).length === 1, 'exactly the last message is marked Current');
      check(rows.every((r) => r.rewindDisabled !== 'true' && r.forkDisabled !== 'true'), 'Rewind and Fork are live on an idle Session');
      await shot('01-tree-messages-and-labels.png');
    });

    await scenario('s2-label-set-and-clear', 'set a label inline, then clear it', async () => {
      const labelOf = async () => (await ipcTree(a.id)).entries.find((e) => e.id === ID.a2)?.label ?? null;
      check((await labelOf()) === null, 'the target message has no label before');
      await cdp.click(`(${rowOf('Tests added.')}).querySelector('[aria-label^="Add label"]')`);
      await cdp.click(`(${rowOf('Tests added.')}).querySelector('[aria-label^="Label for"]')`);
      await cdp.send('Input.insertText', { text: 'Checkpoint' });
      await shot('02-label-editing.png');
      await cdp.pressEnter();
      await cdp.waitFor(`(${rowOf('Tests added.')})?.innerText.includes('Checkpoint') && !(${rowOf('Tests added.')}).querySelector('[aria-label^="Label for"]')`, { timeoutMs: 15_000, label: 'label badge shown' });
      check((await rowIn('Tests added.')).badges.includes('Checkpoint'), 'the row shows the new label badge');
      check((await labelOf()) === 'Checkpoint', `the label reached OMP (tree says ${JSON.stringify(await labelOf())})`);
      await shot('03-label-set.png');
      await closeDialog();
      await openTree(a.id);
      check((await rowIn('Tests added.')).badges.includes('Checkpoint'), 'the label is still there after closing and reopening the dialog');

      await cdp.click(`(${rowOf('Tests added.')}).querySelector('[aria-label^="Edit label"]')`);
      const input = `(${rowOf('Tests added.')}).querySelector('[aria-label^="Label for"]')`;
      await cdp.waitFor(`${input}?.value === 'Checkpoint'`, { timeoutMs: 10_000, label: 'edit starts from the current label' });
      await cdp.evaluate(`${input}.focus()`);
      await key('Escape', 27);
      await cdp.waitFor(`!(${rowOf('Tests added.')}).querySelector('[aria-label^="Label for"]')`, { timeoutMs: 10_000, label: 'Escape cancels the label edit' });
      check(await cdp.evaluate(`!!${DIALOG}`), 'Escape while editing a label keeps the dialog open');
      check((await labelOf()) === 'Checkpoint', 'Escape while editing a label leaves the label unchanged');
      await cdp.click(`(${rowOf('Tests added.')}).querySelector('[aria-label^="Edit label"]')`);
      await cdp.waitFor(`${input}?.value === 'Checkpoint'`, { timeoutMs: 10_000, label: 'edit restarts after Escape' });
      await cdp.evaluate(`${input}.select()`);
      await key('Backspace', 8);
      check((await cdp.evaluate(`${input}.value`)) === '', 'the label input was emptied');
      await cdp.pressEnter();
      await cdp.waitFor(`!(${rowOf('Tests added.')}).innerText.includes('Checkpoint') && !(${rowOf('Tests added.')}).querySelector('[aria-label^="Label for"]')`, { timeoutMs: 15_000, label: 'label badge gone' });
      check((await labelOf()) === null, `clearing removed the label in OMP (tree says ${JSON.stringify(await labelOf())})`);
      check((await rowIn('Tests added.')).badges.length === 0, 'the row shows no label badge');
      await shot('04-label-cleared.png');
      await closeDialog();
    });

    // --- 3. Rewind keeps the composer text. ---
    const b = await newSession('B');
    await openSession(b.id);
    await scenario('s3-rewind-composer', 'Rewind to an earlier user message hands its text to the composer and keeps what was typed', async () => {
      await cdp.click(composer(b.id));
      await cdp.send('Input.insertText', { text: 'draft before' });
      await cdp.waitFor(`${composer(b.id)}?.value === 'draft before'`, { timeoutMs: 10_000, label: 'draft typed' });
      await openTree(b.id);
      await cdp.click(`(${rowOf('Add tests for it')}).querySelector('[aria-label^="Rewind to here: Add tests"]')`);
      await cdp.waitFor(`!!(${ALERT})`, { timeoutMs: 10_000, label: 'Rewind confirmation' });
      await shot('05-rewind-confirm.png');
      await cdp.click(`Array.from((${ALERT}).querySelectorAll('button')).find((el) => el.textContent.trim() === 'Rewind')`);
      await cdp.waitFor(`!${DIALOG} && !(${ALERT})`, { timeoutMs: 20_000, label: 'dialogs closed after Rewind' });
      await sleep(500);
      const text = await cdp.evaluate(`${composer(b.id)}?.value ?? null`);
      check(text === 'Add tests for it\n\ndraft before', `composer holds the rewound message above the earlier draft (got ${JSON.stringify(text)})`);
      const tree = await ipcTree(b.id);
      check(tree.leafId === ID.a1, `OMP's leaf moved to the message before the target (leaf ${tree.leafId})`);
      const page = await cdp.evaluate('document.body.innerText');
      check(page.includes('Looking at the build.') && !page.includes('Tests added.') && !page.includes('First message of B'), 'the transcript ends at the rewound point');
      await shot('06-rewound-composer.png');
      await openTree(b.id);
      const rows = await readRows();
      check(rows.find((r) => r.current)?.text === 'Looking at the build.', 'reopening marks the new leaf Current');
      await closeDialog();
    });

    // --- 4. Fork. ---
    const c = await newSession('C');
    await openSession(c.id);
    await scenario('s4-fork-switcher-current', 'Fork shows the new Conversation as current, with no reattach mismatch', async () => {
      await cdp.click(chevron(c.id));
      await cdp.waitFor(`(${groupOf(c.id)})?.querySelectorAll('[data-conversation-file]').length === 1`, { timeoutMs: 20_000, label: 'nested list expanded with one Conversation' });
      const before = await ipcConversations(c.id);
      const oldFile = before.find((x) => x.isCurrent)?.file;
      await openTree(c.id);
      await cdp.click(`(${rowOf('Looking at the build.')}).querySelector('[aria-label^="Fork from here: Looking at"]')`);
      await cdp.waitFor(`!${DIALOG}`, { timeoutMs: 20_000, label: 'dialog closed after Fork' });
      await cdp.waitFor(`window.refract.conversations.list(${JSON.stringify(c.id)}).then((r) => r.ok && r.value.length === 2)`, { timeoutMs: 20_000, label: 'two Conversations listed' });
      const after = await ipcConversations(c.id);
      const currents = after.filter((x) => x.isCurrent);
      check(currents.length === 1 && currents[0].file !== oldFile, `exactly one Conversation is current and it is the new file (old ${oldFile}, current ${currents[0]?.file})`);
      const row = await sessionRow(c.id);
      check(row.currentConversation === currents[0]?.file || String(row.currentConversation).endsWith(path.basename(currents[0]?.file ?? '?')), `the Session row follows the fork (currentConversation ${row.currentConversation})`);
      check((await cdp.evaluate(`document.body.innerText`)).includes('Forked into a new Conversation'), 'the Fork notice is shown');
      const page = await cdp.evaluate('document.body.innerText');
      check(!/mismatch|Reattach verification/i.test(page), 'no reattach mismatch notice is shown');
      await waitForSessionStatus(cdp, c.id, 'idle');

      // The expanded nested list in the Session row follows the fork without a reload.
      await cdp.waitFor(`(${groupOf(c.id)})?.querySelectorAll('[data-conversation-file]').length === 2`, { timeoutMs: 20_000, label: 'nested list shows 2 Conversations' });
      const nestedCurrent = await cdp.evaluate(`(${groupOf(c.id)}).querySelector('[data-conversation-file] [aria-current="true"]')?.closest('li')?.dataset.conversationFile ?? null`);
      check(nestedCurrent === currents[0]?.file, `the Session row's nested list marks the forked Conversation current (${nestedCurrent})`);

      // The header switcher's history dialog does the same.
      await cdp.click(`document.querySelector('[data-session-pane="${c.id}"] [aria-label="Conversation history"]') ?? document.querySelector('[aria-label="Conversation history"]')`);
      await cdp.waitFor(`document.querySelectorAll('[role="dialog"] [data-conversation-file]').length === 2`, { timeoutMs: 15_000, label: 'history lists 2 Conversations' });
      const headerCurrent = await cdp.evaluate(`${DIALOG}.querySelector('[data-conversation-file] [aria-current="true"]')?.closest('li')?.dataset.conversationFile ?? null`);
      check(headerCurrent === currents[0]?.file, `the header switcher marks the forked Conversation current (${headerCurrent})`);
      await shot('07-fork-header-switcher.png');
      await closeDialog();
      await shot('08-fork-session-row-list.png');
    });

    // --- 5. A working Session refuses Rewind and Fork and says why. ---
    const d = await newSession('D');
    await openSession(d.id);
    await scenario('s5-held-turn-disabled', 'during a held turn Rewind and Fork are disabled with the reason shown', async () => {
      const sent = await cdp.evaluate(`window.refract.chat.send(${JSON.stringify(d.id)}, 'HOLD while I work')`);
      if (!sent.ok) throw new Error(`chat.send failed: ${JSON.stringify(sent)}`);
      await waitForSessionStatus(cdp, d.id, 'working', { timeoutMs: 30_000 });
      const fileBefore = (await sessionRow(d.id)).currentConversation;
      await openTree(d.id);
      const rows = await readRows();
      check(rows.length > 0 && rows.every((r) => r.rewindDisabled === 'true' && r.forkDisabled === 'true'), 'every row has aria-disabled Rewind and Fork');
      check((await cdp.evaluate(`${DIALOG}.innerText`)).includes(NOT_IDLE_REASON), 'the dialog shows the reason text');
      check(rows.every((r) => r.describedBy === 'conversation-tree-reason') && (await cdp.evaluate(`document.getElementById('conversation-tree-reason')?.textContent ?? ''`)).includes(NOT_IDLE_REASON), 'the buttons point at an element that carries the reason');
      await shot('09-held-turn-disabled.png');
      await cdp.click(`(${rowOf('Add tests for it')}).querySelector('[aria-label^="Rewind to here"]')`);
      await cdp.click(`(${rowOf('Add tests for it')}).querySelector('[aria-label^="Fork from here"]')`);
      await sleep(500);
      check(!(await cdp.evaluate(`!!(${ALERT})`)), 'clicking the disabled Rewind opens no confirmation');
      check((await sessionRow(d.id)).currentConversation === fileBefore && (await ipcConversations(d.id)).length === 1, 'clicking the disabled Fork created no Conversation');
      const refused = await cdp.evaluate(`window.refract.conversations.fork(${JSON.stringify(d.id)}, ${JSON.stringify(ID.a1)})`);
      check(refused.ok === false && refused.error?.code === 'not-idle', `the backend refuses Fork while working (${JSON.stringify(refused.error)})`);
      appendFileSync(callsFile, `${JSON.stringify({ __serve_settle__: true, __pid: d.pid })}\n`);
      await waitForSessionStatus(cdp, d.id, 'idle', { timeoutMs: 30_000 });
      await cdp.waitFor(`document.querySelector('[role="dialog"] [aria-label^="Rewind to here"]')?.getAttribute('aria-disabled') !== 'true'`, { timeoutMs: 15_000, label: 'actions live again once idle' });
      check(!(await cdp.evaluate(`${DIALOG}.innerText`)).includes(NOT_IDLE_REASON), 'the reason goes away once the Session is idle');
      await closeDialog();
    });
  } catch (err) {
    failures.push(`unhandled: ${err?.stack ?? err}`);
    console.error(`${LOG}: unhandled error:`, err?.stack ?? err);
    if (cdp) await cdp.screenshot(path.join(EVIDENCE_DIR, 'zz-error.png')).catch(() => {});
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    const realRegistryMtimeAfter = existsSync(realRegistry) ? statSync(realRegistry).mtimeMs : null;
    if (realRegistryMtimeBefore !== realRegistryMtimeAfter) failures.push('the real %APPDATA%\\refract-tauri\\registry.json mtime changed during the run');
    try {
      for (const name of ['app.log', 'fake-omp-invocations.log']) {
        const from = path.join(runDir ?? '', 'exe', name);
        if (runDir && existsSync(from)) copyFileSync(from, path.join(EVIDENCE_DIR, name));
      }
      const dirty = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).stdout.split('\n').filter(Boolean);
      writeFileSync(path.join(EVIDENCE_DIR, 'report.json'), JSON.stringify({ gitHead: gitHead(REPO_ROOT), dirty, exeSha256: exeHash ?? null, realRegistryMtimeBefore, realRegistryMtimeAfter, results, failures, screenshots: shots }, null, 2));
    } catch (err) {
      console.warn(`${LOG}: could not write report.json: ${err.message}`);
    }
    if (runDir) await safeRmSync(runDir, LOG);
    for (const r of results) console.log(`${LOG}: ${r.verdict} ${r.name}${r.fail.length ? ` -- ${r.fail.join(' | ')}` : ''}`);
    console.log(`${LOG}: ${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAILURE(S)`} (${passed} checks passed); evidence in ${EVIDENCE_DIR}`);
    if (failures.length > 0) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`${LOG}: unhandled error:`, err?.stack ?? err);
  process.exitCode = 1;
});
