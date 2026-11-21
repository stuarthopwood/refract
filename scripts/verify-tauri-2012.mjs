#!/usr/bin/env node
// Live CDP check for #2012 (Checklist panel, T021). A fake omp replays `refract_checklist` host_tool_call frames (the agent),
// the developer side is real CDP input (mouse and keyboard) on the panel. Covers: auto-open without focus theft, status
// icon plus word, aria-current on `next`, real-click tick, requiresValue gate, in-place agent update, a background Session's
// `opened` checklist not switching the visible pane, the tool-unavailable notice (fake omp refuses `set_host_tools`), keyboard ticking.
// Usage: REFRACT_2012_ROOT=<task folder> REFRACT_2012_EXE=<private exe copy> node scripts/verify-tauri-2012.mjs

import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, sha256OfFile } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, getAccessibleName } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName, waitForSessionStatus } from './verify-tauri-560-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT = process.env.REFRACT_2012_ROOT;
const EXE = process.env.REFRACT_2012_EXE;
if (!ROOT || !EXE || !path.isAbsolute(ROOT) || !path.isAbsolute(EXE)) throw new Error('set absolute REFRACT_2012_ROOT and REFRACT_2012_EXE');
const EVIDENCE = path.join(ROOT, 'evidence');
for (const d of ['data', 'import', 'shim', 'launcher', 'repo', 'fake']) mkdirSync(path.join(ROOT, d), { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });

const transcript = [];
const failures = [];
const log = (step, value) => transcript.push({ step, value });
const check = (ok, what, detail) => {
  log(`${ok ? 'PASS' : 'FAIL'}: ${what}`, detail);
  if (!ok) failures.push(`${what}: ${JSON.stringify(detail)}`);
};

const key = (cdp, type, k, code, vk, text) => cdp.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) });
const press = async (cdp, k, code, vk, text) => {
  await key(cdp, text ? 'keyDown' : 'rawKeyDown', k, code, vk, text);
  await key(cdp, 'keyUp', k, code, vk);
};

