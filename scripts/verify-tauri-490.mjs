#!/usr/bin/env node
// Live CDP check for #490 (global Agents panel); tape scripts/fixtures/omp-frames/agents-panel-490.jsonl.
// Two Sessions: gamma running, alpha finished. Scenarios a-e are named in each `scenario(...)` call below.
// Env: REFRACT_490_SCRATCH_DIR, REFRACT_490_SHOTS_DIR. Needs the shared CARGO_TARGET_DIR.

import { mkdtempSync, writeFileSync, existsSync, copyFileSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName } from './verify-tauri-560-helpers.mjs';
import { settleForScreenshot } from './verify-700-todo-pin-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRATCH = process.env.REFRACT_490_SCRATCH_DIR || 'C:/Users/shopwood/AppData/Local/Temp/scratch/live-490';
const SHOTS_DIR = process.env.REFRACT_490_SHOTS_DIR || path.join(SCRATCH, `shots-${Date.now()}`);
const RAIL = `document.querySelector('[data-rail-button="subagents"]')`;
const PILL = `Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('Open subagents panel ('))`;
const GROUPS = `Array.from(document.querySelectorAll('[data-agents-group]'))`;
const SEND = `document.querySelector('[aria-label="Send message"]')`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const findings = [];
  const failures = [];
  const dirs = {};
  const scenarios = [];
  let current = null;
  const scenario = (name) => {
    current = { name, ok: true };
    scenarios.push(current);
  };
  const check = (name, ok, detail) => {
    if (!ok && current) current.ok = false;
    findings.push(`${ok ? 'PASS' : 'FAIL'} [${current?.name}] ${name}: ${detail}`);
    if (!ok) failures.push(`#490: [${current?.name}] ${name}: ${detail}`);
  };
  let child, cdp, gitHeadSha = null;
  try {
    mkdirSync(SHOTS_DIR, { recursive: true });
    mkdirSync(SCRATCH, { recursive: true });
    const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    for (const n of ['shim', 'data', 'import', 'exe', 'launcher']) dirs[n] = mkdtempSync(path.join(SCRATCH, `${n}-`));
    dirs.repo = makeScratchRepo(mkdtempSync(path.join(SCRATCH, 'repo-')), 'verify-490');
    const injectFile = path.join(dirs.data, 'inject-frames.jsonl');
    const inject = (frame) => appendFileSync(injectFile, `${JSON.stringify(frame)}\n`);
    const shoot = async (name) => {
      await settleForScreenshot(cdp);
      await cdp.screenshot(path.join(SHOTS_DIR, name));
    };
    const panelState = () => cdp.evaluate(`(() => {
      const rail = ${RAIL};
      const groups = ${GROUPS};
      const heading = document.querySelector('[data-panel-heading]');
      return {
        railLabel: rail ? rail.getAttribute('aria-label') : null,
        railPressed: rail ? rail.getAttribute('aria-pressed') : null,
        headingText: heading ? heading.innerText : null,
        groups: groups.map((g) => ({ id: g.getAttribute('data-agents-group'), text: g.innerText.replace(/\\s+/g, ' ').trim() }))
      };
    })()`);

    const port = await getFreePort();
    buildOmpShim(dirs.shim);
    const launcherExe = buildLauncher(dirs.launcher);
    const built = buildAndCopyExeFresh(dirs.exe, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-490' });
    const launched = await launchBuiltExeWithEnv(launcherExe, built.dest, {
      port,
      dataDir: dirs.data,
      importSourceDir: dirs.import,
      pathPrepend: dirs.shim,
      logFile: path.join(dirs.exe, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'agents-panel-490',
        REFRACT_FAKE_OMP_HOST_TOOL_CALLS: injectFile,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(dirs.exe, 'fake-omp-invocations.log')
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 90_000, label: 'Readiness green' });
    const repoName = path.basename(dirs.repo);
    await addRepository(cdp, dirs.repo);

    // Two Sessions, each ran one turn: gamma running, alpha finished. Session 2 is the visible one; Session 1 is hidden.
    const runTurn = async (text) => {
      await cdp.typeIntoByLabel('Message', text);
      await cdp.clickByLabel('Send message');
      await cdp.waitFor(`document.body.innerText.includes('Turn one done')`, { timeoutMs: 30_000, label: 'turn settled' });
      await cdp.waitFor(`!!(${PILL})`, { timeoutMs: 30_000, label: 'readout pill mounted' });
    };
    await createSessionViaQuickCreate(cdp, repoName);
    const s1 = await latestSessionIdAndName(cdp, repoName, []);
    await runTurn('Run the agents (issue #490 live check), Session 1.');
    await createSessionViaQuickCreate(cdp, repoName);
    const s2 = await latestSessionIdAndName(cdp, repoName, [s1.id]);
    await runTurn('Run the agents (issue #490 live check), Session 2.');
    findings.push(`sessions: ${JSON.stringify({ s1, s2 })}`);
    await cdp.waitFor(`/2 running/.test((${RAIL}).getAttribute('aria-label'))`, { timeoutMs: 20_000, label: 'rail badge shows 2 running' });

    // (a) closed at start, badge shows the total.
    scenario('a: closed at start, rail badge shows the total');
    const a = await panelState();
    findings.push(`a: ${JSON.stringify(a)}`);
    check('rail button is not pressed', a.railPressed === 'false', String(a.railPressed));
    check('no Agents group is mounted', a.groups.length === 0 && a.headingText === null, JSON.stringify(a.groups));
    check('rail label carries the total running across both Sessions', /2 running/.test(a.railLabel ?? ''), String(a.railLabel));
    await shoot('490-a-closed-badge.png');

    // (b) open from the rail.
    scenario('b: rail opens one group per Session plus the finished fold');
    await cdp.click(RAIL);
    await cdp.waitFor(`${GROUPS}.length >= 2`, { timeoutMs: 15_000, label: 'two Agents groups' });
    await sleep(500);
    const b = await panelState();
    findings.push(`b: ${JSON.stringify(b)}`);
    check('rail button is pressed', b.railPressed === 'true', String(b.railPressed));
    const ids = b.groups.map((g) => g.id).sort();
    check('one group per Session, the hidden one included', JSON.stringify(ids) === JSON.stringify([s1.id, s2.id].sort()), JSON.stringify(ids));
    const hidden = await cdp.evaluate(`!document.querySelector('[data-session-open="${s1.id}"][aria-current="true"]') && !!document.querySelector('[data-session-open="${s2.id}"][aria-current="true"]')`);
    check('Session 1 is the hidden Session (Session 2 is the open one)', hidden === true, String(hidden));
    check('every group shows "1 running" and the "1 finished" fold', b.groups.length === 2 && b.groups.every((g) => /1 running/.test(g.text) && /1 finished/.test(g.text) && /gamma/i.test(g.text)), JSON.stringify(b.groups));
    check('the status line sums both Sessions', /2 agents running/.test(b.headingText ?? ''), String(b.headingText));
    await shoot('490-b-panel-open-two-groups.png');

    // (c) a Session's readout pill opens the panel scrolled to that group. Close the panel, focus Session 1, click its pill.
    scenario("c: a Session's pill opens the panel scrolled to its group");
    await cdp.click(RAIL);
    await cdp.waitFor(`${GROUPS}.length === 0 && (${RAIL}).getAttribute('aria-pressed') === 'false'`, { timeoutMs: 15_000, label: 'panel closed' });
    await cdp.click(`document.querySelector('[data-session-open="${s1.id}"]')`);
    await cdp.waitFor(`!!document.querySelector('[data-session-open="${s1.id}"][aria-current="true"]') && !!(${PILL})`, { timeoutMs: 20_000, label: 'Session 1 focused with its pill' });
    await sleep(500);
    await cdp.click(PILL);
    await cdp.waitFor(`${GROUPS}.length >= 2`, { timeoutMs: 15_000, label: 'panel open from the pill' });
    await sleep(800);
    const c = await cdp.evaluate(`(() => {
      const group = ${GROUPS}.find((g) => g.getAttribute('data-agents-group') === ${JSON.stringify(s1.id)});
      if (!group) return { found: false };
      const header = group.querySelector('h3') ?? group;
      let host = group.parentElement;
      while (host && host.scrollHeight <= host.clientHeight + 1 && host.parentElement) host = host.parentElement;
      const h = header.getBoundingClientRect();
      const hr = (group.closest('.overflow-y-auto') ?? host).getBoundingClientRect();
      return { found: true, headerTop: h.top, headerBottom: h.bottom, hostTop: hr.top, hostBottom: hr.bottom, inView: h.top >= hr.top - 1 && h.bottom <= hr.bottom + 1 };
    })()`);
    findings.push(`c: ${JSON.stringify(c)}`);
    check('Session 1 group exists and its header is inside the tree viewport', c.found && c.inView, JSON.stringify(c));
    const cState = await panelState();
    check('rail button is pressed after the pill opened the panel', cState.railPressed === 'true', String(cState.railPressed));
    await shoot('490-c-pill-opened-session-1-group.png');

    // (d) switch the focused Session, then start a new Conversation: the panel stays open.
    scenario('d: switching Session and starting a new Conversation leave the panel open');
    await cdp.click(`document.querySelector('[data-session-open="${s2.id}"]')`);
    await cdp.waitFor(`!!document.querySelector('[data-session-open="${s2.id}"][aria-current="true"]')`, { timeoutMs: 20_000, label: 'Session 2 focused' });
    await sleep(800);
    const d1 = await panelState();
    findings.push(`d (after switch): ${JSON.stringify(d1)}`);
    check('panel still open after the Session switch', d1.railPressed === 'true' && d1.groups.length >= 1, JSON.stringify(d1));
    await shoot('490-d1-after-session-switch.png');
    const NEW_CONVERSATION = `Array.from(document.querySelectorAll('button[aria-label="New conversation"]')).find((el) => el.getAttribute('aria-disabled') !== 'true') ?? null`;
    const newBtn = await cdp.evaluate(`(() => { const el = ${NEW_CONVERSATION}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, disabled: el.getAttribute('aria-disabled'), top: (document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el || el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))) }; })()`);
    findings.push(`d (new conversation button before click): ${JSON.stringify(newBtn)}`);
    await cdp.click(NEW_CONVERSATION);
    const reset = await cdp.waitFor(`!document.body.innerText.includes('Turn one done')`, { timeoutMs: 30_000, label: 'Conversation reset (old transcript gone)' }).catch(() => false);
    check('the new Conversation cleared the old transcript', reset === true, `body still shows "Turn one done": ${reset !== true}`);
    await sleep(1000);
    const d2 = await panelState();
    findings.push(`d (after new Conversation): ${JSON.stringify(d2)}`);
    check('panel still open after a new Conversation', d2.railPressed === 'true' && d2.headingText !== null, JSON.stringify(d2));
    const d2Ids = d2.groups.map((g) => g.id);
    check("the reset Session's group is gone and the other Session's group stays", !d2Ids.includes(s2.id) && d2Ids.includes(s1.id), JSON.stringify(d2Ids));
    await shoot('490-d2-after-new-conversation.png');

    // (e) every agent finishes: the panel stays open.
    scenario('e: the panel stays open when all agents finish');
    inject({ type: 'subagent_lifecycle', payload: { parentToolCallId: 'stage-two', index: 0, status: 'completed' } });
    await cdp.waitFor(`!/running/.test((${RAIL}).getAttribute('aria-label'))`, { timeoutMs: 20_000, label: 'rail badge cleared' });
    await sleep(1000);
    const e = await panelState();
    findings.push(`e: ${JSON.stringify(e)}`);
    check('no agent is running any more', !/running/.test(e.railLabel ?? '') && !/\d+ agents? running/.test(e.headingText ?? ''), `${e.railLabel} / ${e.headingText}`);
    check('panel stays open', e.railPressed === 'true' && e.headingText !== null, JSON.stringify({ pressed: e.railPressed, heading: e.headingText }));
    await shoot('490-e-all-finished-panel-open.png');

    const passed = scenarios.filter((s) => s.ok).length;
    findings.push(`scenarios: ${passed}/${scenarios.length}`);
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, shotsDir: SHOTS_DIR, scenarios, findings, failures, exitCode: failures.length ? 1 : 0 }, null, 2));
    console.log(JSON.stringify({ scenarios, findings, failures, shotsDir: SHOTS_DIR }, null, 2));
    process.exitCode = failures.length ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, scenarios, findings, failures, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
      if (cdp) await cdp.screenshot(path.join(SHOTS_DIR, '490-error.png')).catch(() => {});
    } catch {}
    console.error('verify-490: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    try {
      for (const f of ['app.log', 'fake-omp-invocations.log']) {
        if (dirs.exe && existsSync(path.join(dirs.exe, f))) copyFileSync(path.join(dirs.exe, f), path.join(SHOTS_DIR, f));
      }
    } catch {}
    for (const d of Object.values(dirs)) await safeRmSync(d);
  }
}

main();
