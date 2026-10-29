#!/usr/bin/env node
// Live CDP check for issue #471 (chat-links slice, spec 055). Drives a REAL built Tauri debug exe
// over CDP against the FAKE `omp` shim (`chat-links-055` scenario), never a real `omp`. External
// effects are stubbed at `window.__TAURI_INTERNALS__.invoke` (opener open_url and the
// sessions.revealFile request are RECORDED and answered, never forwarded), so no browser or
// Explorer window ever opens.
//
// Usage (after `pnpm exec tauri build --debug --no-bundle` on this head, shared target dir set):
// CARGO_TARGET_DIR=<shared target dir> REFRACT_055_SHOTS_DIR=<dir> node scripts/verify-055-chat-link-menus.mjs

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { spawnSync_ } from './verify-1067-enter-queued-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-055';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_055_SHOTS_DIR || path.join(tmpdir(), 'refract-055-chat-link-menus');

const WEB = `document.querySelector('a[href="https://example.com/docs"]')`;
const FILE = `document.querySelector('button[aria-label="Show in File Explorer: src/app.ts"]')`;
const WRAP = (el) => `(${el}).closest('span[class*="group/link"]')`;
const COPY_BTN = (el, label) => `${WRAP(el)}.querySelector('button[aria-label="${label}"]')`;
const STREAM_MSG = `Array.from(document.querySelectorAll('[data-slot="message"]')).find((m) => m.textContent.includes('STREAMING-055'))`;

