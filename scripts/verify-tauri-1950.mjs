#!/usr/bin/env node
// Live CDP check for issue #1950: a chat `#123` reference pins the item in the right pane (focus stays in the chat),
// Ctrl/middle click and a failed lookup open GitHub, and the type icon is neutral until the item is looked up.
// Fake omp (tape hash-1789, which accepts a prompt) and the #1789 fake `gh` (serves PR #42 and Issue #12, fails #99)
// keep it off GitHub; its argv log proves no lookup runs before a hover or click.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_1950_DIR=<evidence dir> node scripts/verify-tauri-1950.mjs

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WORK_DIR = process.env.REFRACT_1950_DIR || path.join(tmpdir(), 'r1950');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const CATALOG_FIXTURE = path.join(__dirname, 'fixtures', 'model-catalogs', 'chat-1069.json');
const COMPOSER = `document.querySelector('[aria-label="Message"]')`;
const link = (text) => `Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.closest('[role="listbox"]'))`;
const TAB = (id) => `document.getElementById('panel-tab-${id}')`;
const CTRL = 2;

const findings = [];
const failures = [];
function check(label, ok, detail) {
  const text = `${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`;
  (ok ? findings : failures).push(`${ok ? 'PASS' : 'FAIL'} ${text}`);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`);
}

async function centre(cdp, text) {
  await cdp.evaluate(`(${link(text)}).scrollIntoView({ block: 'center' })`);
  await sleep(200);
  return cdp.evaluate(`(() => { const r = (${link(text)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
}
async function hover(cdp, text) {
  const { x, y } = await centre(cdp, text);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}
async function click(cdp, text, { button = 'left', modifiers = 0 } = {}) {
  const { x, y } = await centre(cdp, text);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'middle' ? 4 : 1, clickCount: 1, modifiers });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1, modifiers });
}
const iconType = (cdp, text) => cdp.evaluate(`(${link(text)}).querySelector('[data-item-type]')?.getAttribute('data-item-type') ?? null`);
const selectedTab = (cdp) => cdp.evaluate(`Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]')).map((t) => t.id)`);
const lookups = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => /repos\/octocat\/hello-world\/(issues|pulls)\//.test(l)) : []);
const opened = (cdp) => cdp.evaluate(`window.__opened1950.slice()`);

