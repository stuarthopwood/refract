#!/usr/bin/env node
// Live CDP check for #471 composer slice (spec 062). Drives a REAL built Tauri debug exe over CDP
// against a fake `omp` and a fake `gh` (call logs are the proof neither real tool ran).
//
// Usage (after `pnpm exec tauri build --debug --no-bundle`, shared target dir set):
// CARGO_TARGET_DIR=<shared target dir> REFRACT_471_SHOTS_DIR=<dir> node scripts/verify-471-composer-menu.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { spawnSync_ } from './verify-1067-enter-queued-helpers.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';
import { buildFakeGh, makeFakeGithubRepo } from './verify-1121-pr-polish-fake-gh.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-471';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_471_SHOTS_DIR || path.join(tmpdir(), 'refract-471-shots');
const FIELD = `document.querySelector('[aria-label="Message"]')`;

async function main() {
  const head = gitHead(REPO_ROOT);
  const dirty = spawnSync_('git', ['-C', REPO_ROOT, 'status', '--porcelain']).stdout.split('\n').filter(Boolean);
  console.log(`${LOG}: git HEAD ${head}${dirty.length ? ` (DIRTY: ${dirty.length} path(s))` : ''}`);
  mkdirSync(SHOTS_DIR, { recursive: true });

  const report = [];
  const check = (ok, label, extra) => {
    report.push({ step: label, ok, ...(extra !== undefined ? { extra } : {}) });
    console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` ${JSON.stringify(extra ?? '')}`}`);
  };

  const mk = (n) => mkdtempSync(path.join(tmpdir(), `refract-471-${n}-`));
  const dataDir = mk('data');
  const importSourceDir = mk('import');
  const repoDir = makeFakeGithubRepo(mk('repo'));
  const exeDir = mk('exe');
  const launcherDir = mk('launcher');
  const shimDir = mk('shim');
  const ghDir = mk('gh');
  const ghConfigDir = mk('ghcfg');
  const ghLog = path.join(ghDir, 'gh-calls.log');
  const ompLog = path.join(shimDir, 'omp-calls.log');

  let child;
  let cdp;
  try {
    buildOmpShim(shimDir);
    buildFakeGh(ghDir);
    const logicPath = path.join(ghDir, 'fake-gh-logic.cjs');
    writeFileSync(
      logicPath,
      readFileSync(logicPath, 'utf8').replace("'use strict';", `'use strict';\nrequire('node:fs').appendFileSync(${JSON.stringify(ghLog)}, process.argv.slice(2).join(' ') + '\\n');`)
    );
    const launcherExe = buildLauncher(launcherDir);
    const exeInfo = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port,
      dataDir,
      pathPrepend: `${shimDir};${ghDir}`,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
        GH_CONFIG_DIR: ghConfigDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_DEBUG_LOG: ompLog
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`${LOG}: CDP target is not this run's process`);

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await addRepository(cdp, repoDir);
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`, { timeoutMs: 30_000, label: 'Repo added' });
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'New session dialog' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'Dialog closed' });
    await cdp.waitFor(`(() => { const el = ${FIELD}; return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Composer enabled' });

    const shot = (name) => cdp.screenshot(path.join(SHOTS_DIR, name));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const centre = (expr) => cdp.evaluate(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const mouse = (type, p, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, ...extra });
    const click = async (p, button = 'left') => {
      await mouse('mouseMoved', p);
      await mouse('mousePressed', p, { button, clickCount: 1 });
      await mouse('mouseReleased', p, { button, clickCount: 1 });
    };
    const key = async (k, code, vk, modifiers = 0) => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
    };
    const menuOpen = () => cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'menu open' });
    const LABEL = `((i) => { const s = i.querySelector('[data-slot="context-menu-shortcut"]'); return i.textContent.slice(0, i.textContent.length - (s ? s.textContent.length : 0)).trim(); })`;
    const menuItems = () => cdp.evaluate(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).map((i) => ({ t: ${LABEL}(i), disabled: i.hasAttribute('data-disabled') }))`);
    const names = (items) => items.map((i) => i.t);
    const isDisabled = (items, t) => items.find((i) => i.t === t)?.disabled;
    const clickItem = async (t) => click(await centre(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).find((i) => ${LABEL}(i) === ${JSON.stringify(t)})`));
    const select = (a, b) => cdp.evaluate(`(() => { const f = ${FIELD}; f.focus(); f.setSelectionRange(${a}, ${b}); return true; })()`);
    const value = () => cdp.evaluate(`${FIELD}.value`);
    const sel = () => cdp.evaluate(`[${FIELD}.selectionStart, ${FIELD}.selectionEnd]`);
    // OS-level clipboard access, so the real Tauri IPC is checked against what Windows holds.
    const ps = (command) => {
      for (let i = 0; i < 12; i++) {
        const r = spawnSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8' });
        if (r.status === 0) return r.stdout;
        lastPsError = r.stderr.trim();
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * (i + 1));
      }
      throw new Error(`clipboard still unavailable after retries: ${lastPsError}`);
    };
    let lastPsError = '';
    const clipboard = async () => ps(`$ErrorActionPreference='Stop'; Get-Clipboard -Raw`).replace(/\r?\n$/, '');
    // The text travels in an environment variable, so no quote character (curly ones included) can end a PowerShell literal.
    const setClipboard = async (t) => {
      for (let i = 0; i < 12; i++) {
        const r = spawnSync('powershell', ['-NoProfile', '-Command', `$ErrorActionPreference='Stop'; Set-Clipboard -Value $env:REFRACT_471_CLIP`], { encoding: 'utf8', env: { ...process.env, REFRACT_471_CLIP: t } });
        if (r.status === 0) return true;
        lastPsError = r.stderr.trim();
        await sleep(250 * (i + 1));
      }
      throw new Error(`clipboard still unavailable after retries: ${lastPsError}`);
    };
    const until = async (fn, label, timeoutMs = 8_000) => {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const got = await fn();
        if (got) return got;
        if (Date.now() > end) throw new Error(`${LOG}: timed out waiting for ${label}`);
        await sleep(50);
      }
    };
    const openMenu = async () => {
      // A right-click outside a selection moves the caret, so collapsed carets open via the keyboard.
      const [a, b] = await sel();
      if (a === b) await key('F10', 'F10', 121, 8);
      else await click(await cdp.evaluate(`(() => { const r = ${FIELD}.getBoundingClientRect(); return { x: r.x + 22, y: r.y + 16 }; })()`), 'right');

      await menuOpen();
      return menuItems();
    };

    await cdp.click(FIELD);
    await cdp.send('Input.insertText', { text: 'hello world' });
    await until(async () => (await value()) === 'hello world', 'typed text');

    // 1. Right-click with a selection: all five items, Cut/Copy enabled.
    await select(0, 5);
    let items = await openMenu();
    check(JSON.stringify(names(items)) === JSON.stringify(['Cut', 'Copy', 'Paste', 'Paste as plain text', 'Select all']), 'right-click menu items', items);
    check(!isDisabled(items, 'Cut') && !isDisabled(items, 'Copy') && !isDisabled(items, 'Paste') && !isDisabled(items, 'Select all'), 'all enabled with a selection', items);
    await shot('01-menu-with-selection.png');

    // 2. Copy puts exactly the selection on the OS clipboard; focus and selection return.
    await clickItem('Copy');
    await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'closed' });
    await until(async () => (await clipboard()) === 'hello', 'clipboard to hold the selection');
    check((await clipboard()) === 'hello', 'Copy writes the selection to the clipboard', await clipboard());
    check(await cdp.evaluate(`document.activeElement === ${FIELD}`), 'focus returns to the composer after the menu closes');
    check(JSON.stringify(await sel()) === '[0,5]', 'selection intact after Copy', await sel());

    // 3. No selection: Cut and Copy disabled.
    await select(11, 11);
    items = await openMenu();
    check(isDisabled(items, 'Cut') && isDisabled(items, 'Copy') && !isDisabled(items, 'Paste'), 'Cut and Copy disabled with no selection', items);
    await shot('02-menu-no-selection.png');
    await key('Escape', 'Escape', 27);
    await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'closed' });

    // 4. Cut removes the selection and clipboards it.
    await select(0, 6);
    await openMenu();
    await clickItem('Cut');
    await until(async () => (await value()) === 'world' && (await clipboard()) === 'hello ', 'Cut to finish');
    check((await value()) === 'world' && (await clipboard()) === 'hello ', 'Cut removes and clipboards the selection', { value: await value(), clip: await clipboard() });

    // 5. Paste at the caret, from a marker seeded straight into the OS clipboard.
    await setClipboard('marker-471 ');
    await select(5, 5);
    await openMenu();
    await clickItem('Paste');
    await until(async () => (await value()) === 'worldmarker-471 ', 'Paste to land');
    check((await value()) === 'worldmarker-471 ', 'Paste inserts the OS clipboard text at the caret', await value());

    // 6. Paste collapses a large block into a chip; Paste as plain text inserts it verbatim.
    const big = 'x'.repeat(900);
    await setClipboard(big);
    await cdp.evaluate(`(() => { const f = ${FIELD}; f.focus(); f.setSelectionRange(0, f.value.length); return true; })()`);
    await key('Delete', 'Delete', 46);
    await openMenu();
    await clickItem('Paste');
    await until(async () => (await value()).includes('(900 chars)'), 'chip label');
    const afterPaste = await value();
    check(afterPaste.length < 200 && afterPaste.includes('(900 chars)'), 'Paste runs the composer paste handler (large block becomes a chip label)', afterPaste.slice(0, 80));
    await shot('03-large-paste-chip.png');
    await cdp.evaluate(`(() => { const f = ${FIELD}; f.focus(); f.setSelectionRange(0, f.value.length); return true; })()`);
    await key('Delete', 'Delete', 46);
    await openMenu();
    await clickItem('Paste as plain text');
    await until(async () => (await value()) === big, 'literal paste');
    check((await value()) === big, 'Paste as plain text inserts the literal block, bypassing the handler', (await value()).length);

    // Over the 1 MB cap the IPC refuses; the draft stays as it was.
    ps(`$ErrorActionPreference='Stop'; Set-Clipboard -Value ('y' * 1200000)`);
    await cdp.evaluate(`(() => { const f = ${FIELD}; f.focus(); f.setSelectionRange(0, 0); return true; })()`);
    await key('F10', 'F10', 121, 8);
    await menuOpen();
    await clickItem('Paste as plain text');
    await until(() => cdp.evaluate(`document.body.textContent.includes('too large to paste')`), 'too-large notice');
    const tooLarge = await cdp.evaluate(`window.refract.clipboard.readText().then((r) => (r.ok ? 'ok' : r.error.code))`);
    check(tooLarge === 'clipboard-too-large' && (await value()) === big, 'Over 1 MB: the IPC returns clipboard-too-large and the draft is unchanged', { tooLarge, len: (await value()).length });

    // 7. Select all.
    await openMenu();
    await clickItem('Select all');
    await until(async () => { const s = await sel(); return s[0] === 0 && s[1] === big.length; }, 'select all');
    const all = await sel();
    check(all[0] === 0 && all[1] === big.length, 'Select all selects the whole draft', all);

    // 8. Keyboard: Shift+F10 and the Menu key open it; arrows move; Esc closes and returns focus.
    for (const [label, k, code, vk, mod] of [['Shift+F10', 'F10', 'F10', 121, 8], ['Menu key', 'ContextMenu', 'ContextMenu', 93, 0]]) {
      await select(0, 0);
      await key(k, code, vk, mod);
      await menuOpen().catch(() => {});
      items = await menuItems();
      check(items.length === 5, `${label} opens the menu`, items);
      if (label === 'Shift+F10') await shot('04-shift-f10.png');
      await key('ArrowDown', 'ArrowDown', 40);
      await key('ArrowDown', 'ArrowDown', 40);
      const focused = await cdp.evaluate(`document.activeElement ? document.activeElement.textContent.trim() : null`);
      check(typeof focused === 'string' && focused.length > 0 && focused !== big, `${label}: arrow keys move focus through items`, focused);
      await key('Escape', 'Escape', 27);
      await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'closed' });
      check(await cdp.evaluate(`document.activeElement === ${FIELD}`), `${label}: Esc closes and focus returns to the composer`);
    }

    // 9. Menu semantics and keyboard anchor (#1383).
    await cdp.evaluate(`window.__ctx = []; window.addEventListener('contextmenu', (e) => window.__ctx.push({ x: e.clientX, y: e.clientY }), true); true`);
    const closeMenu = async () => {
      await key('Escape', 'Escape', 27);
      await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'closed' });
    };
    const lastCtx = () => cdp.evaluate(`window.__ctx[window.__ctx.length - 1]`);
    const fieldGeo = () => cdp.evaluate(`(() => { const f = ${FIELD}; const r = f.getBoundingClientRect(); const s = getComputedStyle(f); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, lh: parseFloat(s.lineHeight) || 20, pt: parseFloat(s.paddingTop) }; })()`);
    await cdp.evaluate(`(() => { const f = ${FIELD}; f.focus(); f.setSelectionRange(0, f.value.length); return true; })()`);
    await key('Delete', 'Delete', 46);
    await cdp.send('Input.insertText', { text: 'first line\nsecond line\nthird line\nfourth line end' });
    await until(async () => (await value()).endsWith('fourth line end'), 'multi-line draft');
    const geo = await fieldGeo();
    await select(0, 0);
    await key('F10', 'F10', 121, 8);
    await menuOpen();
    const atStart = await lastCtx();
    items = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).map((i) => ({ keys: i.getAttribute('aria-keyshortcuts'), hidden: Array.from(i.querySelectorAll('[data-slot="context-menu-shortcut"]')).every((s) => s.getAttribute('aria-hidden') === 'true'), hasHint: !!i.querySelector('[data-slot="context-menu-shortcut"]'), text: i.textContent }))`);
    check(items.every((i) => i.keys && i.hidden), 'every item has aria-keyshortcuts and its hint text is aria-hidden', items);
    await closeMenu();
    const end = (await value()).length;
    await select(end, end);
    await key('F10', 'F10', 121, 8);
    await menuOpen();
    const atEnd = await lastCtx();
    await shot('05-menu-at-caret-end.png');
    await closeMenu();
    check(atStart.x >= geo.left && atStart.x <= geo.right && Math.abs(atStart.y - (geo.top + geo.pt + geo.lh)) <= geo.lh, 'keyboard menu anchors under the caret at the start of the draft', { atStart, geo });
    check(atEnd.y - atStart.y >= geo.lh * 2.5 && atEnd.x > atStart.x, 'keyboard menu follows the caret to the end of a multi-line draft', { atStart, atEnd, geo });
    const rowBtn = await cdp.evaluate(`(() => { const b = document.querySelector('[data-repository-id] li button'); if (!b) return null; const r = b.getBoundingClientRect(); return { left: r.left, bottom: r.bottom }; })()`);
    if (rowBtn) {
      await cdp.evaluate(`document.querySelector('[data-repository-id] li button').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }))`);
      await menuOpen();
      const onElement = await lastCtx();
      await closeMenu();
      check(Math.abs(onElement.x - rowBtn.left) <= 1 && Math.abs(onElement.y - rowBtn.bottom) <= 1, 'keyboard menu on a non-text element anchors at its bottom-left corner', { onElement, rowBtn });
    } else check(false, 'session row button exists for the non-text anchor check');

    // Item 4: the hint on "Paste as plain text" is shown only if the real chord inserts the literal text.
    const bigChord = 'z'.repeat(900);
    await setClipboard(bigChord);
    await cdp.evaluate(`(() => { const f = ${FIELD}; f.focus(); f.setSelectionRange(0, f.value.length); return true; })()`);
    await key('Delete', 'Delete', 46);
    // CDP sends no editing commands on its own; Blink's keymap turns Ctrl+Shift+V into pasteAndMatchStyle.
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 10, commands: ['pasteAndMatchStyle'] });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 10 });
    const chordLiteral = await until(async () => (await value()) === bigChord, 'chord result', 2_500).catch((e) => { if (/timed out/i.test(String(e?.message))) return false; throw e; });
    const chordValue = (await value()).slice(0, 60);
    const hintShown = items.some((i) => i.text.includes('Paste as plain text') && i.text.includes('Ctrl+Shift+V'));
    check(!hintShown, `Ctrl+Shift+V hint stays absent (chord pastes literal text: ${Boolean(chordLiteral)})`, { chordValue: chordValue.slice(0, 60) });

    // Item 5: hint-text contrast in every built-in theme (no light theme ships; these are the five presets).
    await cdp.evaluate(`(() => { const f = ${FIELD}; f.focus(); f.setSelectionRange(0, f.value.length); return true; })()`);
    await key('Delete', 'Delete', 46);
    await cdp.send('Input.insertText', { text: 'hello world' });
    await until(async () => (await value()) === 'hello world', 'short draft');
    for (const cls of ['theme-dark', 'theme-obsidian', 'theme-dark-high-contrast', 'theme-nordic-frost', 'theme-cyber-amber']) {
      await cdp.evaluate(`(() => { const r = document.documentElement; Array.from(r.classList).filter((c) => c.startsWith('theme-')).forEach((c) => r.classList.remove(c)); r.classList.add(${JSON.stringify(cls)}); })()`);
      await select(0, 5);
      await key('F10', 'F10', 121, 8);
      await menuOpen();
      const ratio = await cdp.evaluate(`(() => {
        const cx = document.createElement('canvas'); cx.width = cx.height = 1;
        const g2 = cx.getContext('2d', { willReadFrequently: true });
        const parse = (c) => { if (!CSS.supports('color', c)) throw new Error('unparseable colour ' + c); g2.clearRect(0, 0, 1, 1); g2.fillStyle = '#000'; g2.fillStyle = c; g2.fillRect(0, 0, 1, 1); const d = g2.getImageData(0, 0, 1, 1).data; return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }; };
        const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
        const lum = (c) => { const ch = [c.r, c.g, c.b].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]; };
        const page = parse(getComputedStyle(document.body).backgroundColor);
        const menu = over(parse(getComputedStyle(document.querySelector('[role="menu"]')).backgroundColor), over(page, { r: 0, g: 0, b: 0, a: 1 }));
        return Array.from(document.querySelectorAll('[role="menu"] [data-slot="context-menu-shortcut"]')).map((s) => { const fg = over(parse(getComputedStyle(s).color), menu); const [hi, lo] = [lum(fg), lum(menu)].sort((a, b) => b - a); return (hi + 0.05) / (lo + 0.05); });
      })()`);
      await shot(`06-menu-${cls}.png`);
      await closeMenu();
      check(ratio.length > 0 && ratio.every((r) => r >= 4.5), `${cls}: hint text contrast is at least 4.5:1`, ratio.map((r) => Number(r.toFixed(2))));
    }

    // 10. Fake tools: the logs prove neither the real omp nor the real gh ran.
    const ghCalls = existsSync(ghLog) ? readFileSync(ghLog, 'utf8').split('\n').filter(Boolean) : [];
    const ompCalls = existsSync(ompLog) ? readFileSync(ompLog, 'utf8').split('\n').filter(Boolean) : [];
    writeFileSync(path.join(SHOTS_DIR, 'fake-gh-calls.log'), ghCalls.join('\n'));
    writeFileSync(path.join(SHOTS_DIR, 'fake-omp-calls.log'), ompCalls.join('\n'));
    check(ompCalls.length > 0, `fake omp was launched (${ompCalls.length} log lines)`, ompCalls.slice(0, 3));
    check(ghCalls.length > 0, `fake gh was launched (${ghCalls.length} calls)`, ghCalls.slice(0, 3));
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    throw err;
  } finally {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, dirty: dirty.length > 0, failures: report.filter((r) => r.ok === false).map((r) => r.step), results: report }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write report.json: ${writeErr}`);
    }
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    for (const d of [dataDir, importSourceDir, repoDir, exeDir, launcherDir, shimDir, ghDir, ghConfigDir]) await safeRmSync(d, LOG);
  }

  const failed = report.filter((r) => r.ok === false);
  console.log(`${LOG}: ${report.length - failed.length}/${report.length} steps passed; evidence in ${SHOTS_DIR}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`${LOG}: FAILED`, err);
  process.exit(1);
});
