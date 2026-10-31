#!/usr/bin/env node
// Live CDP check for spec 076 (#1461 shared dialogs, #1454 transcript menus) against a real built Tauri debug exe
// with fake `omp` (tape: transcript-menus-065), a scratch REFRACT_DATA_DIR and its own debugging port.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_076_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-076.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
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
const LOG = 'verify-076';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_076_SHOTS_DIR || path.join(tmpdir(), 'refract-076-shots');
const FIELD = `document.querySelector('[aria-label="Message"]')`;
const ASSISTANT_P = `Array.from(document.querySelectorAll('p')).find((p) => p.textContent.includes('reply'))`;
const MENU_ITEMS = `Array.from(document.querySelectorAll('[role="menu"] [role^="menuitem"]')).map((i) => i.textContent.trim())`;

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const report = [];
  const check = (ok, label, extra) => {
    report.push({ step: label, ok, ...(extra !== undefined ? { extra } : {}) });
    console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` ${JSON.stringify(extra ?? '')}`}`);
  };
  const mk = (n) => mkdtempSync(path.join(tmpdir(), `refract-076-${n}-`));
  const dirs = { data: mk('data'), imp: mk('import'), repo: makeFakeGithubRepo(mk('repo')), exe: mk('exe'), launcher: mk('launcher'), shim: mk('shim') };
  let child;
  let cdp;
  try {
    buildOmpShim(dirs.shim);
    const launcherExe = buildLauncher(dirs.launcher);
    const exeInfo = buildAndCopyExeFresh(dirs.exe, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port,
      dataDir: dirs.data,
      pathPrepend: dirs.shim,
      logFile: path.join(dirs.exe, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: dirs.imp,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'transcript-menus-065'
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`${LOG}: CDP target is not this run's process`);

    const shot = (name) => cdp.screenshot(path.join(SHOTS_DIR, name));
    const waitFor = (expr, label, timeoutMs = 10_000) => cdp.waitFor(expr, { timeoutMs, label });
    const centre = (expr) => cdp.evaluate(`(() => { const el = (${expr}); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
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
    const menuOpen = () => waitFor(`!!document.querySelector('[role="menu"]')`, 'menu open');
    const closeMenu = async () => {
      await key('Escape', 'Escape', 27);
      await waitFor(`!document.querySelector('[role="menu"]')`, 'menu closed');
    };
    const ps = (command) => {
      const r = spawnSync('powershell', ['-NoProfile', '-STA', '-Command', command], { encoding: 'utf8' });
      return r.status === 0 ? r.stdout : `ERR ${r.stderr}`;
    };
    // Another process can hold the Windows clipboard for a moment; retry the read.
    const clipText = () => {
      let out = ''
      for (let i = 0; i < 10; i += 1) {
        out = ps(`$ErrorActionPreference='Stop'; Get-Clipboard -Raw`)
        if (!out.startsWith('ERR')) break
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
      }
      return out.replace(/\r?\n$/, '')
    };
    const hasIcons = () => cdp.evaluate(`Array.from(document.querySelectorAll('[role="menu"] [role^="menuitem"]')).every((i) => !!i.querySelector('svg'))`);
    const hoverReveal = async (expr) => {
      await mouse('mouseMoved', await centre(expr));
      await waitFor(`(() => { const b = (${expr}); return !!b && getComputedStyle(b).opacity === '1'; })()`, 'revealed on hover', 5_000);
    };

    await waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, 'Readiness green', 90_000);
    await addRepository(cdp, dirs.repo);
    await waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`, 'Repo added', 30_000);
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, 'New session dialog', 15_000);
    await cdp.clickByText('Create session', { inDialog: true });
    await waitFor(`!document.querySelector('[role="dialog"]')`, 'Dialog closed', 15_000);
    await waitFor(`(() => { const el = ${FIELD}; return !!el && !el.disabled; })()`, 'Composer enabled', 60_000);

    await cdp.click(FIELD);
    await cdp.send('Input.insertText', { text: 'hello transcript 076' });
    await key('Enter', 'Enter', 13);
    await waitFor(`!!(${ASSISTANT_P})`, 'streaming reply visible', 60_000);
    await waitFor(`!!document.querySelector('.not-prose')`, 'final reply rendered', 60_000);

    // Message row: controls are lazy, then Copy plus the kebab; kebab items equal the right-click items.
    const msgKebab = `Array.from(document.querySelectorAll('button[aria-label="More actions"], button[aria-label^="More actions,"]')).filter((b) => !b.closest('.not-prose, [data-slot="collapsible"]')).pop()`;
    await shot('00-message-before-arm.png');
    await mouse('mouseMoved', await centre(ASSISTANT_P));
    await waitFor(`!!(${msgKebab})`, 'message kebab mounted on hover');
    await hoverReveal(msgKebab);
    await shot('01-message-kebab-hover.png');
    await click(await centre(msgKebab));
    await menuOpen();
    const kebabItems = await cdp.evaluate(MENU_ITEMS);
    check(kebabItems.includes('Copy') && kebabItems.includes('Copy as plain text'), 'message kebab opens the menu with Copy items', kebabItems);
    check(await hasIcons(), 'message kebab menu: every item has an icon');
    await shot('02-message-kebab-menu.png');
    await closeMenu();
    await waitFor(`document.activeElement?.getAttribute('aria-label')?.startsWith('More actions') === true`, 'Esc returns focus to the kebab');
    await click(await centre(ASSISTANT_P), 'right');
    await menuOpen();
    const rightItems = await cdp.evaluate(MENU_ITEMS);
    check(rightItems.filter((t) => !t.startsWith('Copy selection')).join('|') === kebabItems.join('|'), 'right-click menu has the same items as the kebab', { kebabItems, rightItems });
    await closeMenu();

    // Unified copy feedback: the menu Copy shows the same toast wording as the inline button.
    await click(await centre(msgKebab));
    await menuOpen();
    await click(await centre(`Array.from(document.querySelectorAll('[role="menu"] [role^="menuitem"]')).find((i) => i.textContent.trim() === 'Copy')`));
    await waitFor(`!!document.querySelector('[data-sonner-toast]')`, 'copy toast', 5_000);
    check(clipText().includes('**reply**'), 'menu Copy puts the Markdown source on the clipboard', clipText().slice(0, 80));
    await shot('03-copy-toast.png');

    // Code block: header kebab last, always visible, labelled with the language.
    const codeWrap = `Array.from(document.querySelectorAll('.not-prose')).find((b) => b.textContent.includes('const greeting'))`;
    const codeKebab = `(${codeWrap}).querySelector('button[aria-label^="More actions"]')`;
    check(await cdp.evaluate(`getComputedStyle(${codeKebab}).opacity === '1'`), 'code block kebab is always visible');
    await click(await centre(codeKebab));
    await menuOpen();
    const codeItems = await cdp.evaluate(MENU_ITEMS);
    check(codeItems.includes('Copy code') && codeItems.some((t) => t.startsWith('Wrap lines')), 'code kebab: Copy code and Wrap lines', codeItems);
    await shot('04-code-kebab-menu.png');
    await closeMenu();

    // Tool row: kebab revealed on hover/focus, never mounted while running.
    const toolKebab = `Array.from(document.querySelectorAll('button[aria-label^="More actions,"]')).find((b) => b.closest('[data-slot="collapsible"]'))`;
    const toolRow = `Array.from(document.querySelectorAll('button, [role="button"]')).find((b) => b.textContent.includes('echo menu-output-065'))`;
    await mouse('mouseMoved', await centre(toolRow));
    await waitFor(`!!(${toolKebab})`, 'tool row kebab mounted');
    await click(await centre(toolKebab));
    await menuOpen();
    const toolItems = await cdp.evaluate(MENU_ITEMS);
    check(toolItems.includes('Copy command'), 'tool row kebab: Copy command', toolItems);
    await shot('05-tool-kebab-menu.png');
    await closeMenu();

    // Mermaid: Save image goes through the moved image_save command; the native dialog opens and is cancelled via UI Automation.
    const diagram = `Array.from(document.querySelectorAll('img')).find((i) => (i.getAttribute('alt') || i.getAttribute('aria-label') || '').toLowerCase().includes('diagram'))`;
    await waitFor(`!!(${diagram})`, 'mermaid rendered', 30_000);
    await click(await centre(diagram), 'right');
    await menuOpen();
    const mItems = await cdp.evaluate(MENU_ITEMS);
    check(['Copy source', 'Copy as image', 'Save image'].every((t) => mItems.some((m) => m.startsWith(t))), 'mermaid menu items', mItems);
    await shot('06-mermaid-menu.png');
    await click(await centre(`Array.from(document.querySelectorAll('[role="menu"] [role^="menuitem"]')).find((i) => i.textContent.trim().startsWith('Save image'))`));
    const dialog = ps(`$ErrorActionPreference='Stop'; Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$root=[Windows.Automation.AutomationElement]::RootElement
$win=$null
for($i=0;$i -lt 30 -and -not $win;$i++){
  $kids=$root.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
  foreach($k in $kids){ if($k.Current.Name -like 'Save*' -and $k.Current.ProcessId -eq ${launched.targetPid}){ $win=$k; break } }
  if(-not $win){ Start-Sleep -Milliseconds 500 }
}
if(-not $win){ 'NODIALOG'; exit 0 }
$cancel=$win.FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty,'2')))
if(-not $cancel){ 'NOCANCEL'; exit 0 }
$cancel.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
'OPENED'`);
    check(dialog.includes('OPENED'), 'Save image: native Save dialog opened and was cancelled via UI Automation', dialog.trim());

    // DeleteDialog on the shared ConfirmAlertDialog: alertdialog, Cancel autofocused, Cancel closes it.
    const actions = `Array.from(document.querySelectorAll('button[aria-label$=" actions"]')).find((b) => !b.getAttribute('aria-label').startsWith('Project actions'))`;
    await click(await centre(actions));
    await menuOpen();
    await click(await centre(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).find((i) => i.textContent.trim() === 'Delete…')`));
    await waitFor(`!!document.querySelector('[data-slot="alert-dialog-content"]')`, 'Delete dialog open');
    await waitFor(`document.activeElement?.textContent.trim() === 'Cancel'`, 'Delete dialog autofocuses Cancel');
    const del = await cdp.evaluate(`(() => { const d = document.querySelector('[data-slot="alert-dialog-content"]'); return { role: d.getAttribute('role'), buttons: Array.from(d.querySelectorAll('button')).map((b) => b.textContent.trim()), focus: document.activeElement?.textContent.trim(), alerts: d.querySelectorAll('[role="alert"]').length }; })()`);
    check(del.role === 'alertdialog' && del.buttons.includes('Cancel') && del.buttons.includes('Delete'), 'Delete dialog is the shared alertdialog with Cancel and Delete', del);
    check(del.focus === 'Cancel', 'Delete dialog autofocuses Cancel', del.focus);
    check(del.alerts === 1, 'Delete dialog error line is always mounted as one role=alert', del.alerts);
    await shot('07-delete-dialog.png');
    await cdp.click(`Array.from(document.querySelectorAll('[data-slot="alert-dialog-content"] button')).find((b) => b.textContent.trim() === 'Cancel')`);
    await waitFor(`!document.querySelector('[data-slot="alert-dialog-content"]')`, 'Delete dialog closed by Cancel');
    await shot('08-after-cancel.png');
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    try { await cdp.screenshot(path.join(SHOTS_DIR, 'error.png')); } catch {}
    throw err;
  } finally {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHead(REPO_ROOT), failures: report.filter((r) => r.ok === false).map((r) => r.step), results: report }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write report.json: ${writeErr}`);
    }
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    for (const d of Object.values(dirs)) await safeRmSync(d, LOG);
  }
  const failed = report.filter((r) => r.ok === false);
  console.log(`${LOG}: ${report.length - failed.length}/${report.length} steps passed; evidence in ${SHOTS_DIR}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`${LOG}: FAILED`, err);
  process.exit(1);
});
