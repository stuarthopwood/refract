#!/usr/bin/env node
// Live CDP check for spec 104 (#1497, spec 086 gate leftovers): heading names, rejected-file hint, check-row slot and pointer menu, stale toast on remove, on a built Tauri debug exe with fake `omp` and `gh`.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_104_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-104.mjs

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
const LOG = 'verify-104';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_104_SHOTS_DIR || path.join(tmpdir(), 'refract-104-shots');
const SHOT_FILES = ['appearance.png', 'profile.png', 'checks.png', 'checks-menu.png', 'appearance-after-remove.png', 'failure.png', 'report.json'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CUSTOM = { version: 1, name: 'Per Element', base: 'dark', tokens: { 'scrollbar-thumb': '#00c853' } };
const OLD_NAMES = { version: 1, name: 'Old Names', base: 'dark', tokens: { 'mermaid-cscale-12': '#ffffff' } };
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
  const mk = (n) => mkdtempSync(path.join(tmpdir(), `refract-104-${n}-`));
  const dirs = { data: mk('data'), imp: mk('import'), repo: makeFakeGithubRepo(mk('repo')), exe: mk('exe'), launcher: mk('launcher'), shim: mk('shim'), gh: mk('gh'), ghConfig: mk('ghcfg') };
  let child;
  let cdp;
  try {
    mkdirSync(path.join(dirs.data, 'themes'));
    writeFileSync(path.join(dirs.data, 'themes', 'per-element.json'), JSON.stringify(CUSTOM));
    writeFileSync(path.join(dirs.data, 'themes', 'old-names.json'), JSON.stringify(OLD_NAMES));
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

    await openAppearance();
    const heading = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="radiogroup"] p')).map((p) => p.textContent.trim())`);
    check(heading.includes('Built-in themes') && !heading.includes('Built-in'), 'Appearance names the group "Built-in themes"', heading);
    const hint = await cdp.evaluate(`document.body.innerText.includes("renamed to '--mermaid-cscale-11'")`);
    check(hint === true, 'a theme file using the old mermaid-cscale-12 name is rejected with the renamed-token hint', hint);
    await cdp.click(radio('Per Element'));
    await waitFor(`${radio('Per Element')}?.getAttribute('aria-checked') === 'true'`, 'custom theme active');
    await waitFor(`document.body.innerText.includes('Custom theme applied')`, 'applied toast shown');
    await shot('appearance.png');
    const size = await cdp.evaluate(`(() => { const r = document.querySelector('[aria-label^="Actions for "]').getBoundingClientRect(); return { w: r.width, h: r.height }; })()`);
    check(size.w >= 24 && size.h >= 24, 'the row kebab is at least a 24px target', size);
    await backToChat();

    await openThemeSubmenu(cdp);
    const label = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="group"], [role="menu"] [role="presentation"], [role="menu"] div')).some((el) => el.children.length === 0 && el.textContent.trim() === 'Built-in themes')`);
    check(label === true, 'the profile Theme submenu names the group "Built-in themes"', label);
    await shot('profile.png');
    await closeAllMenus(cdp);

    await cdp.clickByText('Pull requests');
    await waitFor(`document.querySelectorAll('[data-pr-row]').length > 0`, 'PR rows', 30_000);
    await cdp.click(`document.querySelector('[data-pr-row][data-pr-number="1"]')`);
    await waitFor(`!!document.querySelector('section[aria-label="Checks"]')`, 'Checks section', 30_000);
    if (!(await cdp.evaluate(`!!(${CHECK_ROW('build')})`))) {
      await cdp.click(`Array.from(document.querySelectorAll('section[aria-label="Checks"] button')).find((b) => /Successful/.test(b.textContent))`);
    }
    await waitFor(`!!(${CHECK_ROW('build')})`, 'Checks section with rows', 15_000);
    await shot('checks.png');
    const slots = await cdp.evaluate(`Array.from(document.querySelectorAll('section[aria-label="Checks"] li span.tabular-nums')).map((s) => Math.round(s.getBoundingClientRect().right))`);
    check(slots.length >= 2 && new Set(slots).size === 1, 'every check row ends its duration slot at the same x', slots);
    const rect = await cdp.evaluate(`(() => { const r = (${CHECK_ROW('build')}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await rightClick(cdp, CHECK_ROW('build'));
    await waitFor(`!!document.querySelector('[role="menu"] a[href]')`, 'context menu with a link entry');
    const menuLeft = await cdp.evaluate(`Math.round(document.querySelector('[role="menu"]').getBoundingClientRect().left)`);
    check(Math.abs(menuLeft - Math.round(rect.x)) <= 6, 'right-click opens the check menu at the pointer, not at the kebab', { menuLeft, pointerX: rect.x });
    const href = await cdp.evaluate(`document.querySelector('[role="menu"] a[href]').getAttribute('href')`);
    check(/^https:\/\//.test(href), 'the pointer menu offers an https "Open details" link', href);
    await shot('checks-menu.png');
    await pressEscape(cdp);
    await waitFor(`!document.querySelector('[role="menu"]')`, 'menu closed');
    const noLink = await cdp.evaluate(`(() => { const li = ${CHECK_ROW('lint (no link)')}; return !!li && li.textContent.includes('No details link') && !li.querySelector('[aria-label^="Actions for "]'); })()`);
    check(noLink === true, 'a check without a link still shows "No details link" and no actions menu', noLink);

    await openAppearance();
    await cdp.click(radio('Dark'));
    await waitFor(`?.getAttribute('aria-checked') === 'true'`, 'Dark checked');
    await cdp.click(radio('Per Element'));
    await waitFor(`document.body.innerText.includes('Custom theme applied')`, 'applied toast raised right before removal');
    await cdp.click(kebab('Actions for Per Element'));
    await waitFor(`!!Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim().startsWith('Remove'))`, 'Remove entry');
    await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim().startsWith('Remove'))`);
    await waitFor(`!!document.querySelector('[role="alertdialog"], [role="dialog"]')`, 'Remove dialog');
    await cdp.click(`Array.from(document.querySelectorAll('[role="alertdialog"] button, [role="dialog"] button')).find((el) => el.textContent.trim() === 'Remove')`);
    await waitFor(`!${radio('Per Element')}`, 'custom theme row gone', 20_000);
    await sleep(800);
    const stale = await cdp.evaluate(`document.body.innerText.includes('Custom theme applied')`);
    check(stale === false, 'removing the active custom theme drops the stale "Custom theme applied" toast', stale);
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
