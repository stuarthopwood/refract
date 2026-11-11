#!/usr/bin/env node
// Live CDP check for issue #1812: slash commands before the agent starts.
// Three launches share one REFRACT_DATA_DIR (fake omp, recorded tapes slash-1812-*.jsonl):
//  1 new Session, no commands reported -> the persisted last-commands list stays empty
//  2 reopened (not started), cold cache: `/` reads "Starting agent…"; a non-native command starts the agent,
//    waits for the delayed commands report and runs once
//  3 reopened, warm cache: `/` lists cached commands; /new and /pause leave the agent stopped; /role planner
//    starts it and applies the role; a started Session shows the list and sends once.
// The fake omp's debug log (REFRACT_FAKE_OMP_DEBUG_LOG) is the proof of "started" and "sent once".

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WORK_DIR = process.env.REFRACT_1812_DIR || path.join(tmpdir(), 'r1812');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const CATALOG_FIXTURE = path.join(__dirname, 'fixtures', 'model-catalogs', 'chat-1069.json');
const COMPOSER = `document.querySelector('[aria-label="Message"]')`;

const findings = [];
const failures = [];
function check(label, ok, detail) {
  const text = `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`;
  (ok ? findings : failures).push(`${ok ? 'PASS' : 'FAIL'} ${text}`);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
}

const key = async (cdp, code, name) => {
  const text = name === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {};
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: code, key: name, code: name, modifiers: 0, ...text });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: code, key: name, code: name, modifiers: 0 });
};
const logOf = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const count = (text, re) => (text.match(re) ?? []).length;
const startedCount = (file) => count(logOf(file), /scenario=slash-1812-/g);
const promptsOf = (file) => logOf(file).split('\n').filter((l) => /RECV \{[^\n]*"type":"prompt"/.test(l));
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(250); } return fn(); };
const menu = (cdp) =>
  cdp.evaluate(`(() => ({ options: Array.from(document.querySelectorAll('[role="listbox"] [role="option"]')).map((o) => o.textContent.trim()), starting: Array.from(document.querySelectorAll('div,p,span')).some((e) => e.children.length === 0 && e.textContent.trim() === 'Starting agent…'), none: Array.from(document.querySelectorAll('div,p,span')).some((e) => e.children.length === 0 && e.textContent.trim() === 'No matching commands') }))()`);
async function typeInComposer(cdp, text) {
  await cdp.evaluate(`${COMPOSER}.focus()`);
  await cdp.send('Input.insertText', { text });
}
async function clearComposer(cdp) {
  await cdp.evaluate(`${COMPOSER}.focus()`);
  await key(cdp, 65, 'a').catch(() => {});
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA', modifiers: 2 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA', modifiers: 2 });
  await key(cdp, 8, 'Backspace');
}

