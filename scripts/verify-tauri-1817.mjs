#!/usr/bin/env node
// Live CDP check for #1817 (Skill invoked row and summary tooltip) against a scratch debug exe.
// Usage: CARGO_TARGET_DIR=<shared target dir> SHOTS_DIR=<evidence dir> node scripts/verify-tauri-1817.mjs
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, makeScratchRepo } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { buildFakeClis } from './verify-1331-fixtures.mjs';
import { addRepository, createSessionViaQuickCreate, hoverRow, pressKey } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1817';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.SHOTS_DIR || mkdtempSync(path.join(tmpdir(), 'refract-1817-shots-'));
const q = JSON.stringify;
const steps = [];
const record = (name, pass, detail = '') => {
  steps.push({ name, pass: !!pass, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  console.log(`${LOG}: ${pass ? 'PASS' : 'FAIL'} ${name}${pass || !detail ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};

// Both skill rows from src-tauri/tests/fixtures/skill-prompt.json: `handoff` arrives in history (replay path,
// front matter description), `check-build` arrives as a live frame after the send (no front matter, body fallback).
const rowFor = (name) => `Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Skill invoked') && b.textContent.includes(${q(name)}))`;
const rawLeak = `document.body.innerText.includes('[IMPORTANT: User invoked') || document.body.innerText.includes('[IMPORTANT: The user has invoked')`;

async function main() {
  const head = gitHead(REPO_ROOT);
  console.log(`${LOG}: git HEAD ${head}`);
  mkdirSync(SHOTS_DIR, { recursive: true });
  const mk = (n) => mkdtempSync(path.join(tmpdir(), `refract-1817-${n}-`));
  const dataDir = mk('data'), sessionsDir = mk('sessions'), importDir = mk('import'), exeDir = mk('exe'), launcherDir = mk('launcher'), shimDir = mk('shim'), agentDir = mk('agent'), repoDir = mk('repo');
  const dirs = [dataDir, sessionsDir, importDir, exeDir, launcherDir, shimDir, agentDir, repoDir];
  let child, cdp;
  const shot = async (name) => { const f = path.join(SHOTS_DIR, `${name}.png`); await cdp.screenshot(f); console.log(`${LOG}: shot ${f}`); };
  const tooltipText = () => cdp.evaluate(`Array.from(document.querySelectorAll('[role="tooltip"]')).map((t) => t.textContent.trim()).join(' || ')`);
  const checkRow = async (name, wantDesc, tag) => {
    await cdp.waitFor(`!!${rowFor(name)}`, { timeoutMs: 30_000, label: `Skill invoked row ${name}` });
    record(`${tag}: "Skill invoked" row for ${name} is shown`, true);
    record(`${tag}: raw injected prompt text is not shown`, !(await cdp.evaluate(rawLeak)));
    const name_ = await cdp.evaluate(`(() => { const b = ${rowFor(name)}; return b.getAttribute('aria-label') || b.textContent.trim(); })()`);
    record(`${tag}: accessible name has "Skill invoked" and ${name}`, name_.includes('Skill invoked') && name_.includes(name), name_);
    await hoverRow(cdp, `${rowFor(name)}?.firstElementChild ?? ${rowFor(name)}`);
    await cdp.waitFor(`!!document.querySelector('[role="tooltip"]')`, { timeoutMs: 8_000, label: 'hover tooltip' }).catch(() => null);
    await sleep(800);
    const hover = await tooltipText();
    record(`${tag}: hover tooltip shows the description`, hover.includes(wantDesc), hover);
    await shot(`${tag}-${name}-hover-tooltip`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await sleep(600);
    await pressKey(cdp, 16, 'Shift', 'ShiftLeft');
    await cdp.evaluate(`document.activeElement?.blur?.(); ${rowFor(name)}.focus()`);
    await sleep(500);
    const focused = await tooltipText();
    record(`${tag}: keyboard focus tooltip shows the description`, focused.includes(wantDesc), focused);
    await shot(`${tag}-${name}-focus-tooltip`);
    await cdp.click(rowFor(name));
    await sleep(500);
    const expanded = await cdp.evaluate(`document.body.innerText.includes('Resolve relative paths in this skill') || document.body.innerText.includes('Produce a tight handoff note')`);
    record(`${tag}: explicit expand reveals the body (text reachable without the tooltip)`, expanded);
    await shot(`${tag}-${name}-expanded`);
    await cdp.click(rowFor(name));
  };
  try {
    buildFakeClis(shimDir);
    makeScratchRepo(repoDir, 'v1817');
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const convFile = path.join(sessionsDir, 'conversation.jsonl');
    writeFileSync(convFile, '');
    const launch = async (scenario) => {
      const port = await getFreePort();
      const l = await launchBuiltExe(launcherExe, exeInfo.dest, {
        port, dataDir, pathPrepend: shimDir, logFile: path.join(exeDir, 'app.log'),
        extraEnv: { REFRACT_IMPORT_SOURCE_DIR: importDir, REFRACT_OMP_SESSIONS_DIR: sessionsDir, PI_CODING_AGENT_DIR: agentDir, REFRACT_FAKE_OMP_SCENARIO: scenario, REFRACT_FAKE_OMP_CONVERSATION_FILE: convFile }
      });
      child = l.child;
      cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
      if (!isTargetOwningPort(port, l.targetPid)) throw new Error(`${LOG}: CDP target is not owned by the launched process`);
      await cdp.evaluate(`window.refract.theme.set('dark')`);
    };
    await launch('1817-skill-prompt');
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 90_000, label: 'readiness green' });
    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, path.basename(repoDir));
    await cdp.waitFor(`window.refract.sessions.list().then((r) => r.ok && r.value.some((s) => s.sessionDir))`, { timeoutMs: 40_000, label: 'session has sessionDir' });

    // History (replay) path: the handoff row comes from get_messages_page, with a front-matter description.
    await checkRow('handoff', 'Write a short note that lets the next session resume', 'replay');
    // Live path: send /skill:check-build, the tape emits the custom message_end.
    await cdp.typeIntoByLabel('Message', '/skill:check-build monitor build 9681');
    await cdp.clickByLabel('Send message');
    await checkRow('check-build', 'Fetch a single Azure DevOps build by id', 'live');
    await shot('live-both-rows');

    // Reopen: restart on the same data dir, reopen the Session; the history path rebuilds the row.
    await stopLauncher(child);
    child = undefined;
    cdp.close?.();
    await launch('1817-skill-prompt-reopen');
    await cdp.waitFor(`!!document.querySelector('[data-session-open]')`, { timeoutMs: 60_000, label: 'session row' });
    await cdp.click(`document.querySelector('[data-session-open]')`);
    await cdp.clickByText('Start agent');
    await checkRow('handoff', 'Write a short note that lets the next session resume', 'reopen');
    await checkRow('check-build', 'Fetch a single Azure DevOps build by id', 'reopen');
  } catch (err) {
    record('script completed without error', false, String(err?.stack ?? err));
    if (cdp) await shot('error').catch(() => null);
  } finally {
    try { cdp?.close?.(); } catch {}
    if (child) await stopLauncher(child).catch(() => null);
    for (const d of dirs) {
      try { await safeRmSync(d, LOG); } catch (e) { console.log(`${LOG}: cleanup ${d}: ${e.message}`); }
    }
    const reportPath = path.join(SHOTS_DIR, 'report.json');
    writeFileSync(reportPath, JSON.stringify({ gitHead: head, steps }, null, 2));
    console.log(`${LOG}: report ${reportPath}`);
    process.exitCode = steps.every((s) => s.pass) ? 0 : 1;
  }
}

main();
