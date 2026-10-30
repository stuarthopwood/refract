#!/usr/bin/env node
// Live CDP check for #471's transcript group (spec 065). Drives a REAL built Tauri debug exe over CDP
// against a fake `omp` tape with a tool row, a code block and a Mermaid diagram.
//
// Usage (after `pnpm exec tauri build --debug --no-bundle`, shared target dir set):
// CARGO_TARGET_DIR=<shared target dir> REFRACT_065_SHOTS_DIR=<dir> node scripts/verify-065-transcript-menus.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';
import { makeFakeGithubRepo } from './verify-1121-pr-polish-fake-gh.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-065';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_065_SHOTS_DIR || path.join(tmpdir(), 'refract-065-shots');
const FIELD = `document.querySelector('[aria-label="Message"]')`;
const PROMPT = 'hello transcript 065';

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const report = [];
  const check = (ok, label, extra) => {
    report.push({ step: label, ok, ...(extra !== undefined ? { extra } : {}) });
    console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` ${JSON.stringify(extra ?? '')}`}`);
  };
  const mk = (n) => mkdtempSync(path.join(tmpdir(), `refract-065-${n}-`));
  const dataDir = mk('data');
  const importSourceDir = mk('import');
  const repoDir = makeFakeGithubRepo(mk('repo'));
  const exeDir = mk('exe');
  const launcherDir = mk('launcher');
  const shimDir = mk('shim');
  const saveDir = mk('save');
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
        REFRACT_FAKE_OMP_SCENARIO: 'transcript-menus-065'
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`${LOG}: CDP target is not this run's process`);

    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 90_000, label: 'Readiness green' });
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
    const menuItems = () => cdp.evaluate(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemcheckbox"]')).map((i) => i.textContent.trim())`);
    const menuCount = () => cdp.evaluate(`document.querySelectorAll('[role="menu"]').length`);
    const menuHasIcons = () => cdp.evaluate(`Array.from(document.querySelectorAll('[role="menu"] [role^="menuitem"]')).every((i) => !!i.querySelector('svg'))`);
    const clickItem = async (t) => click(await centre(`Array.from(document.querySelectorAll('[role="menu"] [role^="menuitem"]')).find((i) => i.textContent.trim().startsWith(${JSON.stringify(t)}))`));
    const closeMenu = async () => {
      await key('Escape', 'Escape', 27);
      await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'menu closed' });
    };
    const ps = (command) => {
      const r = spawnSync('powershell', ['-NoProfile', '-STA', '-Command', command], { encoding: 'utf8' });
      return r.status === 0 ? r.stdout : `ERR ${r.stderr}`;
    };
    const clipText = () => ps(`$ErrorActionPreference='Stop'; Get-Clipboard -Raw`).replace(/\r?\n$/, '');
    const clearClip = () => ps(`Set-Clipboard -Value 'cleared'`);
    const clipImage = () => ps(`Add-Type -AssemblyName System.Windows.Forms; $i=[System.Windows.Forms.Clipboard]::GetImage(); if($i){ "$($i.Width)x$($i.Height)" } else { 'none' }`).trim();
    const at = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
    const ASSISTANT_P = `Array.from(document.querySelectorAll('p')).find((p) => p.textContent.includes('reply'))`;

    // Send the prompt; the tape streams the reply for ~9 s.
    await cdp.click(FIELD);
    await cdp.send('Input.insertText', { text: PROMPT });
    await key('Enter', 'Enter', 13);
    await cdp.waitFor(`!!(${ASSISTANT_P})`, { timeoutMs: 60_000, label: 'streaming reply visible' });

    // Streaming: no ghost Copy and no menu.
    const streamingCopy = await cdp.evaluate(`document.querySelectorAll('[aria-label="Copy message"]').length`);
    await click(await centre(ASSISTANT_P), 'right');
    await sleep(400);
    check(streamingCopy === 0, 'streaming: no ghost Copy button', streamingCopy);
    check((await menuCount()) === 0, 'streaming: right-click opens no Refract menu', await menuItems());
    await shot('01-streaming-no-menu.png');
    if ((await menuCount()) > 0) await closeMenu();

    await cdp.waitFor(`!!document.querySelector('.not-prose')`, { timeoutMs: 60_000, label: 'final reply rendered' });
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('img')).find((i) => (i.getAttribute('alt') || i.getAttribute('aria-label') || '').toLowerCase().includes('diagram'))`, { timeoutMs: 30_000, label: 'mermaid rendered' }).catch(() => {});
    await sleep(800);
    await shot('02-finished.png');

    // Message menu: items, icons, clipboard.
    await click(await centre(ASSISTANT_P), 'right');
    await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'message menu' });
    const msgItems = await menuItems();
    check(msgItems.join('|').startsWith('Copy|Copy as plain text'), 'message menu: Copy, Copy as plain text first', msgItems);
    check(msgItems.includes('Scroll to your message'), 'message menu: Scroll to your message on agent reply', msgItems);
    check(await menuHasIcons(), 'message menu: every item has an icon');
    await shot('03-message-menu.png');
    clearClip();
    await clickItem('Copy as plain text');
    await sleep(500);
    const plain = clipText();
    check(plain.includes('Final reply with a snippet') && !plain.includes('**'), 'Copy as plain text: clipboard has no Markdown markers', plain.slice(0, 120));
    await click(await centre(ASSISTANT_P), 'right');
    await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'message menu 2' });
    clearClip();
    await clickItem('Copy');
    await sleep(500);
    const md = clipText();
    check(md.includes('**reply**') && md.includes('```javascript'), 'Copy: clipboard holds the Markdown source', md.slice(0, 120));

    // Ghost Copy on hover.
    await mouse('mouseMoved', await centre(ASSISTANT_P));
    await sleep(300);
    const ghostOpacity = await cdp.evaluate(`(() => { const b = Array.from(document.querySelectorAll('[aria-label="Copy message"]')).pop(); return b ? getComputedStyle(b).opacity : null; })()`);
    check(ghostOpacity === '1', 'ghost Copy button visible on hover', ghostOpacity);
    await shot('04-ghost-copy-hover.png');

    // Copy selection first.
    await cdp.evaluate(`(() => { const p = ${ASSISTANT_P}; const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; })()`);
    await click(await centre(ASSISTANT_P), 'right');
    await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'selection menu' });
    const selItems = await menuItems();
    check(selItems[0] === 'Copy selection', 'with a selection, Copy selection is first', selItems);
    await shot('05-copy-selection-first.png');
    await closeMenu();
    await cdp.evaluate(`getSelection().removeAllRanges()`);

    // Scroll to your message.
    await click(await centre(ASSISTANT_P), 'right');
    await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'menu for scroll' });
    await clickItem('Scroll to your message');
    await sleep(800);
    check(await cdp.evaluate(`!document.querySelector('[role="menu"]')`), 'Scroll to your message closes the menu');
    await shot('06-scrolled-to-prompt.png');

    // Keyboard: Tab to the ghost Copy button, Shift+F10 opens the menu, Esc returns focus.
    await cdp.evaluate(`(() => { const b = Array.from(document.querySelectorAll('[aria-label="Copy message"]')).pop(); b.focus(); return true; })()`);
    await key('F10', 'F10', 121, 8);
    await sleep(600);
    const kbMenu = await menuCount();
    check(kbMenu === 1, 'Shift+F10 on the ghost Copy button opens the message menu', kbMenu);
    await shot('07-keyboard-menu.png');
    if (kbMenu) {
      await closeMenu();
      check(await cdp.evaluate(`document.activeElement?.getAttribute('aria-label') === 'Copy message'`), 'Esc returns focus to the ghost Copy button');
    }
    await cdp.evaluate(`(() => { const b = Array.from(document.querySelectorAll('[aria-label="Copy message"]')).pop(); b.focus(); return true; })()`);
    await key('ContextMenu', 'ContextMenu', 93);
    await sleep(600);
    check((await menuCount()) === 1, 'Menu key opens the message menu', await menuCount());
    if (await menuCount()) await closeMenu();

    // Code block: Wrap toggle, menu.
    const codeWrap = `document.querySelector('.not-prose')`;
    const wrapBtn = `Array.from(document.querySelectorAll('[aria-label^="Wrap lines"]')).pop()`;
    const preWs = () => cdp.evaluate(`(() => { const pre = ${codeWrap}.querySelector('pre'); return getComputedStyle(pre).whiteSpace; })()`);
    const before = await preWs();
    await click(await centre(wrapBtn));
    await sleep(300);
    const after = await preWs();
    check(before !== after && after.startsWith('pre-wrap'), 'Wrap button toggles line wrapping', { before, after });
    await shot('08-code-wrapped.png');
    await click(await centre(codeWrap), 'right');
    await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'code menu' });
    const codeItems = await menuItems();
    check(codeItems.includes('Copy code') && codeItems.some((t) => t.startsWith('Wrap lines')), 'code menu: Copy code and Wrap lines', codeItems);
    check(await menuHasIcons(), 'code menu: every item has an icon');
    await shot('09-code-menu.png');
    clearClip();
    await clickItem('Copy code');
    await sleep(500);
    check(clipText().includes('const greeting'), 'Copy code: clipboard holds the code', clipText().slice(0, 80));

    // Tool row menu.
    const toolRow = `Array.from(document.querySelectorAll('button, [role="button"]')).find((b) => b.textContent.includes('echo menu-output-065') || b.textContent.includes('Echoing'))`;
    if (await cdp.evaluate(`!!(${toolRow})`)) {
      await click(await centre(toolRow), 'right');
      await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'tool menu' });
      const toolItems = await menuItems();
      check(toolItems.includes('Copy command') && toolItems.some((t) => t === 'Expand' || t === 'Collapse'), 'tool row menu: Copy command and Expand', toolItems);
      check(await menuHasIcons(), 'tool row menu: every item has an icon');
      await shot('10-tool-menu.png');
      clearClip();
      await clickItem('Copy command');
      await sleep(500);
      check(clipText().includes('echo menu-output-065'), 'Copy command: clipboard holds the command', clipText());
    } else {
      check(false, 'tool row found');
    }

    // Mermaid.
    const diagram = `Array.from(document.querySelectorAll('img')).find((i) => (i.getAttribute('alt') || '').toLowerCase().includes('diagram') || (i.getAttribute('aria-label') || '').toLowerCase().includes('diagram'))`;
    if (await cdp.evaluate(`!!(${diagram})`)) {
      await cdp.evaluate(`${diagram}.scrollIntoView({block:'center'})`);
      await sleep(400);
      await shot('11-mermaid.png');
      await click(await centre(diagram), 'right');
      await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'mermaid menu' });
      const mItems = await menuItems();
      check(['Copy source', 'Copy as image', 'Save image'].every((t) => mItems.some((m) => m.startsWith(t))), 'mermaid menu: Copy source, Copy as image, Save image', mItems);
      check(await menuHasIcons(), 'mermaid menu: every item has an icon');
      await shot('12-mermaid-menu.png');
      clearClip();
      await clickItem('Copy as image');
      await sleep(1500);
      const img = clipImage();
      check(img !== 'none' && img !== '' && !img.startsWith('ERR'), 'Copy as image: clipboard holds a bitmap', img);

      // Save image: drive the native Save dialog by keyboard.
      const target = path.join(saveDir, 'diagram-065.png');
      await click(await centre(diagram), 'right');
      await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 5_000, label: 'mermaid menu 2' });
      await clickItem('Save image');
      await sleep(2500);
      ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${target.replace(/[+^%~(){}[\]]/g, '{$&}')}'); Start-Sleep -Milliseconds 400; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')`);
      await sleep(2500);
      const saved = existsSync(target) ? readFileSync(target) : null;
      check(!!saved && saved.subarray(1, 4).toString() === 'PNG', 'Save image: a PNG file was written', saved ? saved.length : 'missing');
      await shot('13-mermaid-saved.png');
    } else {
      check(false, 'mermaid diagram found');
    }
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    throw err;
  } finally {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHead(REPO_ROOT), failures: report.filter((r) => r.ok === false).map((r) => r.step), results: report }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write report.json: ${writeErr}`);
    }
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    for (const d of [dataDir, importSourceDir, repoDir, exeDir, launcherDir, shimDir, saveDir]) await safeRmSync(d, LOG);
  }
  const failed = report.filter((r) => r.ok === false);
  console.log(`${LOG}: ${report.length - failed.length}/${report.length} steps passed; evidence in ${SHOTS_DIR}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`${LOG}: FAILED`, err);
  process.exit(1);
});