const INSTALL_STUBS = `(() => {
  window.__calls = []; window.__clips = [];
  // The Tauri bridge is frozen, so intercept the IPC fetch beneath it; opener and revealFile are answered, never forwarded.
  const realFetch = window.fetch.bind(window);
  const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : input && input.url);
    if (/^(ipc|http:\\/\\/ipc\\.localhost)/.test(url) || url.includes('ipc.localhost')) {
      const cmd = decodeURIComponent(url.replace(/^.*?(ipc:\\/\\/localhost|ipc\\.localhost)\\//, '').split('?')[0]);
      let body = '';
      try { body = init && init.body ? (typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body)) : ''; } catch { body = '<binary>'; }
      window.__calls.push({ cmd, args: body });
      if (cmd === 'plugin:opener|open_url') return json(null);
      if (cmd === 'refract_request' && body.includes('sessions.revealFile')) return json({ ok: true, value: null });
    }
    return realFetch(input, init);
  };
  const w = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = (t) => { window.__clips.push(t); return w(t); };
  return true;
})()`;

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirtyLines = spawnSync_('git', ['-C', REPO_ROOT, 'status', '--porcelain']).stdout.split('\n').filter(Boolean);
  console.log(`${LOG}: git HEAD ${head}${dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
  mkdirSync(SHOTS_DIR, { recursive: true });

  const report = [];
  // Records PASS/FAIL and keeps going, so one failed step does not hide the rest.
  const check = (ok, label, extra) => {
    report.push({ step: label, ok, ...(extra !== undefined ? { extra } : {}) });
    console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` ${JSON.stringify(extra ?? '')}`}`);
  };

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-055-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-055-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-055-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-055-chat-links');
  const worktreesRootForCleanup = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-055-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-055-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-055-shim-'));

  let child;
  let cdp;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'chat-links-055'
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) {
      throw new Error(`${LOG}: CDP target on port ${port} is not owned by the process this run launched (pid ${launched.targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green (fake omp)' }
    );
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Scratch repository added' }
    );
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open' }
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Composer enabled' });
    await cdp.evaluate(INSTALL_STUBS);
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);
    await cdp.send('Input.insertText', { text: 'show me links' });
    await cdp.clickByLabel('Send message');
    // The finished message is mid-turn prose, so it shows as a closed Note row; open it.
    await cdp.waitFor(`Array.from(document.querySelectorAll('button[aria-expanded="false"]')).some((b) => /^Note/.test(b.textContent.trim()))`, { timeoutMs: 40_000, label: 'Note row present' });
    await cdp.click(`Array.from(document.querySelectorAll('button[aria-expanded="false"]')).find((b) => /^Note/.test(b.textContent.trim()))`);
    try {
      await cdp.waitFor(`!!(${WEB}) && !!(${FILE}) && !!(${STREAM_MSG})`, { timeoutMs: 40_000, label: 'Finished links and the streaming message are rendered' });
    } catch (err) {
      await cdp.screenshot(path.join(SHOTS_DIR, '00-render-timeout.png'));
      console.log(`${LOG}: DIAG`, JSON.stringify(await cdp.evaluate(`({ web: !!(${WEB}), file: !!(${FILE}), stream: !!(${STREAM_MSG}), anchors: Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href')), labels: Array.from(document.querySelectorAll('button[aria-label]')).map((b) => b.getAttribute('aria-label')).filter((l) => /explorer|path|src/i.test(l)), text: document.body.innerText.slice(0, 600) })`)));
      throw err;
    }

    const shot = (name) => cdp.screenshot(path.join(SHOTS_DIR, name));
    const centre = async (expr) => cdp.evaluate(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const mouse = (type, p, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, ...extra });
    const move = (p) => mouse('mouseMoved', p);
    const leftClick = async (p) => { await move(p); await mouse('mousePressed', p, { button: 'left', clickCount: 1 }); await mouse('mouseReleased', p, { button: 'left', clickCount: 1 }); };
    const rightClick = async (p) => { await move(p); await mouse('mousePressed', p, { button: 'right', clickCount: 1 }); await mouse('mouseReleased', p, { button: 'right', clickCount: 1 }); };
    const key = async (k, code, vk, modifiers = 0) => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
    };
    const park = () => move({ x: 2, y: 2 });
    const btnState = (expr, label) => cdp.evaluate(`(() => { const b = ${COPY_BTN(expr, label)}; if (!b) return null; const s = getComputedStyle(b); return { opacity: s.opacity, pe: s.pointerEvents, tab: b.tabIndex }; })()`);
    const menuItems = () => cdp.evaluate(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).map((i) => i.textContent.trim())`);
    const clickItem = async (text) => leftClick(await centre(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).find((i) => i.textContent.trim() === ${JSON.stringify(text)})`));
    const closeMenu = async () => { await key('Escape', 'Escape', 27); await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'menu closed' }); };
    const lastClip = () => cdp.evaluate(`window.__clips[window.__clips.length - 1] ?? null`);
    const calls = (re) => cdp.evaluate(`window.__calls.filter((c) => ${re}.test(c.cmd + ' ' + JSON.stringify(c.args))).map((c) => ({ cmd: c.cmd, args: c.args }))`);

    await park();
    await shot('01-transcript.png');

    // 1. Ghost Copy button: hidden at rest, not a Tab stop, appears on hover, copies.
    for (const [name, expr, label, expected] of [['web', WEB, 'Copy link', 'https://example.com/docs'], ['file', FILE, 'Copy path', 'src/app.ts']]) {
      const rest = await btnState(expr, label);
      check(!!rest && rest.opacity === '0' && rest.pe === 'none' && rest.tab === -1, `${name}: Copy button hidden at rest, inert, tabIndex -1`, rest);
      await move(await centre(expr));
      await cdp.waitFor(`getComputedStyle(${COPY_BTN(expr, label)}).opacity === '1'`, { timeoutMs: 5_000, label: `${name} Copy appears on hover` }).catch(() => {});
      const hov = await btnState(expr, label);
      check(!!hov && hov.opacity === '1' && hov.pe === 'auto', `${name}: Copy button appears on hover`, hov);
      await shot(`02-${name}-hover.png`);
      await leftClick(await centre(COPY_BTN(expr, label)));
      await new Promise((r) => setTimeout(r, 400));
      const clip = await lastClip();
      check(clip === expected, `${name}: Copy button copies ${JSON.stringify(expected)}`, clip);
      await shot(`03-${name}-copied.png`);
      await park();
    }

    // 2. Keyboard focus reveals it, and Tab never lands on it.
    await key('Tab', 'Tab', 9);
    await cdp.evaluate(`(${WEB}).focus()`);
    await park();
    await new Promise((r) => setTimeout(r, 300));
    const kb = await btnState(WEB, 'Copy link');
    check(!!kb && kb.opacity === '1', 'web: Copy button appears on keyboard focus (focus-visible)', kb);
    await shot('04-web-focus.png');
    const tabbed = [];
    for (let i = 0; i < 3; i += 1) {
      await key('Tab', 'Tab', 9);
      tabbed.push(await cdp.evaluate(`document.activeElement ? (document.activeElement.getAttribute('aria-label') || document.activeElement.tagName) : null`));
    }
    check(!tabbed.some((t) => t === 'Copy link' || t === 'Copy path'), 'Copy buttons are never Tab stops', tabbed);

    // 3. Right-click and Shift+F10 menus, web link.
    await rightClick(await centre(WEB));
    await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'web menu' }).catch(() => {});
    let items = await menuItems();
    check(JSON.stringify(items) === JSON.stringify(['Copy link', 'Open in browser']), 'web: right-click menu is Copy link / Open in browser', items);
    await shot('05-web-menu.png');
    const vis = await btnState(WEB, 'Copy link');
    check(!!vis && vis.opacity === '1', 'web: Copy button stays visible while its menu is open', vis);
    await clickItem('Copy link');
    await new Promise((r) => setTimeout(r, 400));
    check((await lastClip()) === 'https://example.com/docs', 'web: menu Copy link copies the URL', await lastClip());
    await rightClick(await centre(WEB));
    await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'web menu 2' }).catch(() => {});
    await clickItem('Open in browser');
    await new Promise((r) => setTimeout(r, 600));
    const opens = await calls(/open_url/);
    check(opens.length === 1 && String(opens[0].args).includes('https://example.com/docs'), 'web: Open in browser calls opener open_url once (stubbed)', { opens, all: await cdp.evaluate('window.__calls.map((c) => c.cmd).slice(-8)') });;
    await cdp.evaluate(`(${WEB}).focus()`);
    await key('F10', 'F10', 121, 8);
    await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'web Shift+F10 menu' }).catch(() => {});
    items = await menuItems();
    check(items.length === 2 && items[0] === 'Copy link', 'web: Shift+F10 opens the same menu', items);
    await shot('06-web-shift-f10.png');
    if (items.length) await closeMenu();
    const refocused = await cdp.evaluate(`document.activeElement === (${WEB})`);
    check(refocused, 'web: focus returns to the link after the menu closes', refocused);

    // 4. File link menu.
    await rightClick(await centre(FILE));
    await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'file menu' }).catch(() => {});
    items = await menuItems();
    check(JSON.stringify(items) === JSON.stringify(['Copy path', 'Show in File Explorer']), 'file: right-click menu is Copy path / Show in File Explorer', items);
    await shot('07-file-menu.png');
    await clickItem('Copy path');
    await new Promise((r) => setTimeout(r, 400));
    check((await lastClip()) === 'src/app.ts', 'file: Copy path copies the path exactly as passed to revealFile', await lastClip());
    await rightClick(await centre(FILE));
    await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'file menu 2' }).catch(() => {});
    await clickItem('Show in File Explorer');
    await new Promise((r) => setTimeout(r, 600));
    const reveals = await calls(/sessions\.revealFile/);
    check(reveals.length === 1 && JSON.stringify(reveals[0].args).includes('src/app.ts'), 'file: Show in File Explorer calls sessions.revealFile with src/app.ts (stubbed)', reveals);
    await cdp.evaluate(`(${FILE}).focus()`);
    await key('F10', 'F10', 121, 8);
    await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'file Shift+F10 menu' }).catch(() => {});
    items = await menuItems();
    check(items.length === 2 && items[0] === 'Copy path', 'file: Shift+F10 opens the same menu', items);
    await shot('08-file-shift-f10.png');
    if (items.length) await closeMenu();

    // 5. Streaming message: links inert, no Copy button, no menu.
    const streamState = await cdp.evaluate(`(() => { const m = ${STREAM_MSG}; return { copyButtons: m.querySelectorAll('button[aria-label^="Copy"]').length, anchors: m.querySelectorAll('a[href]').length, fileButtons: m.querySelectorAll('button[aria-label^="Show in File Explorer"]').length }; })()`);
    check(streamState.copyButtons === 0 && streamState.anchors === 0 && streamState.fileButtons === 0, 'streaming: links are inert (no anchor, file button or Copy button)', streamState);
    const live = await cdp.evaluate(`(() => { const m = ${STREAM_MSG}; const s = Array.from(m.querySelectorAll('span')).find((x) => x.textContent.trim() === 'Live link'); const r = s.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await rightClick(live);
    await new Promise((r) => setTimeout(r, 400));
    const streamMenu = await menuItems();
    check(streamMenu.length === 0, 'streaming: right-click on a link opens no Refract link menu', streamMenu);
    await shot('09-streaming.png');
    if (streamMenu.length) await closeMenu();
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    throw err;
  } finally {
    try {
      const failures = report.filter((r) => r.ok === false).map((r) => r.step);
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, dirty: dirtyLines.length > 0, failures, results: report }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write report.json: ${writeErr}`);
    }
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir, LOG);
    await safeRmSync(importSourceDir, LOG);
    await safeRmSync(repoDirBase, LOG);
    await safeRmSync(worktreesRootForCleanup, LOG);
    await safeRmSync(exeDir, LOG);
    await safeRmSync(launcherDir, LOG);
    await safeRmSync(shimDir, LOG);
  }

  const failed = report.filter((r) => r.ok === false);
  console.log(`${LOG}: ${report.length - failed.length}/${report.length} steps passed; evidence in ${SHOTS_DIR}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`${LOG}: FAILED`, err);
  process.exit(1);
});
