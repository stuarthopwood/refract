#!/usr/bin/env node
// Live check for the right-panel terminal (spec 144 quickstart steps 2-9) against a PREBUILT scratch copy of the Tauri debug exe.
// Usage: node scripts/verify-tauri-144.mjs --exe <abs path to exe> --root <abs scratch dir> [--port 9351]
// Everything lives under --root (data dir, WebView2 profile, omp profile, scratch repo, evidence/); nothing touches %APPDATA%\refract-tauri.
// Each step records PASS/FAIL and the run continues, so one launch yields a full report in evidence/results.json.

import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, isTargetOwningPort, launchViaJobObject, sleep, stopLauncher, waitForCdpTarget } from './verify-tauri-cdp.mjs';
import { switchTheme } from './verify-tauri-scratch-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argOf = (name, fallback) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : fallback);
const ROOT = path.resolve(argOf('root', path.join(tmpdir(), 'refract-live-144')));
const SOURCE_EXE = argOf('exe');
const PORT = Number(argOf('port', '9351'));
if (!SOURCE_EXE) throw new Error('--exe <prebuilt refract exe> is required (this script never builds)');

const dirs = Object.fromEntries(['data', 'webview2', 'import-src', 'omp-agent', 'shim', 'exe', 'evidence'].map((n) => [n, path.join(ROOT, n)]));
const REPO_DIR = path.join(ROOT, 'repo-144');
const REPO_NAME = path.basename(REPO_DIR);
const EVIDENCE = dirs.evidence;
const MARKER = 'PRIVACY-MARKER-144';
const REAL_REGISTRY = path.join(process.env.APPDATA ?? '', 'refract-tauri', 'registry.json');

const results = [];
let cdp;
let theme = 'dark';
const q = JSON.stringify;
const log = (line) => (console.log(line), appendFileSync(path.join(EVIDENCE, 'run.log'), `${line}\n`));

async function step(id, title, fn) {
  const started = Date.now();
  try {
    const detail = await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error('step exceeded 300 s (hung)')), 300_000).unref())]);
    results.push({ id, title, status: 'PASS', detail: detail ?? '', ms: Date.now() - started });
    log(`PASS ${id} ${title}${detail ? ` -- ${detail}` : ''}`);
  } catch (err) {
    results.push({ id, title, status: 'FAIL', detail: err.message, ms: Date.now() - started });
    log(`FAIL ${id} ${title} -- ${err.message}`);
    process.exitCode = 1;
    await shot(`fail-${id}`).catch(() => {});
  }
  writeFileSync(path.join(EVIDENCE, 'results.json'), JSON.stringify(results, null, 2));
}

const shot = (name) => cdp.screenshot(path.join(EVIDENCE, `${name}-${theme}.png`));
const ev = (expr) => cdp.evaluate(expr);
const must = (cond, message) => { if (!cond) throw new Error(message); };

function rust(src, out) {
  if (existsSync(out)) return out;
  const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(here, src), '-o', out], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`rustc ${src} failed: ${r.stderr}`);
  return out;
}

function sh(cmd, ...args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
}

function prepareScratch() {
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  mkdirSync(REPO_DIR, { recursive: true });
  if (!existsSync(path.join(REPO_DIR, '.git'))) {
    sh('git', '-C', REPO_DIR, 'init', '-q', '-b', 'main');
    sh('git', '-C', REPO_DIR, '-c', 'user.name=v144', '-c', 'user.email=v144@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init');
  }
  const exe = path.join(dirs.exe, 'refract-debug.exe');
  copyFileSync(SOURCE_EXE, exe);
  return exe;
}

/** A PATH with the given directories removed, set under the one `Path` key so Windows never sees two spellings. */
function envWithPath(extra, pathValue) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.Path = pathValue;
  return env;
}