async function main() {
  mkdirSync(WORK_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dirs = {};
  for (const n of ['shim', 'data', 'import', 'exe', 'launcher', 'repo', 'shots']) {
    dirs[n] = n === 'shots' ? path.join(WORK_DIR, 'shots') : path.join(WORK_DIR, `run-${stamp}`, n);
    mkdirSync(dirs[n], { recursive: true });
  }
  const repoDir = makeScratchRepo(dirs.repo, 'verify-1812');
  const configStorePath = path.join(dirs.data, 'fake-omp-config-store.json');
  writeFileSync(configStorePath, JSON.stringify({
    modelRoles: { default: 'github-copilot/claude-fable-5', smol: 'anthropic/claude-haiku-5.5', slow: 'anthropic/claude-opus-5.5', planner: 'anthropic/claude-haiku-5.5' },
    cycleOrder: ['smol', 'default', 'slow']
  }));
  const conversationFile = path.join(dirs.data, 'conversation.jsonl');
  writeFileSync(conversationFile, JSON.stringify({ type: 'model_change', model: 'github-copilot/claude-fable-5', role: 'default', resolvedModelIsFallback: false }) + '\n');
  const head = gitHead(REPO_ROOT);
  console.log(`verify-1812: git HEAD ${head}; shots ${dirs.shots}`);

  let child, cdp;
  const shots = [];
  const shot = async (name) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await sleep(250);
    const file = path.join(dirs.shots, name);
    await cdp.screenshot(file);
    shots.push(file);
  };
  try {
    buildOmpShim(dirs.shim);
    const launcherExe = buildLauncher(dirs.launcher);
    const built = buildAndCopyExeFresh(dirs.exe, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-1812' });
    const appData = path.join(dirs.data, 'app');
    const launch = async (n, scenario) => {
      const debugLog = path.join(dirs.shots, `fake-omp-${n}.log`);
      writeFileSync(debugLog, '');
      const port = await getFreePort();
      const launched = await launchBuiltExeWithEnv(launcherExe, built.dest, {
        port, dataDir: appData, importSourceDir: dirs.import, pathPrepend: dirs.shim, logFile: path.join(dirs.shots, `app-${n}.log`),
        extraEnv: {
          REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
          REFRACT_FAKE_OMP_NODE: process.execPath,
          REFRACT_FAKE_OMP_SCENARIO: scenario,
          REFRACT_FAKE_OMP_CONFIG_STORE: configStorePath,
          REFRACT_FAKE_OMP_MODEL_CATALOG: CATALOG_FIXTURE,
          REFRACT_FAKE_OMP_DEBUG_LOG: debugLog,
          REFRACT_FAKE_OMP_HOST_TOOL_RECORD: path.join(dirs.data, `host-tools-${n}.jsonl`),
          REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile
        }
      });
      child = launched.child;
      cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
      if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the process this run launched');
      return debugLog;
    };
    const stop = async () => {
      cdp.close();
      await stopLauncher(child).catch(() => {});
      child = undefined;
      cdp = undefined;
    };
    const reopen = async () => {
      await cdp.waitFor(`!!document.querySelector('[data-session-open]')`, { timeoutMs: 60_000, label: 'session row' });
      await cdp.click(`document.querySelector('[data-session-open]')`);
      await cdp.waitFor(`(() => { const el = ${COMPOSER}; return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'composer enabled' });
    };
    const sessionStatus = async () => (await cdp.evaluate(`window.refract.sessions.list()`)).value[0];

    // Launch 1: create the Session; it reports no commands, so no list is cached.
    await launch(1, 'slash-1812-new');
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'readiness' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'readiness green' });
    await addRepository(cdp, repoDir);
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'new session dialog' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`(() => { const el = ${COMPOSER}; return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'composer enabled' });
    await sleep(1500);
    await stop();

    // Launch 2: cold cache, not started.
    const log2 = await launch(2, 'slash-1812-cold');
    await reopen();
    const s2 = await sessionStatus();
    check('(a) reopened Session is not started', s2.status === 'stopped' && startedCount(log2) === 0, { status: s2.status, stopReason: s2.stopReason });
    await typeInComposer(cdp, '/');
    await sleep(500);
    const cold = await menu(cdp);
    check('(a) no cached list: menu reads "Starting agent…", not "No matching commands"', cold.starting && !cold.none, cold);
    await shot('a2-cold-starting-agent.png');
    await clearComposer(cdp);
    await typeInComposer(cdp, '/tools');
    await key(cdp, 13, 'Enter');
    await until(() => startedCount(log2) >= 1);
    check('(b) non-native command starts the agent', startedCount(log2) === 1, startedCount(log2));
    check('(b) nothing sent while the commands report is pending', promptsOf(log2).length === 0, promptsOf(log2).length);
    await shot('b1-starting-waiting-for-commands.png');
    await until(() => promptsOf(log2).length >= 1, 20000);
    await sleep(1500);
    const p2 = promptsOf(log2);
    check('(b) runs exactly once after the list arrives', p2.length === 1 && /\/tools/.test(p2[0]), p2.length);
    await shot('b2-ran-once.png');
    await stop();

    // Launch 3: warm cache (written by launch 2's report).
    const log3 = await launch(3, 'slash-1812-cached');
    await reopen();
    check('(a) cache persisted', existsSync(path.join(appData, 'last-commands.json')));
    check('(c) agent not started on reopen', startedCount(log3) === 0);
    await typeInComposer(cdp, '/');
    await cdp.waitFor(`document.querySelectorAll('[role="listbox"] [role="option"]').length > 0`, { timeoutMs: 10_000, label: 'cached command list' }).catch(() => {});
    const warm = await menu(cdp);
    check('(a) cached commands listed instantly', warm.options.some((o) => o.includes('tools')) && !warm.none && !warm.starting, warm);
    await shot('a1-cached-list.png');
    await clearComposer(cdp);
    await typeInComposer(cdp, '/pause');
    await key(cdp, 13, 'Enter');
    await sleep(1500);
    await clearComposer(cdp);
    await typeInComposer(cdp, '/new');
    await key(cdp, 13, 'Enter');
    await sleep(1500);
    const s3 = await sessionStatus();
    check('(c) /pause and /new leave the agent stopped, no omp spawn', startedCount(log3) === 0 && s3.status === 'stopped', { status: s3.status, starts: startedCount(log3) });
    await shot('c-native-no-start.png');
    await clearComposer(cdp);
    await typeInComposer(cdp, '/role planner');
    await key(cdp, 13, 'Enter');
    await until(() => promptsOf(log3).some((l) => /\/switch @planner/.test(l)), 20000);
    await sleep(1500);
    const roles = promptsOf(log3).filter((l) => /\/switch @planner/.test(l));
    check('(d) /role planner starts the agent and applies the role once', startedCount(log3) === 1 && roles.length === 1, { starts: startedCount(log3), roles: roles.length });
    await shot('d-role-applied.png');

    // (e) started Session: list shown, command sent once.
    await clearComposer(cdp);
    await typeInComposer(cdp, '/');
    await sleep(500);
    const started = await menu(cdp);
    check('(e) started Session lists commands as before', started.options.some((o) => o.includes('tools')) && !started.starting, started);
    await shot('e1-started-list.png');
    await clearComposer(cdp);
    await typeInComposer(cdp, '/tools');
    // With commands listed, the first Enter accepts the highlighted menu row (completes `/tools `); the second submits.
    await key(cdp, 13, 'Enter');
    await sleep(500);
    check('(e) first Enter only completes the menu row, nothing sent', promptsOf(log3).filter((l) => /\/tools/.test(l)).length === 0);
    await key(cdp, 13, 'Enter');
    await sleep(2500);
    const tools = promptsOf(log3).filter((l) => /"\/tools"|\/tools/.test(l) && !/switch/.test(l));
    check('(e) started Session sends a command once, no new spawn', tools.length === 1 && startedCount(log3) === 1, { tools: tools.length, starts: startedCount(log3) });
    await shot('e2-started-sent.png');
  } catch (err) {
    failures.push(`FAIL crash: ${err?.stack ?? err}`);
    console.error(err);
    try { if (cdp) await cdp.screenshot(path.join(dirs.shots, 'crash.png')); } catch {}
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
  }
  console.log('screenshots:\n' + shots.map((s) => `  ${s}`).join('\n'));
  writeFileSync(path.join(dirs.shots, 'report.json'), JSON.stringify({ head, findings, failures, shots }, null, 2));
  if (failures.length) {
    console.error(`verify-1812: ${failures.length} FAILURE(S)`);
    for (const f of failures) console.error(`  ${f}`);
    process.exitCode = 1;
  } else console.log(`verify-1812: ALL ${findings.length} CHECKS PASSED`);
}

main().catch((err) => {
  console.error('verify-1812: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