async function main() {
  mkdirSync(WORK_DIR, { recursive: true });
  const base = path.join(WORK_DIR, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const shotsDir = path.join(WORK_DIR, 'shots');
  mkdirSync(shotsDir, { recursive: true });
  const dir = (n) => { const d = path.join(base, n); mkdirSync(d, { recursive: true }); return d; };
  const head = gitHead(REPO_ROOT);
  console.log(`verify-1950: git HEAD ${head}; shots ${shotsDir}`);

  const ghDir = dir('gh');
  const ghLog = path.join(ghDir, 'gh-calls.log');
  const ghBuild = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-1789-fake-gh.rs'), '-o', path.join(ghDir, 'gh.exe')], { encoding: 'utf8', windowsHide: true });
  if (ghBuild.status !== 0) throw new Error(`fake gh build failed: ${ghBuild.stderr}`);
  process.env.PATH = `${ghDir}${path.delimiter}${process.env.PATH}`;
  process.env.FAKE_GH_LOG = ghLog;
  const managedGh = path.join(process.env.LOCALAPPDATA || '', 'refract', 'tools', 'gh', 'gh.exe');
  if (existsSync(managedGh)) throw new Error(`${managedGh} exists; resolve_gh() would prefer it over the fake gh (#1343)`);

  const shim = dir('shim');
  buildOmpShim(shim);
  const launcherExe = buildLauncher(dir('launcher'));
  const built = buildAndCopyExeFresh(dir('exe'), BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-1950' });
  const configStorePath = path.join(dir('cfg'), 'fake-omp-config-store.json');
  writeFileSync(configStorePath, JSON.stringify({
    modelRoles: { default: 'github-copilot/claude-fable-5', smol: 'anthropic/claude-haiku-5.5', slow: 'anthropic/claude-opus-5.5', planner: 'anthropic/claude-haiku-5.5' },
    cycleOrder: ['smol', 'default', 'slow']
  }));
  const conversationFile = path.join(dir('conv'), 'conversation.jsonl');
  writeFileSync(conversationFile, JSON.stringify({ type: 'model_change', model: 'github-copilot/claude-fable-5', role: 'default', resolvedModelIsFallback: false }) + '\n');

  const shots = [];
  let child, cdp;
  const shot = async (name) => {
    const file = path.join(shotsDir, name);
    await cdp.screenshot(file);
    shots.push(file);
  };

  try {
    const repoDir = makeScratchRepo(path.join(dir('repo'), 'hello-world'), 'verify-1950');
    spawnSync('git', ['-C', repoDir, 'remote', 'add', 'origin', 'https://github.com/octocat/hello-world.git'], { windowsHide: true });
    const debugLog = path.join(shotsDir, 'fake-omp.log');
    writeFileSync(debugLog, '');
    const port = await getFreePort();
    const launched = await launchBuiltExeWithEnv(launcherExe, built.dest, {
      port, dataDir: dir('data'), importSourceDir: dir('import'), pathPrepend: `${shim}${path.delimiter}${ghDir}`, logFile: path.join(shotsDir, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'hash-1789',
        REFRACT_FAKE_OMP_CONFIG_STORE: configStorePath,
        REFRACT_FAKE_OMP_MODEL_CATALOG: CATALOG_FIXTURE,
        REFRACT_FAKE_OMP_DEBUG_LOG: debugLog,
        REFRACT_FAKE_OMP_HOST_TOOL_RECORD: path.join(dir('data'), 'host-tools.jsonl'),
        REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile,
        FAKE_GH_LOG: ghLog
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the process this run launched');
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return !!b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'readiness green' });
    await addRepository(cdp, repoDir);
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'new session dialog' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`(() => { const el = ${COMPOSER}; return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'composer enabled' });
    await sleep(1500);

    // Record what the shared external-link path is asked to open, before it navigates anywhere.
    await cdp.evaluate(`window.__opened1950 = []; document.addEventListener('click', (e) => { const a = e.target instanceof Element ? e.target.closest('a[target="_blank"]') : null; if (a) window.__opened1950.push(a.href) }, true)`);

    await cdp.evaluate(`${COMPOSER}.focus()`);
    await cdp.send('Input.insertText', { text: 'look at #42 and #12 and #99 please' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', modifiers: 0, text: '\r', unmodifiedText: '\r' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', modifiers: 0 });
    await cdp.waitFor(`!!(${link('#42')}) && !!(${link('#12')}) && !!(${link('#99')})`, { timeoutMs: 20_000, label: 'three ref links' });
    await sleep(500);

    // Neutral until looked up: no prefetch.
    const icons = [await iconType(cdp, '#42'), await iconType(cdp, '#12'), await iconType(cdp, '#99')];
    check('every ref icon is neutral before any hover or click', icons.every((t) => t === 'unknown'), icons);
    check('rendering the links ran no gh lookup (no prefetch, #610)', lookups(ghLog).length === 0, lookups(ghLog));
    check('the right pane shows no pinned tab yet', (await selectedTab(cdp)).every((id) => id !== 'panel-tab-issue' && id !== 'panel-tab-pull-request'), await selectedTab(cdp));
    await shot('01-neutral-icons.png');

    // Hover looks it up: card labels the type and the icon swaps.
    await hover(cdp, '#42');
    await cdp.waitFor(`!!document.querySelector('[data-slot="hover-card-content"]')?.textContent.includes('Add hash picker to the composer')`, { timeoutMs: 10_000, label: 'hover card' }).catch(() => {});
    const cardText = await cdp.evaluate(`document.querySelector('[data-slot="hover-card-content"]')?.textContent ?? null`);
    check('the hover card names the type (Pull request)', /Pull request/.test(cardText ?? ''), cardText);
    check('the #42 icon is the pull request icon after the lookup', (await iconType(cdp, '#42')) === 'pull-request', await iconType(cdp, '#42'));
    check('#12 stays neutral (never hovered)', (await iconType(cdp, '#12')) === 'unknown');
    await shot('02-hover-card-pull-request-icon.png');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await sleep(500);

    // Plain click on an Issue: pins and reveals the right pane, focus stays in the chat.
    await click(cdp, '#12');
    await cdp.waitFor(`${TAB('issue')}?.getAttribute('aria-selected') === 'true'`, { timeoutMs: 15_000, label: 'Issue tab selected' }).catch(() => {});
    check('a plain click on #12 pins the Issue in the right pane', await cdp.evaluate(`${TAB('issue')}?.getAttribute('aria-selected') === 'true'`), await selectedTab(cdp));
    check('the click did not open GitHub', (await opened(cdp)).length === 0, await opened(cdp));
    const focusIn = await cdp.evaluate(`(() => { const a = document.activeElement; return { inPane: !!a?.closest('[role="tabpanel"], [role="tablist"]'), tag: a?.tagName, text: a?.textContent?.trim().slice(0, 20) }; })()`);
    check('keyboard focus stays in the chat, not the right pane', focusIn.inPane === false, focusIn);
    check('the #12 icon is the issue icon after the click lookup', (await iconType(cdp, '#12')) === 'issue', await iconType(cdp, '#12'));
    await shot('03-issue-pinned-focus-in-chat.png');

    // Re-pin: a PR, then the Issue again; one tab each, the existing pin is focused.
    await click(cdp, '#42');
    await cdp.waitFor(`${TAB('pull-request')}?.getAttribute('aria-selected') === 'true'`, { timeoutMs: 15_000, label: 'PR tab selected' }).catch(() => {});
    check('a plain click on #42 pins the Pull request', await cdp.evaluate(`${TAB('pull-request')}?.getAttribute('aria-selected') === 'true'`), await selectedTab(cdp));
    await shot('04-pull-request-pinned.png');
    await click(cdp, '#12');
    await cdp.waitFor(`${TAB('issue')}?.getAttribute('aria-selected') === 'true'`, { timeoutMs: 15_000, label: 'Issue tab re-selected' }).catch(() => {});
    const tabCounts = await cdp.evaluate(`({ issue: document.querySelectorAll('#panel-tab-issue').length, pr: document.querySelectorAll('#panel-tab-pull-request').length })`);
    check('re-clicking #12 focuses the existing Issue tab without a duplicate', tabCounts.issue === 1 && tabCounts.pr === 1 && (await selectedTab(cdp)).includes('panel-tab-issue'), { tabCounts, selected: await selectedTab(cdp) });

    // Ctrl click and middle click: GitHub, never the pane.
    await click(cdp, '#42', { modifiers: CTRL });
    await sleep(700);
    check('Ctrl+click on #42 opens it on GitHub', (await opened(cdp)).includes('https://github.com/octocat/hello-world/issues/42'), await opened(cdp));
    check('Ctrl+click left the pinned panel alone', (await selectedTab(cdp)).includes('panel-tab-issue'), await selectedTab(cdp));
    await click(cdp, '#12', { button: 'middle' });
    await sleep(700);
    check('middle click on #12 opens it on GitHub', (await opened(cdp)).includes('https://github.com/octocat/hello-world/issues/12'), await opened(cdp));
    check('middle click left the pinned panel alone', (await selectedTab(cdp)).includes('panel-tab-issue'), await selectedTab(cdp));

    // Failed lookup: GitHub, pane unchanged.
    const before = (await opened(cdp)).length;
    await click(cdp, '#99');
    await sleep(1500);
    const afterOpened = await opened(cdp);
    check('a failed lookup (#99) opens GitHub', afterOpened.length === before + 1 && afterOpened[afterOpened.length - 1] === 'https://github.com/octocat/hello-world/issues/99', afterOpened);
    check('the failed lookup left the pinned panel alone', (await selectedTab(cdp)).includes('panel-tab-issue'), await selectedTab(cdp));
    check('the failed #99 icon stays neutral', (await iconType(cdp, '#99')) === 'unknown', await iconType(cdp, '#99'));
    await shot('05-after-github-opens.png');
  } catch (err) {
    failures.push(`FAIL crash: ${err?.stack ?? err}`);
    console.error(err);
    try { if (cdp) await cdp.screenshot(path.join(shotsDir, 'crash.png')); } catch {}
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
  }
  console.log('screenshots:\n' + shots.map((s) => `  ${s}`).join('\n'));
  writeFileSync(path.join(shotsDir, 'report.json'), JSON.stringify({ head, findings, failures, shots }, null, 2));
  if (failures.length) {
    console.error(`verify-1950: ${failures.length} FAILURE(S)`);
    for (const f of failures) console.error(`  ${f}`);
    process.exitCode = 1;
  } else console.log(`verify-1950: ALL ${findings.length} CHECKS PASSED`);
}

main().catch((err) => {
  console.error('verify-1950: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