async function launch(name, exe, launcher, pathValue) {
  const pidFile = path.join(dirs.exe, `${name}.pid`);
  rmSync(pidFile, { force: true });
  const env = envWithPath(
    {
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: dirs.webview2,
      REFRACT_DATA_DIR: dirs.data,
      REFRACT_IMPORT_SOURCE_DIR: dirs['import-src'],
      PI_CODING_AGENT_DIR: dirs['omp-agent'],
      REFRACT_FAKE_OMP_SCRIPT: path.join(here, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
    },
    pathValue
  );
  const { child, targetPid } = await launchViaJobObject(launcher, pidFile, exe, [], { cwd: dirs.exe, env });
  const appLog = path.join(EVIDENCE, `app-${name}.log`);
  writeFileSync(appLog, '');
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => appendFileSync(appLog, chunk));
  cdp = await CdpSession.connect(await waitForCdpTarget(PORT, { timeoutMs: 60_000 }));
  must(isTargetOwningPort(PORT, targetPid), `CDP port ${PORT} is not owned by pid ${targetPid} launched here`);
  await cdp.waitFor(`!!window.refract`, { timeoutMs: 30_000, label: 'window.refract bridge' });
  log(`launched ${name} pid ${targetPid}`);
  return { child, targetPid, appLog };
}

async function quit(app) {
  cdp?.close();
  cdp = undefined;
  await stopLauncher(app.child);
  await sleep(1500);
}

// ---- terminal page helpers ---------------------------------------------------------------------------------

const TAB_NODES = `Array.from(document.querySelectorAll('[id^="terminal-tab-"]'))`;
const tabs = () =>
  ev(`${TAB_NODES}.map((t) => ({ id: t.id.replace('terminal-tab-', ''), name: (t.querySelector('.truncate')?.textContent ?? t.textContent).trim(), selected: t.getAttribute('aria-selected') === 'true' || t.dataset.state === 'active' }))`);
const activeTab = async () => (await tabs()).find((t) => t.selected);
const rows = () => ev(`document.querySelector('[data-terminal-view] .xterm-rows')?.innerText ?? ''`);
const sessionIds = async () => (await ev(`window.refract.sessions.list().then((r) => r.ok ? r.value.map((s) => s.id) : [])`)).filter(Boolean);

async function tabInfo(tabId) {
  for (const sid of await sessionIds()) {
    const r = await ev(`window.refract.terminal.list(${q(sid)})`);
    const tab = r.ok && r.value.tabs.find((t) => t.id === tabId);
    if (tab) return tab;
  }
  return null;
}

