#!/usr/bin/env node
// Live CDP check for spec 086 (#1485, #1491): theme rows, the profile Theme submenu and PR check rows on RowKebabMenu, in two built-in themes, on a built Tauri debug exe with fake `omp` and `gh`.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_086_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-086.mjs

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { addRepository, rightClick, pressEscape } from './verify-tauri-session-list-helpers.mjs';
import { openThemeSubmenu, closeAllMenus } from './verify-1043-theme-radio-helpers.mjs';
import { buildFakeGh, makeFakeGithubRepo } from './verify-1121-pr-polish-fake-gh.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-086';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_086_SHOTS_DIR || path.join(tmpdir(), 'refract-086-shots');
const SHOT_FILES = ['appearance-dark.png', 'appearance-obsidian.png', 'profile-dark.png', 'profile-obsidian.png', 'checks-dark.png', 'checks-obsidian.png', 'appearance-after-remove.png', 'failure.png', 'report.json'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CUSTOM = { version: 1, name: 'Per Element', base: 'dark', tokens: { 'scrollbar-thumb': '#00c853' } };
const radio = (name) => `Array.from(document.querySelectorAll('[role="radio"]')).find((el) => el.textContent.trim().startsWith(${JSON.stringify(name)}))`;
const CHECK_ROW = (name) => `Array.from(document.querySelectorAll('section[aria-label="Checks"] li')).find((li) => li.textContent.includes(${JSON.stringify(name)}))`;
const kebab = (label) => `document.querySelector('[aria-label=${JSON.stringify(label)}]')`;

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  for (const name of SHOT_FILES) rmSync(path.join(SHOTS_DIR, name), { force: true });
  const report = [];
  const check = (ok, label, extra) => {
    report.push({ step: label, ok, ...(extra !== undefined ? { extra } : {}) });
    console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` ${JSON.stringify(extra ?? '')}`}`);
  };
  const mk = (n) => mkdtempSync(path.join(tmpdir(), `refract-086-${n}-`));
  const dirs = { data: mk('data'), imp: mk('import'), repo: makeFakeGithubRepo(mk('repo')), exe: mk('exe'), launcher: mk('launcher'), shim: mk('shim'), gh: mk('gh'), ghConfig: mk('ghcfg') };
  let child;
  let cdp;
  try {
    mkdirSync(path.join(dirs.data, 'themes'));
    writeFileSync(path.join(dirs.data, 'themes', 'per-element.json'), JSON.stringify(CUSTOM));
    buildOmpShim(dirs.shim);
    buildFakeGh(dirs.gh);
    const launcherExe = buildLauncher(dirs.launcher);
    const exeInfo = buildAndCopyExeFresh(dirs.exe, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exeInfo.dest, {
      port,
      dataDir: dirs.data,
      pathPrepend: `${dirs.shim};${dirs.gh}`,
      logFile: path.join(dirs.exe, 'app.log'),
      extraEnv: { REFRACT_IMPORT_SOURCE_DIR: dirs.imp, GH_CONFIG_DIR: dirs.ghConfig, REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'), REFRACT_FAKE_OMP_NODE: process.execPath }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`${LOG}: CDP target is not this run's process`);
    const waitFor = (expr, label, timeoutMs = 15_000) => cdp.waitFor(expr, { timeoutMs, label });
    const shot = (name) => cdp.screenshot(path.join(SHOTS_DIR, name));
    const openAppearance = async () => {
      await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
      await waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, 'Settings opened');
      await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Appearance')`);
      await waitFor(`!!${radio('Dark')}`, 'Appearance listed');
    };
    const backToChat = async () => {
      await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
      await waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, 'Settings closed');
    };

    await waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, 'Readiness green', 90_000);
    await addRepository(cdp, dirs.repo);

    for (const [name, slug] of [['Dark', 'dark'], ['Obsidian', 'obsidian']]) {
      await openAppearance();
      await cdp.click(radio(name));
      await waitFor(`${radio(name)}?.getAttribute('aria-checked') === 'true'`, `${name} checked`);
      await sleep(300);
      const rows = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="radio"]')).map((el) => el.textContent.trim().slice(0, 24))`);
      const kebabs = await cdp.evaluate(`document.querySelectorAll('[aria-label^="Actions for "]').length`);
      check(kebabs >= 6 && rows.some((r) => r.startsWith('Per Element')), `${name}: Appearance lists built-ins and the custom theme, each row with an actions menu`, { rows, kebabs });
      await shot(`appearance-${slug}.png`);
      await backToChat();

      await openThemeSubmenu(cdp);
      const radios = await cdp.evaluate(`document.querySelectorAll('[role="menuitemradio"]').length`);
      check(radios >= 6, `${name}: profile Theme submenu lists the same entries (shared hook)`, radios);
      await shot(`profile-${slug}.png`);
      await closeAllMenus(cdp);

      await cdp.clickByText('Pull requests');
      await waitFor(`document.querySelectorAll('[data-pr-row]').length > 0`, 'PR rows', 30_000);
      await cdp.click(`document.querySelector('[data-pr-row][data-pr-number="1"]')`);
      await waitFor(`!!document.querySelector('section[aria-label="Checks"]')`, 'Checks section', 30_000);
      if (!(await cdp.evaluate(`!!(${CHECK_ROW('build')})`))) {
        await cdp.click(`Array.from(document.querySelectorAll('section[aria-label="Checks"] button')).find((b) => /Successful/.test(b.textContent))`);
      }
      await waitFor(`!!(${CHECK_ROW('build')})`, 'Checks section with rows', 15_000);
      await shot(`checks-${slug}.png`);
      if (slug === 'dark') {
        await rightClick(cdp, CHECK_ROW('build'));
        await waitFor(`!!document.querySelector('[role="menu"] a[href]')`, 'context menu with a link entry');
        const href = await cdp.evaluate(`document.querySelector('[role="menu"] a[href]').getAttribute('href')`);
        check(/^https:\/\//.test(href), 'right-click on a check row opens its menu with an https "Open details" link', href);
        await pressEscape(cdp);
        await waitFor(`!document.querySelector('[role="menu"]')`, 'menu closed');
        const focused = await cdp.evaluate(`document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName`);
        check(focused === 'Actions for build', 'closing the menu returns focus to the row actions button', focused);
        await rightClick(cdp, CHECK_ROW('lint (no link)'));
        await waitFor(`!!document.querySelector('[role="menu"]')`, 'menu for a check without a link');
        const disabled = await cdp.evaluate(`(() => { const m = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')); return m.length > 0 && m.every((i) => i.getAttribute('aria-disabled') === 'true' || i.hasAttribute('data-disabled')); })()`);
        check(disabled === true, 'a check without a link shows only a disabled entry', disabled);
        await pressEscape(cdp);
        await waitFor(`!document.querySelector('[role="menu"]')`, 'menu closed again');
      }
    }

    await openAppearance();
    await cdp.click(radio('Per Element'));
    await waitFor(`${radio('Per Element')}?.getAttribute('aria-checked') === 'true'`, 'custom theme active');
    await cdp.click(kebab('Actions for Per Element'));
    await waitFor(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim().startsWith('Remove'))`, 'Remove entry');
    await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim().startsWith('Remove'))`);
    await waitFor(`!!document.querySelector('[role="alertdialog"], [role="dialog"]')`, 'Remove dialog');
    await cdp.clickByText('Remove', { inDialog: true });
    await waitFor(`!${radio('Per Element')}`, 'custom theme row gone', 20_000);
    const fallback = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="radio"][aria-checked="true"]')).length`);
    check(fallback === 1, 'removing the active custom theme leaves exactly one built-in selected', fallback);
    check(!existsSync(path.join(dirs.data, 'themes', 'per-element.json')), 'the theme file is deleted from the scratch themes folder');
    await shot('appearance-after-remove.png');
  } catch (err) {
    check(false, `run aborted: ${err.message}`, String(err.stack ?? err));
    process.exitCode = 1;
  } finally {
    if (cdp && report.some((r) => r.ok === false)) await cdp.screenshot(path.join(SHOTS_DIR, 'failure.png')).catch(() => {});
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHead(REPO_ROOT), failures: report.filter((r) => r.ok === false).map((r) => r.step), results: report }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write report.json: ${writeErr}`);
    }
    cdp?.close();
    if (child) await stopLauncher(child);
    for (const dir of Object.values(dirs)) await safeRmSync(dir);
    if (report.some((r) => r.ok === false)) process.exitCode = 1;
  }
}

main();
