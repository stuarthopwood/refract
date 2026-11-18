#!/usr/bin/env node
// Live CDP check for #1862 (Session list tree for nested Sessions). A fake omp replays host tool calls, so parents,
// children and a grandchild exist for real: tree levels, collapse, the roll-up text, keyboard moves, the archive dialog
// (both buttons), the one-shot announcement, and a collapsed parent surviving a restart, at default and 320 px widths.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_1862_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-1862.mjs

import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, computeDirty, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, switchTheme } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, rightClick } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName, waitForSessionStatus } from './verify-tauri-560-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = process.env.REFRACT_1862_SHOTS_DIR || path.join(tmpdir(), 'refract-1862-shots');
mkdirSync(SHOTS_DIR, { recursive: true });

const findings = [];
const failures = [];
const shots = [];
const ariaReadings = [];
const check = (ok, pass, fail) => (ok ? findings.push(pass) : failures.push(fail));
const KEY_CODES = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, Escape: 27 };

const q = (id) => JSON.stringify(`[role="treeitem"][data-session-id="${id}"]`);
const openButton = (id) => `document.querySelector(${JSON.stringify(`[data-session-open="${id}"]`)})`;
const toggleFor = (name) => `document.querySelector(${JSON.stringify(`button[aria-label="Collapse ${name}"], button[aria-label="Expand ${name}"]`)})`;
const readItem = (id) => `(() => {
  const li = document.querySelector(${q(id)});
  if (!li) return null;
  const b = li.querySelector('[data-session-open]');
  return {
    level: li.getAttribute('aria-level'), setSize: li.getAttribute('aria-setsize'), posInSet: li.getAttribute('aria-posinset'),
    expanded: li.getAttribute('aria-expanded'), name: b.getAttribute('aria-label'),
    count: b.querySelector('[data-testid="session-tree-count"]')?.textContent ?? null,
    from: b.querySelector('[data-testid="session-from-line"]')?.textContent ?? null
  };
})()`;
const dialogText = `(() => { const d = document.querySelector('[role="alertdialog"], [role="dialog"]'); return d ? d.innerText.replace(/\\s+/g, ' ').trim() : null; })()`;
const approveCount = `Array.from(document.querySelectorAll('button')).filter((el) => el.textContent.trim() === 'Approve').length`;
// The archive dialog is a Radix alertdialog, which the shared `clickByText({ inDialog })` scope (role="dialog") misses.
const dialogButton = (label) => `Array.from(document.querySelectorAll('[role="alertdialog"] button, [role="dialog"] button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)})`;