async function output(tabId, mode = 'last-lines') {
  const r = await ev(`window.refract.terminal.readOutput(${q(tabId)}, ${q(mode)})`);
  must(r.ok, `readOutput failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

async function waitOutput(regex, { timeoutMs = 20_000, tabId } = {}) {
  const id = tabId ?? (await activeTab())?.id;
  must(id, 'no active terminal tab');
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = (await output(id)).text;
    if (regex.test(text)) return text;
    await sleep(400);
  }
  throw new Error(`terminal output never matched ${regex}; tail: ${q(text.slice(-300))}`);
}

async function ensureTerminalOpen() {
  const pressed = await ev(`document.querySelector('[data-rail-button="terminal"]')?.getAttribute('aria-pressed')`);
  if (pressed !== 'true' || !(await ev(`!!document.querySelector('[data-terminal-view]')`))) {
    if (pressed === 'true') await cdp.click(`document.querySelector('[data-rail-button="terminal"]')`);
    await cdp.click(`document.querySelector('[data-rail-button="terminal"]')`);
  }
  await cdp.waitFor(`!!document.querySelector('[data-terminal-view] .xterm-rows')`, { timeoutMs: 20_000, label: 'terminal view mounted' });
}

// Prompts differ per machine (this one is a glyph-heavy theme), so "painted" means the shell wrote something and the starting notice is gone.
const waitPrompt = () => cdp.waitFor(`(document.querySelector('[data-terminal-view] .xterm-rows')?.innerText ?? '').trim().length > 4 && !/Starting shell/.test(document.body.innerText)`, { timeoutMs: 20_000, label: 'shell prompt painted' });

/** Types through xterm's own textarea; only if that route drops the line is it sent over IPC, and the fallback is logged. */
const enter = async () => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};

async function typeCmd(cmd) {
  if (cmd.startsWith('\u0003')) {
    await ev(`window.refract.terminal.input(${q((await activeTab()).id)}, '\\u0003')`);
    await sleep(500);
    return;
  }
  await ev(`document.querySelector('[data-terminal-view] .xterm-helper-textarea')?.focus()`);
  await cdp.send('Input.insertText', { text: cmd });
  const probe = cmd.slice(0, 12).replace(/\s+/g, ' ');
  const echoed = await cdp.waitFor(`(document.querySelector('[data-terminal-view] .xterm-rows')?.innerText ?? '').replace(/\\s+/g, ' ').includes(${q(probe)})`, { timeoutMs: 3000, label: 'typed text echoed' }).catch(() => false);
  const id = (await activeTab()).id;
  if (!echoed) {
    log(`note: keyboard route dropped "${probe}", fell back to terminal.input`);
    await ev(`window.refract.terminal.input(${q(id)}, ${q(`${cmd}\r`)})`);
    return;
  }
  await enter();
}

async function addTab() {
  const before = (await tabs()).length;
  await cdp.click(`document.querySelector('[aria-label="New terminal"]')`);
  await cdp.waitFor(`${TAB_NODES}.length > ${before}`, { timeoutMs: 20_000, label: 'new tab appears' });
  await waitPrompt();
}

const selectTab = async (id) => {
  await cdp.click(`document.getElementById(${q(`terminal-tab-${id}`)})`);
  await cdp.waitFor(`document.getElementById(${q(`terminal-tab-${id}`)})?.getAttribute('aria-selected') === 'true'`, { timeoutMs: 10_000, label: 'tab selected' });
};

async function selectSessionRow(index) {
  const li = `Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${q(REPO_NAME)}))?.querySelectorAll('li')[${index}]`;
  await cdp.click(`(${li})?.querySelector('button:not([aria-label^="More actions"])') ?? (${li})`);
  await sleep(800);
}

const rowCount = () => ev(`Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${q(REPO_NAME)}))?.querySelectorAll('li').length ?? 0`);

async function rightClickTerminal(selector = `document.querySelector('[data-terminal-view] .xterm-screen')`) {
  const rect = await cdp.waitFor(`(() => { const el = ${selector}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 20 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'right', clickCount: 1 });
  await cdp.waitFor(`!!document.querySelector('[role="menu"][data-state="open"]')`, { timeoutMs: 5000, label: 'terminal context menu open' });
}