async function main() {
  const dataDir = path.join(ROOT, 'data');
  const recordFile = path.join(ROOT, 'fake', 'host-tools.jsonl');
  const callsFile = path.join(ROOT, 'fake', 'host-calls.jsonl');
  const refuseFile = path.join(ROOT, 'fake', 'refuse');
  writeFileSync(recordFile, '');
  writeFileSync(callsFile, '');
  const repoDir = makeScratchRepo(path.join(ROOT, 'repo'), 'verify-2012');
  const repoName = path.basename(repoDir);
  const shimDir = path.join(ROOT, 'shim');
  buildOmpShim(shimDir);
  const launcherExe = buildLauncher(path.join(ROOT, 'launcher'));
  const env = {
    REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
    REFRACT_FAKE_OMP_NODE: process.execPath,
    REFRACT_FAKE_OMP_SCENARIO: 'session-tools-1858',
    REFRACT_FAKE_OMP_DEBUG_LOG: path.join(ROOT, 'fake', 'invocations.log'),
    REFRACT_FAKE_OMP_HOST_TOOL_RECORD: recordFile,
    REFRACT_FAKE_OMP_HOST_TOOL_CALLS: callsFile,
    REFRACT_FAKE_OMP_HOST_TOOL_REFUSE_FILE: refuseFile
  };
  log('provenance', { gitHead: gitHead(REPO_ROOT), exe: EXE, exeSha256: sha256OfFile(EXE), dataDir });

  const records = () => readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let n = 0;
  const call = async (args, pid) => {
    const id = `hc-${++n}`;
    appendFileSync(callsFile, `${JSON.stringify({ type: 'host_tool_call', id, toolCallId: `t-${n}`, toolName: 'refract_checklist', arguments: args, __pid: pid })}\n`);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const hit = records().find((r) => r.frame.type === 'host_tool_result' && r.frame.id === id);
      if (hit) {
        const out = { id, isError: hit.frame.isError === true, body: JSON.parse(hit.frame.result.content[0].text) };
        log(`tool ${args.action}`, { args, result: out });
        return out;
      }
      await sleep(150);
    }
    throw new Error(`no host_tool_result for ${id} within 20s`);
  };
  const pidOfNewestSession = async (known) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const hit = records().find((r) => r.frame.type === 'set_host_tools' && !known.includes(r.pid));
      if (hit) return hit.pid;
      await sleep(200);
    }
    throw new Error('omp never registered host tools');
  };

  let app;
  try {
    const port = await getFreePort();
    const launched = await launchBuiltExeWithEnv(launcherExe, EXE, { port, dataDir, importSourceDir: path.join(ROOT, 'import'), pathPrepend: shimDir, logFile: path.join(ROOT, 'app.log'), extraEnv: env });
    app = launched;
    const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`CDP target on port ${port} is not owned by pid ${launched.targetPid}`);
    await cdp.waitFor(`!!window.refract?.checklist`, { timeoutMs: 30_000, label: 'bridge mounted' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    const sessionA = await latestSessionIdAndName(cdp, repoName, []);
    await waitForSessionStatus(cdp, sessionA.id, 'idle');
    const pidA = await pidOfNewestSession([]);
    const listA = await cdp.evaluate(`window.refract.sessions.list().then((r) => r.value.map((s) => s.id))`);
    check(listA.length === 1 && listA[0] === sessionA.id, 'scratch data dir holds only the Session this run created', listA);

    // Spy on the developer's mutate calls (the page's own bridge object) to prove "no checklist.mutate sent".
    await cdp.evaluate(`(() => { const api = window.refract.checklist; window.__mutateCalls = []; const orig = api.mutate.bind(api); api.mutate = (...a) => { window.__mutateCalls.push(a); return orig(...a); }; return window.refract.checklist.mutate === api.mutate; })()`);

    const rowSel = (id) => `document.querySelector('[data-checklist-item=${JSON.stringify(id)}]')`;
    const boxSel = (id) => `${rowSel(id)}?.querySelector('[role="checkbox"]')`;
    const rowState = (id) => cdp.evaluate(`(() => { const r = ${rowSel(id)}; if (!r) return null; const b = r.querySelector('[role="checkbox"]'); return { text: r.querySelector('[id$="-text"]')?.textContent, checked: b?.getAttribute('aria-checked'), disabled: b?.getAttribute('aria-disabled'), busy: b?.getAttribute('aria-busy'), current: r.getAttribute('aria-current'), full: r.innerText }; })()`);
    const live = async (sid) => (await cdp.evaluate(`window.refract.checklist.get(${JSON.stringify(sid)})`)).value;

    // 1. Auto-open without taking focus.
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);
    const focusBefore = await cdp.evaluate(`(() => { const e = document.activeElement; return { tag: e?.tagName, label: e?.getAttribute('aria-label') }; })()`);
    check(focusBefore.label === 'Message', 'composer focused before the agent creates the checklist', focusBefore);
    const panelOpenBefore = await cdp.evaluate(`!!document.querySelector('section[aria-label="Checklist"]')`);
    const created = await call(
      {
        action: 'create',
        requestId: 'live-create-1',
        title: 'Release plan',
        items: [
          { text: 'Write the migration' },
          { text: 'Review the diff' },
          { text: 'Approve the rollout', owner: 'human' },
          { text: 'Paste the deploy token', owner: 'human', requiresValue: true },
          { text: 'Run the smoke test', owner: 'either' },
          { text: 'Tag the release', owner: 'either' }
        ]
      },
      pidA
    );
    const ids = created.body.addedIds ?? created.body.createdIds ?? created.body.ids;
    check(!created.isError && Array.isArray(ids) && ids.length === 6, 'agent create returned 6 ids', created.body);
    const [i1, i2, i3, i4, i5, i6] = ids;
    await cdp.waitFor(`!!document.querySelector('section[aria-label="Checklist"]') && !!${rowSel(i1)}`, { timeoutMs: 15_000, label: 'panel auto-opened with rows' });
    const focusAfter = await cdp.evaluate(`(() => { const e = document.activeElement; return { tag: e?.tagName, label: e?.getAttribute('aria-label') }; })()`);
    check(panelOpenBefore === false && focusAfter.label === 'Message', 'panel auto-opened in the right pane and the composer kept document.activeElement', { panelOpenBefore, focusAfter });
    // Statuses: i1 complete, i2 next, i5 in_progress, i6 blocked; i3/i4 stay upcoming.
    const seed = await call(
      {
        action: 'update',
        baseRev: created.body.seenRev,
        ops: [
          { op: 'setStatus', id: i1, status: 'complete' },
          { op: 'setStatus', id: i2, status: 'next' },
          { op: 'setStatus', id: i5, status: 'in_progress' },
          { op: 'setStatus', id: i6, status: 'blocked' }
        ]
      },
      pidA
    );
    check(!seed.isError, 'agent set statuses complete/next/in_progress/blocked', seed.body);
    await cdp.waitFor(`${rowSel(i2)}?.getAttribute('aria-current') === 'step'`, { timeoutMs: 15_000, label: 'statuses rendered' });
    await cdp.screenshot(path.join(EVIDENCE, '01-panel-auto-opened.png'));

    // 2. Status word per row, aria-current on `next`, tick labels resolve to the item text.
    const rows = {};
    for (const [name, id] of Object.entries({ i1, i2, i3, i4, i5, i6 })) rows[name] = await rowState(id);
    const textOf = { i1: 'Write the migration', i2: 'Review the diff', i3: 'Approve the rollout', i4: 'Paste the deploy token', i5: 'Run the smoke test', i6: 'Tag the release' };
    const names = {};
    for (const [name, id] of Object.entries({ i1, i2, i3, i4, i5, i6 })) names[name] = await getAccessibleName(cdp, boxSel(id));
    check(Object.entries(textOf).every(([k, t]) => names[k] === t), 'each tick resolves to its item text as accessible name', names);
    const words = await cdp.evaluate(`(() => Object.fromEntries(Object.entries(${JSON.stringify({ i1, i2, i3, i4, i5, i6 })}).map(([k, id]) => { const r = document.querySelector('[data-checklist-item="' + id + '"]'); const w = r.querySelector('div > span.inline-flex'); return [k, { text: w?.textContent.trim(), hasIcon: !!w?.querySelector('svg') }]; })))()`);
    // Upcoming rows deliberately render no status span (the unticked box is the state; gate fix 6b3d2f86); the other four carry icon plus word.
    const marked = ['i1', 'i2', 'i5', 'i6'];
    check(
      marked.every((k) => words[k].hasIcon && words[k].text) && new Set(marked.map((k) => words[k].text.split('Completed by')[0])).size === 4 && ['i3', 'i4'].every((k) => !words[k].hasIcon && !words[k].text),
      'complete/next/in-progress/blocked each show an icon plus a distinct word; upcoming rows show only the unticked box',
      words
    );
    const currentRows = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-checklist-item][aria-current="step"]')).map((r) => r.getAttribute('data-checklist-item'))`);
    check(currentRows.length === 1 && currentRows[0] === i2, 'aria-current="step" is only on the next row', currentRows);

    // 3. Real mouse tick of an upcoming human item.
    const revBefore = (await live(sessionA.id)).checklist.rev;
    await cdp.evaluate(`window.__busy = []; new MutationObserver((ms) => ms.forEach((m) => window.__busy.push(m.target.getAttribute('aria-busy') + '/' + m.target.getAttribute('aria-checked')))).observe(${rowSel(i3)}, { attributes: true, subtree: true, attributeFilter: ['aria-busy', 'aria-checked'] }); window.__mutateCalls.length = 0; 1`);
    await cdp.click(boxSel(i3));
    await cdp.waitFor(`${boxSel(i3)}?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 15_000, label: 'tick complete' });
    const after3 = await rowState(i3);
    const liveAfter3 = (await live(sessionA.id)).checklist;
    const item3 = liveAfter3.items.find((i) => i.id === i3);
    const busy = await cdp.evaluate(`window.__busy`);
    check(item3.status === 'complete' && item3.completedBy === 'developer' && liveAfter3.rev > revBefore, 'store: tick completed by developer and rev rose', { status: item3.status, completedBy: item3.completedBy, revBefore, rev: liveAfter3.rev });
    check(/Completed by you/.test(after3.full), 'row shows "Completed by you"', after3.full);
    const calls3 = await cdp.evaluate(`window.__mutateCalls.length`);
    check(calls3 === 1, 'the spy saw exactly one checklist.mutate for the real click (so the zero in scenario 4 is meaningful)', calls3);
    check(busy.some((b) => b.startsWith('true/')), 'row went pending (aria-busy) then complete', busy);
    await cdp.screenshot(path.join(EVIDENCE, '03-after-real-click-tick.png'));

    // 4. requiresValue with no value: inert.
    const before4 = await live(sessionA.id);
    await cdp.evaluate(`window.__mutateCalls.length = 0; 1`);
    const r4 = await rowState(i4);
    await cdp.click(boxSel(i4));
    await sleep(800);
    const after4 = await rowState(i4);
    const live4 = (await live(sessionA.id)).checklist;
    const calls4 = await cdp.evaluate(`window.__mutateCalls.length`);
    check(r4.disabled === 'true' && /needs a value/.test(r4.full) && after4.checked === 'false' && calls4 === 0 && live4.rev === before4.checklist.rev, 'requiresValue tick without a value is aria-disabled with reason text and sends no mutate', { r4: { disabled: r4.disabled, full: r4.full }, checked: after4.checked, calls4, rev: live4.rev });

    // 5. Agent update in place: values and completions persist, DOM nodes survive.
    await cdp.evaluate(`window.__keep = ${rowSel(i3)}; 1`);
    const got = await call({ action: 'get', full: true }, pidA);
    const upd = await call(
      {
        action: 'update',
        baseRev: got.body.seenRev,
        requestId: 'live-update-5',
        ops: [{ op: 'setValue', id: i4, value: 'tok-123' }, { op: 'setStatus', id: i2, status: 'complete' }, { op: 'setStatus', id: i5, status: 'next' }, { op: 'add', item: { text: 'Announce it', owner: 'agent' } }]
      },
      pidA
    );
    check(!upd.isError, 'agent update accepted', upd.body);
    await cdp.waitFor(`!!${rowSel(i4)}?.innerText.includes('tok-123')`, { timeoutMs: 15_000, label: 'value rendered' });
    const [s2, s3, s4, s5] = [await rowState(i2), await rowState(i3), await rowState(i4), await rowState(i5)];
    const same = await cdp.evaluate(`window.__keep === ${rowSel(i3)}`);
    const rowCount = await cdp.evaluate(`document.querySelectorAll('[data-checklist-item]').length`);
    check(s2.checked === 'true' && s3.checked === 'true' && /Completed by you/.test(s3.full) && s4.disabled !== 'true' && s5.current === 'step' && rowCount === 7 && same, 'agent update applied in place: i2 complete, human tick kept, value shown and tick enabled, new next row, 7 rows, row node reused', { s2: s2.checked, s3: s3.checked, s4: { disabled: s4.disabled }, s5: s5.current, rowCount, same });

    // 8. Keyboard (run while this checklist is still in front): Tab reaches the ticks, Space ticks, ring visible.
    // The composer indents on Tab by design (useComposerIndent), so start from the tab stop just before the first tick; the real Tab keys do the rest.
    const stopBefore = await cdp.evaluate(`(() => { const sel = 'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'; const all = Array.from(document.querySelectorAll(sel)).filter((e) => e.getClientRects().length); const i = all.findIndex((e) => e.closest('[data-checklist-item]')); if (i < 1) return null; all[i - 1].focus(); return all[i - 1].tagName + '/' + (all[i - 1].getAttribute('aria-label') ?? ''); })()`);
    log('tab start (tab stop before first tick)', stopBefore);
    let reached = null;
    const trail = [];
    for (let t = 0; t < 60 && !reached; t++) {
      await press(cdp, 'Tab', 'Tab', 9);
      trail.push(await cdp.evaluate(`(() => { const e = document.activeElement; return e?.tagName + '/' + (e?.getAttribute('role') ?? '') + '/' + (e?.getAttribute('aria-label') ?? e?.id ?? ''); })()`));
      reached = await cdp.evaluate(`(() => { const e = document.activeElement; const row = e?.closest?.('[data-checklist-item]'); return e?.getAttribute('role') === 'checkbox' && row ? row.getAttribute('data-checklist-item') : null; })()`);
    }
    check(reached !== null, 'Tab from the composer reaches a checklist tick', trail);
    // Walk to the "Tag the release" tick (i6, blocked, either-owned: tickable).
    for (let t = 0; t < 12 && reached !== i6; t++) {
      await press(cdp, 'Tab', 'Tab', 9);
      reached = await cdp.evaluate(`document.activeElement?.closest?.('[data-checklist-item]')?.getAttribute('data-checklist-item') ?? null`);
    }
    check(reached === i6, 'Tab walks the ticks in order to the "Tag the release" tick', reached);
    const ring = await cdp.evaluate(`(() => { const s = getComputedStyle(document.activeElement); return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, boxShadow: s.boxShadow, focusVisible: document.activeElement.matches(':focus-visible') }; })()`);
    // Computed box-shadow is never the string 'none' in Tailwind v4 (transparent placeholders), so look for a painted layer.
    const paintedShadow = ring.boxShadow.split(/,\s*(?=rgb|oklch|color|lab|hsl)/).some((layer) => !layer.startsWith('rgba(0, 0, 0, 0)') && layer !== 'none');
    check(ring.focusVisible && (paintedShadow || (ring.outlineStyle !== 'none' && ring.outlineWidth !== '0px')), 'keyboard focus ring is visible on the tick', ring);
    await cdp.screenshot(path.join(EVIDENCE, '08-keyboard-focus-ring.png'));
    await press(cdp, ' ', 'Space', 32, ' ');
    await cdp.waitFor(`${boxSel(i6)}?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 15_000, label: 'Space ticked' });
    const spaceRow = await rowState(i6);
    check(spaceRow.checked === 'true', 'Space ticked the focused item (aria-checked is true)', spaceRow);
    const focusKept = await cdp.evaluate(`document.activeElement?.closest?.('[data-checklist-item]')?.getAttribute('data-checklist-item')`);
    check(focusKept === i6, 'focus stays on the ticked row after the result lands', focusKept);

    // 9. A replace on the front Session while focus is inside the panel moves focus to the Checklist section; focus elsewhere is not stolen.
    const sectionFocused = `document.activeElement === document.querySelector('section[aria-label="Checklist"]')`;
    const stopBeforeReplace = await cdp.evaluate(`!!document.activeElement?.closest?.('[data-checklist-item]')`);
    const replaced1 = await call({ action: 'create', requestId: 'live-replace-1', title: 'Replaced while focused', replace: true, items: [{ text: 'Fresh item' }] }, pidA);
    check(!replaced1.isError && replaced1.body.error === undefined, 'agent replace on the front Session accepted (focus inside a tick)', replaced1.body);
    await cdp.waitFor(`document.querySelector('section[aria-label="Checklist"]')?.innerText.includes('Replaced while focused')`, { timeoutMs: 15_000, label: 'replacement rendered' });
    const focusInside = await cdp.evaluate(sectionFocused);
    check(stopBeforeReplace && focusInside, 'focus was on a tick; after the replace document.activeElement is the Checklist section', { stopBeforeReplace, focusInside });
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);
    const replaced2 = await call({ action: 'create', requestId: 'live-replace-2', title: 'Replaced while typing', replace: true, items: [{ text: 'Another item' }] }, pidA);
    check(!replaced2.isError && replaced2.body.error === undefined, 'agent replace on the front Session accepted (focus in the composer)', replaced2.body);
    await cdp.waitFor(`document.querySelector('section[aria-label="Checklist"]')?.innerText.includes('Replaced while typing')`, { timeoutMs: 15_000, label: 'second replacement rendered' });
    const stolen = await cdp.evaluate(`({ section: ${sectionFocused}, label: document.activeElement?.getAttribute('aria-label') })`);
    check(!stolen.section && stolen.label === 'Message', 'a replace with focus in the composer does not steal focus', stolen);

    // 7 + 6. A second Session whose registration is refused (notice), then a background Session's checklist opened:true.
    writeFileSync(refuseFile, '1');
    await createSessionViaQuickCreate(cdp, repoName);
    const sessionB = await latestSessionIdAndName(cdp, repoName, [sessionA.id]);
    await waitForSessionStatus(cdp, sessionB.id, 'idle');
    await pidOfNewestSession([pidA]);
    const frontIs = (id) => `document.querySelector('[data-session-open=${JSON.stringify(id)}]')?.getAttribute('aria-current') === 'true'`;
    await cdp.waitFor(frontIs(sessionB.id), { timeoutMs: 15_000, label: 'Session B front' });
    await cdp.waitFor(`document.querySelector('section[aria-label="Checklist"]')?.innerText.includes("can't use checklists")`, { timeoutMs: 15_000, label: 'tool-unavailable notice' });
    const unavailable = await live(sessionB.id);
    check(unavailable.toolUnavailable === true, 'the fake omp refused set_host_tools: Session B reports toolUnavailable and the panel shows the notice', { toolUnavailable: unavailable.toolUnavailable });
    await cdp.screenshot(path.join(EVIDENCE, '07-tool-unavailable.png'));
    const created6 = await call({ action: 'create', requestId: 'live-create-bg', title: 'Background plan', items: [{ text: 'Do it quietly' }], replace: true }, pidA);
    check(!created6.isError && created6.body.error === undefined && created6.body.checklistId !== undefined, 'agent in front-less Session A created a second checklist (archives or replaces)', created6.body);
    await sleep(1200);
    const frontAfter = await cdp.evaluate(`({ b: ${frontIs(sessionB.id)}, a: ${frontIs(sessionA.id)}, text: document.querySelector('section[aria-label="Checklist"]')?.innerText ?? null })`);
    check(frontAfter.b && !frontAfter.a && frontAfter.text?.includes("can't use checklists") && !frontAfter.text.includes('Background plan'), 'a background Session checklist with opened:true did not switch the visible pane', frontAfter);
    await cdp.screenshot(path.join(EVIDENCE, '06-background-session-no-switch.png'));
    // The switch proves the screenshot discriminates: Session A, once front, hydrates the checklist the agent made while it was behind.
    await cdp.click(`document.querySelector('[data-session-open=${JSON.stringify(sessionA.id)}]')`);
    await cdp.waitFor(frontIs(sessionA.id), { timeoutMs: 15_000, label: 'Session A front again' });
    await cdp.waitFor(`document.querySelector('section[aria-label="Checklist"]')?.innerText.includes('Background plan')`, { timeoutMs: 15_000, label: 'background checklist hydrated' });
    const switched = await cdp.evaluate(`document.querySelector('section[aria-label="Checklist"]')?.innerText ?? null`);
    check(switched?.includes('Background plan') && !switched.includes("can't use checklists"), 'switching to Session A shows the checklist created while it was in the background', switched);
    await cdp.screenshot(path.join(EVIDENCE, '06b-background-session-hydrated.png'));
    cdp.close();
  } catch (err) {
    failures.push(`exception: ${err?.stack ?? err}`);
    log('exception', String(err?.stack ?? err));
  } finally {
    if (app?.child) await stopLauncher(app.child).catch(() => {});
    const verdict = failures.length ? 'FAILED' : 'PASSED';
    writeFileSync(path.join(EVIDENCE, 'transcript.json'), JSON.stringify({ verdict, failures, transcript }, null, 2));
    console.log(transcript.map((t) => `${t.step}${t.value === null ? '' : ` :: ${JSON.stringify(t.value)}`}`).join('\n'));
    console.log(`\nverify-2012: ${verdict}`);
    if (app?.targetPid) console.log(`launched pid: ${app.targetPid}`);
    process.exitCode = failures.length ? 1 : 0;
  }
}

main();