async function main() {
  const dirs = [];
  let child, cdp, exeDir;
  let exeHash = null;
  const gitHeadSha = gitHead(REPO_ROOT);
  const dirty = computeDirty(REPO_ROOT);
  try {
    const buildDir = requireSharedCargoTarget(REPO_ROOT);
    const mk = (name) => {
      const dir = mkdtempSync(path.join(tmpdir(), `refract-1862-${name}-`));
      dirs.push(dir);
      return dir;
    };
    const shimDir = mk('shim');
    const dataDir = mk('data');
    const importSourceDir = mk('import');
    const repoDir = makeScratchRepo(mk('repo'), 'verify-1862');
    exeDir = mk('exe');
    const launcherDir = mk('launcher');
    const repoName = path.basename(repoDir);
    const recordFile = path.join(exeDir, 'host-tools.jsonl');
    const callsFile = path.join(exeDir, 'host-calls.jsonl');
    writeFileSync(recordFile, '');
    writeFileSync(callsFile, '');
    console.log(`verify-1862: git HEAD ${gitHeadSha} dirty=${dirty}; shots ${SHOTS_DIR}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, buildDir, REPO_ROOT, { label: 'verify-1862' });
    exeHash = built.hash;

    const launch = async () => {
      const port = await getFreePort();
      const launched = await launchBuiltExeWithEnv(launcherExe, built.dest, {
        port,
        dataDir,
        importSourceDir,
        pathPrepend: shimDir,
        logFile: path.join(exeDir, `app-${port}.log`),
        extraEnv: {
          REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
          REFRACT_FAKE_OMP_NODE: process.execPath,
          REFRACT_FAKE_OMP_SCENARIO: 'session-tools-1858',
          REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log'),
          REFRACT_FAKE_OMP_HOST_TOOL_RECORD: recordFile,
          REFRACT_FAKE_OMP_HOST_TOOL_CALLS: callsFile
        }
      });
      child = launched.child;
      cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
      if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`CDP target on port ${port} is not owned by pid ${launched.targetPid}`);
      await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]') || !!document.querySelector('[data-repository-id]')`, { timeoutMs: 30_000, label: 'App mounted' });
    };
    await launch();
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return !b || (b.getAttribute('aria-disabled') !== 'true' && !b.disabled); })()`, { timeoutMs: 60_000, label: 'Readiness green' });

    const records = () => readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const resultFor = async (id) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const hit = records().find((r) => r.frame.type === 'host_tool_result' && r.frame.id === id);
        if (hit) return { isError: hit.frame.isError === true, body: JSON.parse(hit.frame.result.content[0].text) };
        await sleep(150);
      }
      throw new Error(`no host_tool_result for ${id} within 30s`);
    };
    let n = 0;
    const post = (toolName, args, pid) => {
      const id = `hc-${++n}`;
      appendFileSync(callsFile, `${JSON.stringify({ type: 'host_tool_call', id, toolCallId: `t-${n}`, toolName, arguments: args, __pid: pid })}\n`);
      return id;
    };
    const shot = async (name) => {
      await cdp.screenshot(path.join(SHOTS_DIR, name));
      shots.push({ name, sha256: createHash('sha256').update(readFileSync(path.join(SHOTS_DIR, name))).digest('hex') });
    };
    const knownPids = [];
    const pidAfter = async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const hit = records().find((r) => r.frame.type === 'set_host_tools' && !knownPids.includes(r.pid));
        if (hit) return (knownPids.push(hit.pid), hit.pid);
        await sleep(200);
      }
      throw new Error('no new omp process registered its host tools within 30s');
    };
    const listRow = (id) => cdp.evaluate(`window.refract.sessions.list().then((r) => (r.ok ? r.value.find((s) => s.id === ${JSON.stringify(id)}) ?? null : null))`);
    const openSession = async (id) => {
      await cdp.waitFor(`!!${openButton(id)}`, { timeoutMs: 10_000, label: `row ${id} mounted` });
      await cdp.evaluate(`${openButton(id)}.scrollIntoView({ block: 'center' })`);
      await sleep(200);
      await cdp.click(openButton(id));
      await cdp.waitFor(`${openButton(id)}?.getAttribute('aria-current') === 'true'`, { timeoutMs: 10_000, label: `Session ${id} open` });
      await sleep(300);
    };
    // The create call raises its approval card in the caller's pane, so the caller's pane is open first.
    const create = async (parent, args, { approve = true } = {}) => {
      await openSession(parent.id);
      const id = post('refract_create_session', args, parent.pid);
      if (approve) {
        await cdp.waitFor(`${approveCount} > 0`, { timeoutMs: 20_000, label: 'approval card' });
        await sleep(300);
        await cdp.clickByText('Approve');
      }
      const res = await resultFor(id);
      return { ...res.body, pid: await pidAfter() };
    };
    // The row count the quick-create helper waits on also rises when an earlier child's row mounts late, so every Session
    // seeded so far must be on screen before the click, and the new root must be seen before its id is read.
    const quickRoot = async (exclude, mounted = exclude) => {
      for (const id of mounted) await cdp.waitFor(`!!${openButton(id)}`, { timeoutMs: 15_000, label: `seeded row ${id} mounted` });
      await createSessionViaQuickCreate(cdp, repoName);
      await cdp.waitFor(`Array.from(document.querySelectorAll('[data-session-open]')).some((el) => !${JSON.stringify(exclude)}.includes(el.getAttribute('data-session-open')))`, { timeoutMs: 30_000, label: 'new root row mounted' });
      const s = await latestSessionIdAndName(cdp, repoName, exclude);
      s.pid = await pidAfter();
      await waitForSessionStatus(cdp, s.id, 'idle');
      return s;
    };
    const press = async (key) => {
      const base = { key, code: key, windowsVirtualKeyCode: KEY_CODES[key] };
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(250);
    };
    const activeSessionId = () => cdp.evaluate(`document.activeElement?.closest('[data-session-id]')?.getAttribute('data-session-id') ?? null`);
    const useWidth = async (width) => {
      if (width) await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 760, deviceScaleFactor: 1, mobile: false });
      else await cdp.send('Emulation.clearDeviceMetricsOverride');
      await sleep(500);
    };
    // A control or row that pokes outside its tree list would be clipped by the pane; the list itself must not scroll sideways.
    const overflowProblems = () => cdp.evaluate(`(() => {
      const tree = document.querySelector('[role="tree"]');
      if (!tree) return ['no role=tree list'];
      const bad = [];
      if (tree.scrollWidth > tree.clientWidth + 1) bad.push('tree list scrolls sideways ' + tree.scrollWidth + ' > ' + tree.clientWidth);
      const box = tree.getBoundingClientRect();
      for (const el of tree.querySelectorAll('button')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.left < box.left - 1 || r.right > box.right + 1) bad.push((el.getAttribute('aria-label') ?? '').slice(0, 40) + ' outside the list');
      }
      return bad;
    })()`);

    // ---- Seed: P with k1 (holding g1) and k2. P2 with m1 and Q with q1 are seeded later, inside the six-Session limit.
    await addRepository(cdp, repoDir);
    const P = await quickRoot([]);
    const k1 = await create(P, { prompt: 'Do k1', name: 'k1' });
    const k2 = await create(P, { prompt: 'Do k2', name: 'k2' });
    const g1 = await create({ id: k1.id, pid: k1.pid }, { prompt: 'Do g1', name: 'g1' });
    check(k1.parentId === P.id && k2.parentId === P.id && g1.parentId === k1.id, 'Seed: k1 and k2 are children of P and g1 a child of k1.', `seed parents: ${JSON.stringify({ k1, k2, g1 })}`);
    // A parent that just called refract_create_session stays mid-turn in the fake omp, so only the leaves are awaited.
    for (const id of [k2.id, g1.id]) await waitForSessionStatus(cdp, id, 'idle');
    await switchTheme(cdp, 'dark', 'Dark');
    await cdp.waitFor(`!!document.querySelector(${q(g1.id)})`, { timeoutMs: 15_000, label: 'grandchild row mounted in the tree' });

    // ---- SC-001/SC-002: levels, set sizes, default expanded, counts and from lines.
    const rowP = await cdp.evaluate(readItem(P.id));
    const rowK1 = await cdp.evaluate(readItem(k1.id));
    const rowK2 = await cdp.evaluate(readItem(k2.id));
    const rowG1 = await cdp.evaluate(readItem(g1.id));
    ariaReadings.push({ step: 'default', P: rowP, k1: rowK1, k2: rowK2, g1: rowG1 });
    check(rowP?.level === '1' && rowP.expanded === 'true' && rowP.count?.includes('2 children'), `P is level 1, expanded by default, and reads "${rowP?.count}".`, `P reading: ${JSON.stringify(rowP)}`);
    check(rowK1?.level === '2' && rowK1.setSize === '2' && rowK2?.level === '2' && rowK2.setSize === '2' && new Set([rowK1.posInSet, rowK2.posInSet]).size === 2, 'k1 and k2 are level 2 in a set of 2 with distinct positions.', `k1/k2 readings: ${JSON.stringify([rowK1, rowK2])}`);
    check(rowG1?.level === '3' && rowK1?.expanded === 'true' && rowK1.count?.includes('1 child'), `g1 is level 3; k1 is expanded and reads "${rowK1?.count}".`, `g1/k1 readings: ${JSON.stringify([rowG1, rowK1])}`);
    check(rowK1?.from === `from ${P.name}` && rowG1?.from === 'from k1', `Child rows say "${rowK1?.from}" and "${rowG1?.from}" as text.`, `from lines: ${JSON.stringify([rowK1?.from, rowG1?.from])}`);
    const leaf = await cdp.evaluate(readItem(k2.id));
    check(leaf?.expanded === null, 'A leaf child carries no aria-expanded.', `leaf expanded attr: ${leaf?.expanded}`);

    // ---- SC-007: default and 320 px widths, dark then light.
    for (const [themeId, themeName] of [['dark', 'Dark'], ['light', 'Light']]) {
      if (themeId === 'light') await switchTheme(cdp, themeId, themeName);
      await shot(`01-tree-default-${themeId}.png`);
      const wide = await overflowProblems();
      check(wide.length === 0, `Default width, ${themeName}: no list overflow and every row control sits inside the list.`, `default ${themeName} overflow: ${JSON.stringify(wide)}`);
      await useWidth(320);
      await shot(`02-tree-320-${themeId}.png`);
      const narrow = await overflowProblems();
      check(narrow.length === 0, `320 px, ${themeName}: no list overflow and every row control sits inside the list.`, `320 ${themeName} overflow: ${JSON.stringify(narrow)}`);
      await useWidth(null);
    }
    await switchTheme(cdp, 'dark', 'Dark');

    // ---- SC-005: keyboard.
    const stepKey = async (label, key) => {
      await press(key);
      const reading = { step: label, key, focus: await activeSessionId(), P: (await cdp.evaluate(readItem(P.id)))?.expanded };
      ariaReadings.push(reading);
      return reading;
    };
    await cdp.evaluate(`${openButton(P.id)}.focus()`);
    const left1 = await stepKey('P collapsed by Left', 'ArrowLeft');
    check(left1.P === 'false' && left1.focus === P.id, 'Left Arrow on expanded P collapses it and focus stays on P.', `left on P: ${JSON.stringify(left1)}`);
    const right1 = await stepKey('P expanded by Right', 'ArrowRight');
    check(right1.P === 'true' && right1.focus === P.id, 'Right Arrow on collapsed P expands it and focus stays.', `right on collapsed P: ${JSON.stringify(right1)}`);
    const right2 = await stepKey('Right moves to first child', 'ArrowRight');
    check([k1.id, k2.id].includes(right2.focus), `Right Arrow on expanded P moves focus to its first child (${right2.focus}).`, `right on expanded P: ${JSON.stringify(right2)}`);
    const left2 = await stepKey('Left moves back to parent', 'ArrowLeft');
    check(left2.focus === P.id, 'Left Arrow on a child moves focus to its parent.', `left on child: ${JSON.stringify(left2)}`);
    const down = await stepKey('Down', 'ArrowDown');
    check(down.focus !== P.id && down.focus !== null, `Down Arrow moves to the next visible row (${down.focus}).`, `down: ${JSON.stringify(down)}`);
    const end = await stepKey('End', 'End');
    const home = await stepKey('Home', 'Home');
    check(end.focus !== null && end.focus !== home.focus && home.focus !== null, `End and Home reach different rows (${end.focus}, ${home.focus}).`, `end/home: ${JSON.stringify([end, home])}`);
    await shot('03-keyboard-focus.png');

    // ---- SC-002/SC-003: collapse P while k1 is open, then k1 raises an approval card.
    await openSession(k1.id);
    await cdp.click(toggleFor(P.name));
    await cdp.waitFor(`document.querySelector(${q(P.id)})?.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'P collapsed by the toggle' });
    const collapsed = await cdp.evaluate(readItem(P.id));
    const hidden = await cdp.evaluate(`!document.querySelector(${q(k1.id)}) && !document.querySelector(${q(g1.id)})`);
    ariaReadings.push({ step: 'collapsed', P: collapsed });
    check(hidden && collapsed?.count?.trim() === '2 children', `Collapsed P hides its descendants and reads "${collapsed?.count}".`, `collapsed P: ${JSON.stringify(collapsed)} hidden=${hidden}`);
    const askId = post('refract_create_session', { prompt: 'needs approval', name: 'k1-kid' }, k1.pid);
    await waitForSessionStatus(cdp, k1.id, 'needs-you');
    await cdp.waitFor(`document.querySelector(${q(P.id)})?.querySelector('[data-testid="session-tree-count"]')?.textContent.includes('needs you')`, { timeoutMs: 15_000, label: 'roll-up text on collapsed P' });
    const rolled = await cdp.evaluate(readItem(P.id));
    ariaReadings.push({ step: 'collapsed with a child waiting', P: rolled });
    check(rolled?.count === '1 needs you, 2 children', `Collapsed P shows the roll-up "${rolled?.count}".`, `roll-up reading: ${JSON.stringify(rolled)}`);
    check(/needs you/i.test(rolled?.name ?? ''), `The roll-up is in P's accessible name: "${rolled?.name}".`, `roll-up name: ${rolled?.name}`);
    await shot('04-collapsed-rollup.png');
    await cdp.click(toggleFor(P.name));
    await cdp.waitFor(`!!document.querySelector(${q(k1.id)})`, { timeoutMs: 10_000, label: 'P expanded again' });
    const expandedNow = await cdp.evaluate(readItem(P.id));
    check(expandedNow?.count?.trim() === '2 children', `Expanded P drops the roll-up and reads "${expandedNow?.count}".`, `expanded P: ${JSON.stringify(expandedNow)}`);
    await cdp.waitFor(`${approveCount} > 0`, { timeoutMs: 15_000, label: 'k1 approval card' });
    await cdp.clickByText('Deny');
    await resultFor(askId);
    await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && r.value.find((s) => s.id === ${JSON.stringify(k1.id)})?.status !== 'needs-you')`, { timeoutMs: 30_000, label: 'k1 leaves needs-you after Deny' });

    // Seeded only now: P's tree plus P2 and m1 would reach the six-Session Project limit before k1's request above.
    const P2 = await quickRoot([P.id, k1.id, k2.id, g1.id]);
    const m1 = await create(P2, { prompt: 'Do m1', name: 'm1' });
    await waitForSessionStatus(cdp, m1.id, 'idle');

    // ---- SC-004: archive dialog. P2 has one running child: Escape, then Archive parent only.
    const archiveFromMenu = async (sessionId) => {
      await rightClick(cdp, openButton(sessionId));
      await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Archive')`, { timeoutMs: 10_000, label: 'row menu with Archive' });
      await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Archive')`);
    };
    await archiveFromMenu(P2.id);
    await cdp.waitFor(`${dialogText} !== null`, { timeoutMs: 10_000, label: 'archive dialog for P2' });
    const d2 = await cdp.evaluate(dialogText);
    check(d2.includes(`Archive '${P2.name}' and its 1 child Session?`) && ['Archive all', 'Archive parent only', 'Cancel'].every((b) => d2.includes(b)) && d2.includes('Running now:') && d2.includes('m1'), `Dialog for P2 asks the 1-child question, lists "Running now:" with m1, and offers the three buttons.`, `P2 dialog: ${d2}`);
    await shot('05-archive-dialog-one-child.png');
    await press('Escape');
    await cdp.waitFor(`${dialogText} === null`, { timeoutMs: 10_000, label: 'dialog closed by Escape' });
    const afterEsc = await listRow(P2.id);
    const escFocus = await activeSessionId();
    check(!afterEsc?.archivedAt && escFocus === P2.id, 'Escape closed the dialog, changed nothing, and focus returned to P2\'s row.', `after Escape archivedAt=${afterEsc?.archivedAt} focus=${escFocus}`);
    await archiveFromMenu(P2.id);
    await cdp.waitFor(`${dialogText} !== null`, { timeoutMs: 10_000, label: 'archive dialog for P2 again' });
    await cdp.click(dialogButton('Archive parent only'));
    await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && !!r.value.find((s) => s.id === ${JSON.stringify(P2.id)})?.archivedAt)`, { timeoutMs: 20_000, label: 'P2 archived' });
    const m1Row = await listRow(m1.id);
    await cdp.waitFor(`!!document.querySelector(${q(m1.id)})`, { timeoutMs: 10_000, label: 'm1 row at top level' });
    const m1Item = await cdp.evaluate(readItem(m1.id));
    ariaReadings.push({ step: 'after archive parent only', m1: m1Item });
    check(!m1Row?.archivedAt && m1Item?.level === '1' && m1Item.from === `from ${P2.name} (archived)`, `Archive parent only left m1 live at level 1 reading "${m1Item?.from}".`, `m1 after parent-only: ${JSON.stringify({ m1Row, m1Item })}`);
    await shot('06-after-archive-parent-only.png');

    // P has k1, k2 and g1 live: Cancel button first, then Archive all.
    await archiveFromMenu(P.id);
    await cdp.waitFor(`${dialogText} !== null`, { timeoutMs: 10_000, label: 'archive dialog for P' });
    const d1 = await cdp.evaluate(dialogText);
    check(d1.includes(`Archive '${P.name}' and its 3 child Sessions?`) && ['k1', 'k2', 'g1'].every((s) => d1.includes(s)), 'Dialog for P asks the 3-child question and lists k1, k2 and g1 as running.', `P dialog: ${d1}`);
    await shot('07-archive-dialog-three-children.png');
    await cdp.click(dialogButton('Cancel'));
    await cdp.waitFor(`${dialogText} === null`, { timeoutMs: 10_000, label: 'dialog closed by Cancel' });
    const afterCancel = await Promise.all([P, k1, k2, g1].map((s) => listRow(s.id)));
    check(afterCancel.every((r) => !r?.archivedAt), 'Cancel changed nothing: P, k1, k2 and g1 are still live.', `after Cancel: ${JSON.stringify(afterCancel)}`);
    await archiveFromMenu(P.id);
    await cdp.waitFor(`${dialogText} !== null`, { timeoutMs: 10_000, label: 'archive dialog for P again' });
    await cdp.click(dialogButton('Archive all'));
    await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && [${[P, k1, k2, g1].map((s) => JSON.stringify(s.id)).join(',')}].every((id) => !!r.value.find((s) => s.id === id)?.archivedAt))`, { timeoutMs: 30_000, label: 'P, k1, k2 and g1 archived' });
    check(true, 'Archive all archived P, k1, k2 and g1.', '');
    await shot('08-after-archive-all.png');

    // The Project allows 6 live Sessions, so Q's tree is seeded only now that archiving P's tree has freed slots.
    const Q = await quickRoot([P.id, k1.id, k2.id, g1.id, P2.id, m1.id], [m1.id]);
    const q1 = await create(Q, { prompt: 'Do q1', name: 'q1' });
    await waitForSessionStatus(cdp, q1.id, 'idle');

    // ---- SC-006: an agent-created child is announced once, polite, without moving focus. Only `yolo` skips the approval card
    // (spec 131 FR-003), so each create is approved with a DOM click, which unlike a pointer click leaves focus where it was.
    await openSession(Q.id);
    const approveByDom = `(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve'); b?.click(); return !!b; })()`;
    await cdp.evaluate(`(() => {
      window.__live = [];
      const seen = (node) => { const el = node.nodeType === 1 ? node : node.parentElement; const region = el?.closest('[aria-live]'); const text = region?.textContent?.trim(); if (text && text.includes('created under')) window.__live.push({ text, live: region.getAttribute('aria-live') }); };
      new MutationObserver((rs) => { for (const r of rs) { r.addedNodes.forEach(seen); if (r.type === 'characterData') seen(r.target); } }).observe(document.body, { childList: true, subtree: true, characterData: true });
      return true;
    })()`);
    const postQ2 = post('refract_create_session', { prompt: 'Do q2', name: 'q2' }, Q.pid);
    await cdp.waitFor(`${approveCount} > 0`, { timeoutMs: 20_000, label: 'q2 approval card' });
    await sleep(300);
    await cdp.evaluate(`${openButton(Q.id)}.focus()`);
    const before = await activeSessionId();
    await cdp.evaluate(approveByDom);
    const q2 = await resultFor(postQ2);
    await pidAfter();
    await cdp.waitFor(`window.__live.length > 0`, { timeoutMs: 15_000, label: 'announcement for q2' });
    await sleep(1500);
    const live1 = await cdp.evaluate(`window.__live.slice()`);
    const focusAfter = await activeSessionId();
    const announcedQ2 = live1.filter((l) => l.text.includes('q2 created under'));
    check(!q2.isError && announcedQ2.length === 1 && announcedQ2[0].live === 'polite' && announcedQ2[0].text.includes(`q2 created under ${Q.name}`), `q2 was announced once through a polite region: "${announcedQ2[0]?.text}".`, `q2 announcements: ${JSON.stringify(live1)} result ${JSON.stringify(q2)}`);
    check(before === Q.id && focusAfter === Q.id, 'Focus stayed on Q\'s row through the announcement.', `focus ${before} -> ${focusAfter}`);
    await cdp.click(toggleFor(Q.name));
    await cdp.waitFor(`document.querySelector(${q(Q.id)})?.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 10_000, label: 'Q collapsed' });
    await cdp.evaluate(`window.__live.length = 0`);
    const postQ3 = post('refract_create_session', { prompt: 'Do q3', name: 'q3' }, Q.pid);
    await cdp.waitFor(`${approveCount} > 0`, { timeoutMs: 20_000, label: 'q3 approval card' });
    await sleep(300);
    await cdp.evaluate(approveByDom);
    const q3 = await resultFor(postQ3);
    await pidAfter();
    await cdp.waitFor(`window.__live.length > 0`, { timeoutMs: 15_000, label: 'announcement for q3' });
    await sleep(1500);
    const live2 = await cdp.evaluate(`window.__live.slice()`);
    const announcedQ3 = live2.filter((l) => l.text.includes('q3 created under'));
    check(!q3.isError && announcedQ3.length === 1 && announcedQ3[0].text.includes('(collapsed)'), `q3 under collapsed Q was announced once with "(collapsed)": "${announcedQ3[0]?.text}".`, `q3 announcements: ${JSON.stringify(live2)}`);
    await shot('09-collapsed-after-announcement.png');

    // ---- SC-002: the collapsed state survives a restart.
    await cdp.waitFor(`window.refract.settings.get ? true : true`, { timeoutMs: 5_000 });
    await sleep(1000);
    cdp.close();
    await stopLauncher(child);
    cdp = null;
    await launch();
    await cdp.waitFor(`!!document.querySelector(${q(Q.id)})`, { timeoutMs: 60_000, label: 'Q row after restart' });
    const restarted = await cdp.evaluate(readItem(Q.id));
    const kidsHidden = await cdp.evaluate(`!document.querySelector(${q(q1.id)})`);
    ariaReadings.push({ step: 'after restart', Q: restarted });
    check(restarted?.expanded === 'false' && kidsHidden, `After a restart Q is still collapsed (aria-expanded ${restarted?.expanded}) and its children are hidden.`, `after restart: ${JSON.stringify(restarted)} kidsHidden=${kidsHidden}`);
    await shot('10-after-restart-collapsed.png');

    const verdict = failures.length ? 'FAILED' : 'DONE';
    writeReport({ gitHead: gitHeadSha, dirty, exeSha256: exeHash, shots, ariaReadings, findings, failures, verdict });
    console.log('\n=== FAILURES ===');
    for (const f of failures) console.log(`- ${f}`);
    if (!failures.length) console.log('(none)');
    console.log('\n=== FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log(`\nverify-1862: ${verdict}. Shots: ${SHOTS_DIR}`);
    process.exitCode = failures.length ? 1 : 0;
  } catch (err) {
    console.error('verify-1862: FAILED:', err?.stack ?? err);
    try {
      writeReport({ gitHead: gitHeadSha, dirty, exeSha256: exeHash, shots, ariaReadings, findings, failures, error: String(err?.stack ?? err) });
      if (cdp) await cdp.screenshot(path.join(SHOTS_DIR, 'zz-error.png')).catch(() => {});
    } catch {}
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    try {
      for (const name of readdirSync(exeDir ?? SHOTS_DIR)) {
        if (exeDir && /^(app-\d+\.log|fake-omp-invocations\.log|host-tools\.jsonl|host-calls\.jsonl)$/.test(name)) copyFileSync(path.join(exeDir, name), path.join(SHOTS_DIR, name));
      }
    } catch {}
    for (const dir of dirs) await safeRmSync(dir);
    hashEvidence();
  }
}

function writeReport(report) {
  writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
}

function hashEvidence() {
  const sums = {};
  for (const name of readdirSync(SHOTS_DIR).sort()) {
    if (name === 'sha256.json' || !existsSync(path.join(SHOTS_DIR, name))) continue;
    sums[name] = createHash('sha256').update(readFileSync(path.join(SHOTS_DIR, name))).digest('hex');
  }
  writeFileSync(path.join(SHOTS_DIR, 'sha256.json'), JSON.stringify(sums, null, 2));
}

main();