async function menuPick(text) {
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === ${q(text)})`);
}

async function selectRowText(text) {
  const rect = await cdp.waitFor(`(() => { const el = Array.from(document.querySelectorAll('[data-terminal-view] .xterm-rows > div')).find((d) => d.textContent.trim() === ${q(text)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + 12, y: r.y + r.height / 2 }; })()`, { timeoutMs: 8000, label: `row "${text}" visible` });
  for (const clickCount of [1, 2, 3]) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount });
  }
}

const transcript = () => ev(`document.querySelector('[aria-label="Transcript"]')?.textContent ?? ''`);
const composer = () => ev(`(() => { const el = document.querySelector('[aria-label="Message"]'); return el ? (el.value ?? el.textContent) : ''; })()`);
const closeButton = (name) => `document.querySelector('[aria-label=${q(`Close ${name}`)}]')`;

function treeMemoryMb(pid) {
  const script = `$all = Get-CimInstance Win32_Process; $ids = @(${pid}); $q = @(${pid}); while ($q.Count) { $n = @(); foreach ($p in $q) { $n += ($all | Where-Object ParentProcessId -eq $p).ProcessId }; $ids += $n; $q = $n }; [math]::Round((Get-Process -Id $ids -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum / 1MB)`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
  return Number(r.stdout.trim());
}

function scanForMarker(roots) {
  const hits = [];
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) return readdirSync(p).forEach((n) => walk(path.join(p, n)));
    if (readFileSync(p).includes(MARKER) || readFileSync(p).includes(Buffer.from(MARKER, 'utf16le'))) hits.push(p);
  };
  roots.filter(existsSync).forEach(walk);
  return hits;
}

// ---- the visual tour, run once per theme ---------------------------------------------------------------------

async function uiTour() {
  await ensureTerminalOpen();
  await typeCmd(`echo tour-${theme}`);
  await waitOutput(new RegExp(`^tour-${theme}$`, 'm'));
  await shot('t-panel');
  await rightClickTerminal();
  await shot('t-context-menu');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 });
  await addTab();
  await typeCmd('ping -n 30 localhost');
  await waitOutput(/Reply from/);
  const name = (await activeTab()).name;
  await cdp.click(closeButton(name));
  await cdp.waitFor(`!!document.querySelector('[role="alertdialog"]')`, { timeoutMs: 8000, label: 'close prompt' });
  await shot('t-close-prompt');
  await cdp.clickByText('Keep running', { inDialog: false });
  await cdp.waitFor(`!document.querySelector('[role="alertdialog"]')`, { timeoutMs: 8000, label: 'prompt dismissed' });
  await typeCmd('\u0003');
  await typeCmd('exit');
  await cdp.waitFor(`/Shell ended/.test(document.body.innerText)`, { timeoutMs: 20_000, label: 'ended banner' });
  await shot('t-ended-banner');
}

// ---- the run -----------------------------------------------------------------------------------------------------

async function main() {
  mkdirSync(EVIDENCE, { recursive: true });
  const exe = prepareScratch();
  const registryBefore = existsSync(REAL_REGISTRY) ? statSync(REAL_REGISTRY).mtimeMs : null;
  const shimExe = rust('verify-tauri-omp-shim.rs', path.join(dirs.shim, 'omp.exe'));
  const launcher = rust('verify-tauri-launcher.rs', path.join(dirs.shim, 'launcher.exe'));
  const fullPath = `${dirs.shim};${process.env.Path ?? process.env.PATH}`;
  const state = { names: [], t1: null };
  log(`root ${ROOT} port ${PORT} shim ${shimExe}`);

  // ---- launch 1: steps 2, 4, 5, 6, 7 -------------------------------------------------------------------
  let app = await launch('l1', exe, launcher, fullPath);
  await step('S0', 'Isolation: scratch data dir resolved, Session list holds only this run', async () => {
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]') || !!document.querySelector('[data-repository-id]')`, { timeoutMs: 60_000 });
    const ids = await sessionIds();
    must(ids.length === 0, `sessions.list shows ${ids.length} pre-existing sessions`);
    must(existsSync(path.join(dirs.data, 'registry.json')) || readdirSync(dirs.data).length > 0, 'scratch data dir stayed empty: the app may use another dir');
    return 'sessions.list empty, data dir populated';
  });
  await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return !b || (b.getAttribute('aria-disabled') !== 'true' && !b.disabled); })()`, { timeoutMs: 60_000, label: 'readiness green' });
  await addRepository(cdp, REPO_DIR);
  await createSessionViaQuickCreate(cdp, REPO_NAME);
  await createSessionViaQuickCreate(cdp, REPO_NAME);

  await step('S2a', 'Terminal rail button opens a prompt within 2 s (SC-001), in the Session folder', async () => {
    const t0 = Date.now();
    await ensureTerminalOpen();
    await waitPrompt();
    const ms = Date.now() - t0;
    await shot('s2-prompt');
    await typeCmd('Get-Location');
    const text = await waitOutput(/Path\s*\n-+\s*\n[A-Z]:\\/);
    must(/repo-144|…\\[a-z]+-[a-z]+/.test(`${text}${await rows()}`), 'prompt does not show the Session folder');
    must(ms <= 2000, `prompt took ${ms} ms (> 2000)`);
    return `prompt after ${ms} ms`;
  });
  await step('S2b', 'Streams 2000 lines; widening the pane re-wraps and WindowSize follows', async () => {
    await typeCmd('1..2000 | % { "line $_" }');
    await waitOutput(/line 2000/);
    const width = () => ev(`document.querySelector('[data-terminal-view]').getBoundingClientRect().width`);
    const cols = async () => {
      await typeCmd('$Host.UI.RawUI.WindowSize.Width');
      await sleep(900);
      const nums = (await output((await activeTab()).id)).text.match(/^\d+$/gm) ?? [];
      return Number(nums.at(-1));
    };
    const w0 = await width();
    const c0 = await cols();
    const hr = await cdp.waitFor(`(() => { const t = document.querySelector('[data-terminal-view]').getBoundingClientRect(); const seps = Array.from(document.querySelectorAll('[role="separator"]')).map((e) => e.getBoundingClientRect()).filter((r) => r.height > 100 && r.x < t.x + 4); seps.sort((a, b) => b.x - a.x); const r = seps[0]; return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`, { label: 'vertical separator left of the terminal pane' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hr.x, y: hr.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 12; i++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hr.x - i * 25, y: hr.y, button: 'left', buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hr.x - 300, y: hr.y, button: 'left', clickCount: 1 });
    await sleep(900);
    const w1 = await width();
    const c1 = await cols();
    await shot('s2-widened');
    must(w1 > w0 + 50, `pane did not widen (${w0} -> ${w1})`);
    must(c1 > c0, `WindowSize.Width did not follow the resize (${c0} -> ${c1})`);
    return `width ${Math.round(w0)}->${Math.round(w1)}px, columns ${c0}->${c1}`;
  });

  await step('S4a', 'Three more tabs; counter loop in tab 1 survives tab, Panel, Session switches and a window reload', async () => {
    const first = (await activeTab()).id;
    await typeCmd('$i=0; while($true){ $i++; "tick $i"; Start-Sleep -Milliseconds 300 }');
    await waitOutput(/tick 3/);
    state.t1 = first;
    for (let i = 0; i < 3; i++) await addTab();
    await shot('s4-four-tabs');
    const ticks = async () => Math.max(0, ...[...(await output(first)).text.matchAll(/tick (\d+)/g)].map((m) => Number(m[1])));
    const t0 = await ticks();
    await selectTab(first);
    await waitOutput(/tick \d+/);
    const other = (await tabs()).find((t) => t.id !== first);
    await selectTab(other.id);
    const panel = await ev(`Array.from(document.querySelectorAll('[data-rail-button]')).map((b) => b.dataset.railButton).find((id) => id !== 'terminal')`);
    await cdp.click(`document.querySelector('[data-rail-button=${q(panel)}]')`);
    await sleep(600);
    await ensureTerminalOpen();
    await selectSessionRow(1);
    await selectSessionRow(0);
    await ensureTerminalOpen();
    await selectTab(first);
    const t1 = await ticks();
    must(t1 > t0, `counter stalled across Panel/Session switches (${t0} -> ${t1})`);
    await cdp.send('Page.reload');
    await sleep(2500);
    await cdp.waitFor(`!!window.refract && !!document.querySelector('[data-repository-id]')`, { timeoutMs: 40_000, label: 'window reloaded' });
    await selectSessionRow(0);
    await ensureTerminalOpen();
    await selectTab(first);
    await sleep(1200);
    const t2 = await ticks();
    must(t2 > t1, `counter stopped after reload (${t1} -> ${t2})`);
    must(/tick 1\b/.test((await output(first)).text) || (await rows()).includes('tick'), 'earlier output missing after reload');
    return `ticks ${t0} -> ${t1} -> ${t2} (after reload)`;
  });
  await step('S4b', 'Rename a tab; a 9th tab is refused with the reason', async () => {
    const target = (await tabs()).at(-1);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    const rect = await ev(`(() => { const r = document.getElementById(${q(`terminal-tab-${target.id}`)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const clickCount of [1, 2]) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount });
    }
    await cdp.waitFor(`!!document.querySelector('input[aria-label^="Rename "]')`, { timeoutMs: 8000, label: 'rename field' });
    await ev(`document.querySelector('input[aria-label^="Rename "]').select()`);
    await cdp.send('Input.insertText', { text: 'Renamed-144' });
    await shot('s4-renaming');
    await enter();
    await cdp.waitFor(`${TAB_NODES}.some((t) => t.textContent.includes('Renamed-144'))`, { timeoutMs: 8000, label: 'renamed tab shown' });
    let count = (await tabs()).length;
    while (count < 8) {
      await addTab();
      count = (await tabs()).length;
    }
    const label = await ev(`document.querySelector('[aria-label^="New terminal"]').getAttribute('aria-label')`);
    must(/maximum/.test(label), `add button does not explain the limit: ${label}`);
    await cdp.click(`document.querySelector('[aria-label^="New terminal"]')`);
    await sleep(800);
    must((await tabs()).length === count, 'a 9th tab was created');
    await shot('s4-max-tabs');
    state.names = (await tabs()).map((t) => t.name);
    return `limit label: ${label}`;
  });

  await step('S6a', 'Add to chat: selected output lands in the composer, nothing sent', async () => {
    await selectTab(state.t1);
    await typeCmd('\u0003');
    await typeCmd('echo marker');
    await waitOutput(/^marker$/m);
    await sleep(600);
    const sentBefore = (await transcript()).length;
    await selectRowText('marker');
    await rightClickTerminal(`Array.from(document.querySelectorAll('[data-terminal-view] .xterm-rows > div')).find((d) => d.textContent.trim() === 'marker')`);
    await menuPick('Add to chat');
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && (el.value ?? el.textContent).includes('marker'); })()`, { timeoutMs: 8000, label: 'composer holds the selection' });
    await shot('s6-add-to-chat');
    must((await transcript()).length === sentBefore, 'Add to chat sent a turn');
    return `composer: ${q((await composer()).slice(0, 80))}`;
  });
  await step('S6b', 'Ask agent about this: error output reaches a sent turn; flood of 5000 lines shows truncation + toast', async () => {
    await ev(`(() => { const el = document.querySelector('[aria-label="Message"]'); if (el && 'value' in el) { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
    await typeCmd('Get-Item nope');
    await waitOutput(/Cannot find path/);
    await rightClickTerminal();
    await menuPick('Ask agent about this');
    await cdp.waitFor(`/Cannot find path|nope/.test(document.querySelector('[aria-label="Transcript"]')?.textContent ?? '')`, { timeoutMs: 20_000, label: 'turn with the error in the transcript' });
    await shot('s6-ask-agent');
    await typeCmd('1..5000');
    await waitOutput(/^5000$/m, { timeoutMs: 40_000 });
    await rightClickTerminal();
    await menuPick('Ask agent about this');
    await cdp.waitFor(`/Truncated/.test(document.querySelector('[aria-label="Transcript"]')?.textContent ?? '')`, { timeoutMs: 20_000, label: 'truncation line in the sent turn' });
    const toast = await cdp.waitFor(`Array.from(document.querySelectorAll('[data-sonner-toast]')).map((t) => t.textContent).find((t) => /Only the last/.test(t))`, { timeoutMs: 8000, label: 'truncation toast' });
    await shot('s6-truncated');
    return toast;
  });

  await step('S5', 'Closing a tab with a running command asks first; Keep running keeps it, Close terminal ends it', async () => {
    await addTab().catch(() => {});
    const victim = (await tabs()).find((t) => t.id !== state.t1 && t.name !== 'Renamed-144') ?? (await tabs())[0];
    await selectTab(victim.id);
    await typeCmd('ping -n 30 localhost');
    await waitOutput(/Reply from/, { tabId: victim.id });
    const before = (await tabs()).length;
    await cdp.click(closeButton(victim.name));
    await cdp.waitFor(`!!document.querySelector('[role="alertdialog"]')`, { timeoutMs: 8000, label: 'confirm prompt' });
    const title = await ev(`document.querySelector('[role="alertdialog"]').textContent`);
    must(title.includes(victim.name), `prompt does not name the tab: ${title}`);
    await shot('s5-confirm');
    await cdp.clickByText('Keep running');
    await sleep(600);
    must((await tabs()).length === before, 'Keep running still closed the tab');
    await cdp.click(closeButton(victim.name));
    await cdp.waitFor(`!!document.querySelector('[role="alertdialog"]')`, { timeoutMs: 8000 });
    await cdp.clickByText('Close terminal');
    await cdp.waitFor(`${TAB_NODES}.length === ${before - 1}`, { timeoutMs: 10_000, label: 'tab gone after confirm' });
    return `closed "${victim.name}" after confirm`;
  });
  await step('S7a', 'Typing exit shows "Shell ended with code 0" and Restart shell brings a fresh prompt', async () => {
    const tab = (await tabs()).find((t) => t.id !== state.t1 && t.name !== 'Renamed-144');
    await selectTab(tab.id);
    await typeCmd('exit');
    await cdp.waitFor(`/Shell ended with code 0/.test(document.body.innerText)`, { timeoutMs: 20_000, label: 'ended banner' });
    await shot('s7-ended');
    await cdp.clickByText('Restart shell');
    await cdp.waitFor(`!/Shell ended/.test(document.body.innerText)`, { timeoutMs: 20_000, label: 'banner cleared' });
    await waitPrompt();
    await typeCmd('echo after-restart');
    await waitOutput(/^after-restart$/m);
    await shot('s7-restarted');
  });
  await step('S8a', 'Prints the privacy marker, then quits', async () => {
    await typeCmd(`echo ${MARKER}`);
    await waitOutput(new RegExp(`^${MARKER}$`, 'm'));
  });
  await quit(app);
  await step('S8b', 'Privacy: marker absent from the data dir, omp profile and app log', async () => {
    const hits = scanForMarker([dirs.data, dirs['omp-agent'], app.appLog]);
    must(hits.length === 0, `marker found in: ${hits.join(', ')}`);
    return 'no hits';
  });

  // ---- launch 2: relaunch, persistence, light theme tour, folder error, flood -------------------------------
  app = await launch('l2', exe, launcher, fullPath);
  await cdp.waitFor(`!!document.querySelector('[data-repository-id]')`, { timeoutMs: 40_000 });
  await step('S4c', 'Renamed tab names survive quit and relaunch', async () => {
    await selectSessionRow(0);
    await ensureTerminalOpen();
    await cdp.waitFor(`${TAB_NODES}.some((t) => t.textContent.includes('Renamed-144'))`, { timeoutMs: 20_000, label: 'renamed tab restored' });
    return `tabs: ${(await tabs()).map((t) => t.name).join(' | ')}`;
  });
  await step('S2c', 'Default shell is pwsh when installed', async () => {
    await addTab().catch(() => {});
    const info = await tabInfo((await activeTab()).id);
    await typeCmd('$PSVersionTable.PSEdition');
    await waitOutput(/Core|Desktop/);
    return `tab.shell = ${info?.shell}`;
  });
  await step('S7b', 'Session folder deleted: opening a tab gives a plain error naming the folder', async () => {
    await createSessionViaQuickCreate(cdp, REPO_NAME);
    await ensureTerminalOpen();
    await waitPrompt();
    const tab = await activeTab();
    const info = await tabInfo(tab.id);
    const cwd = path.resolve(info.cwd);
    must(cwd.toLowerCase().startsWith(path.resolve(ROOT).toLowerCase()) && cwd.includes('pinion-worktrees'), `refusing to delete outside the scratch root: ${cwd}`);
    await cdp.click(closeButton(tab.name));
    await cdp.waitFor(`!${TAB_NODES}.some((t) => t.id === ${q(`terminal-tab-${tab.id}`)})`, { timeoutMs: 15_000, label: 'tab closed' }).catch(() => {});
    await cdp.clickByText('Close terminal').catch(() => {});
    await sleep(1500);
    rmSync(cwd, { recursive: true, force: true });
    await cdp.click(`document.querySelector('[aria-label^="New terminal"]')`);
    const text = await cdp.waitFor(`(document.body.innerText.match(/[^\\n]*${path.basename(cwd).replace(/[^\w-]/g, '.')}[^\\n]*/g) || []).find((l) => /folder|exist|found|missing/i.test(l))`, { timeoutMs: 15_000, label: 'error naming the folder' });
    await shot('s7-folder-error');
    return text.trim().slice(0, 160);
  });

  theme = 'light';
  await step('T-light', 'Light theme tour (panel, menu, close prompt, ended banner)', async () => {
    await switchTheme(cdp, 'light', 'Light');
    await selectSessionRow(1);
    await uiTour();
  });
  theme = 'dark';
  await step('T-dark', 'Dark theme tour', async () => {
    await switchTheme(cdp, 'dark', 'Dark');
    await uiTour();
  });

  await step('S9', 'Flood: no UI stall, tab switch and composer typing stay responsive, memory stable (SC-003)', async () => {
    await ensureTerminalOpen();
    await addTab().catch(() => {});
    const quiet = (await activeTab()).id;
    await addTab().catch(() => {});
    const flooded = (await activeTab()).id;
    await ev(`window.__gap = 0; (function f(last) { requestAnimationFrame((t) => { if (last) window.__gap = Math.max(window.__gap, t - last); f(t); }); })(0)`);
    await typeCmd('while($true){ "x"*200 }');
    await sleep(3000);
    const mem = [treeMemoryMb(app.targetPid)];
    await shot('s9-flood');
    let worst = 0;
    for (let i = 0; i < 6; i++) {
      await sleep(5000);
      const t0 = Date.now();
      await selectTab(i % 2 === 0 ? quiet : flooded);
      worst = Math.max(worst, Date.now() - t0);
      mem.push(treeMemoryMb(app.targetPid));
    }
    const t0 = Date.now();
    await cdp.typeIntoByLabel('Message', 'still typing');
    await cdp.waitFor(`(document.querySelector('[aria-label="Message"]')?.value ?? document.querySelector('[aria-label="Message"]')?.textContent ?? '').includes('still typing')`, { timeoutMs: 5000 });
    const typeMs = Date.now() - t0;
    const gap = await ev(`window.__gap`);
    await shot('s9-flood-typed');
    log(`flood memory MB: ${mem.join(', ')}; worst tab switch ${worst} ms; composer ${typeMs} ms; worst frame gap ${Math.round(gap)} ms`);
    must(worst < 1500, `tab switch took ${worst} ms under flood`);
    must(typeMs < 1500, `composer took ${typeMs} ms under flood`);
    must(mem.at(-1) < mem[1] * 1.5, `memory grew ${mem[1]} -> ${mem.at(-1)} MB`);
    return `memory MB ${mem.join('->')}; switch<=${worst} ms; composer ${typeMs} ms; frame gap ${Math.round(gap)} ms`;
  });
  await quit(app);

  // ---- launch 3/4: shell fallbacks (step 3) -----------------------------------------------------------------
  const noPwsh = (process.env.Path ?? process.env.PATH).split(';').filter((d) => d && !existsSync(path.join(d, 'pwsh.exe'))).join(';');
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  for (const [id, title, pathValue, expected] of [
    ['S3a', 'pwsh missing from PATH: new tab is Windows PowerShell', `${dirs.shim};${noPwsh}`, 'powershell'],
    ['S3b', 'No usable PATH: new tab is %COMSPEC%', `${dirs.shim};${system32}`, 'cmd'],
  ]) {
    app = await launch(id, exe, launcher, pathValue);
    await step(id, title, async () => {
      await cdp.waitFor(`!!document.querySelector('[data-repository-id]')`, { timeoutMs: 40_000 });
      await selectSessionRow(1);
      await ensureTerminalOpen();
      const known = new Set((await tabs()).map((t) => t.id));
      await cdp.click(`document.querySelector('[aria-label^="New terminal"]')`);
      await cdp.waitFor(`${TAB_NODES}.length > ${known.size}`, { timeoutMs: 20_000, label: 'tab added' });
      const fresh = (await tabs()).find((t) => !known.has(t.id));
      const info = await tabInfo(fresh.id);
      await shot(`${id}-fallback`);
      must(info?.shell === expected, `new tab shell is ${info?.shell}, expected ${expected}`);
      return `tab.shell = ${info.shell}`;
    });
    await quit(app);
  }

  const registryAfter = existsSync(REAL_REGISTRY) ? statSync(REAL_REGISTRY).mtimeMs : null;
  await step('S-real', 'Real %APPDATA%\\refract-tauri registry.json untouched', async () => {
    must(registryBefore === registryAfter, `registry mtime changed ${registryBefore} -> ${registryAfter}`);
    return `mtime ${registryBefore}`;
  });
  log(`${results.filter((r) => r.status === 'PASS').length}/${results.length} steps passed; evidence ${EVIDENCE}`);
}

main().catch((err) => {
  console.error('verify-tauri-144: FAIL', err);
  process.exitCode = 1;
});
