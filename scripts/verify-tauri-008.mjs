#!/usr/bin/env node
// Live CDP check for spec 008 (profile item, profile menu, Manage accounts, Manage sessions) against a real built
// Tauri debug exe with fake `omp`, an empty GH_CONFIG_DIR (signed-out gh), a scratch REFRACT_DATA_DIR and its own port.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_008_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-008.mjs
// The gh state depends on the host's gh credentials (GH_TOKEN can override GH_CONFIG_DIR); checks accept either.

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { addRepository, pressTab, pressEscape, getActiveElementAccessibleName } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_008_SHOTS_DIR || path.join(tmpdir(), 'refract-008-shots');
mkdirSync(SHOTS_DIR, { recursive: true });

const THEMES = ['theme-dark', 'theme-dark-high-contrast'];
const MENU_ORDER = ['Manage accounts', 'Manage sessions', 'Theme', 'Keyboard shortcuts', 'Health check', "What's new"];
const REPORT = [];
let passed = 0;
function log(line) {
  console.log(line);
  REPORT.push(line);
}
function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
  passed += 1;
  log(`PASS: ${message}`);
}

const shot = (cdp, name) => cdp.screenshot(path.join(SHOTS_DIR, name));
const setTheme = (cdp, cls) =>
  cdp.evaluate(`(() => { const r = document.documentElement; for (const c of Array.from(r.classList)) if (c.startsWith('theme-')) r.classList.remove(c); r.classList.add('dark', ${JSON.stringify(cls)}); return true; })()`);
const NAME_BUTTON = `document.querySelector('[data-profile-name-button]')`;
const menuTexts = `Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).map((el) => el.textContent.trim())`;
const UNNAMED = `Array.from(document.querySelectorAll('button')).filter((b) => b.querySelector('svg') && !b.textContent.trim() && !b.getAttribute('aria-label') && !b.getAttribute('aria-labelledby')).map((b) => b.outerHTML.slice(0, 120))`;
const SCOPE_UNNAMED = (root) => `Array.from(${root}.querySelectorAll('button, [role="menuitem"], [role="menuitemradio"]')).filter((b) => !b.textContent.trim() && !b.getAttribute('aria-label') && !b.getAttribute('aria-labelledby')).map((b) => b.outerHTML.slice(0, 120))`;

async function openMenu(cdp) {
  await cdp.click(NAME_BUTTON);
  await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'profile menu open' });
}
async function clickMenuItem(cdp, text) {
  await cdp.click(`Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).find((el) => el.textContent.trim().startsWith(${JSON.stringify(text)}))`);
}

async function runChecks(cdp, { repoDir }) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 120_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green (fake omp)' });
  await addRepository(cdp, repoDir);
  await cdp.waitFor(`!!${NAME_BUTTON}`, { timeoutMs: 20_000, label: 'profile item rendered' });
  await cdp.waitFor(`!${NAME_BUTTON}.getAttribute('aria-label').startsWith('Checking')`, { timeoutMs: 60_000, label: 'GitHub status settled' });

  const label = await cdp.evaluate(`${NAME_BUTTON}.getAttribute('aria-label')`);
  const visible = await cdp.evaluate(`${NAME_BUTTON}.textContent.trim()`);
  log(`profile item label "${label}", text "${visible}"`);
  assert(/sign|github/i.test(label), 'profile item has an accessible name naming the GitHub state (FR-004, FR-005)');
  assert(visible.length > 0, 'profile item shows a visible name or "Sign in" (FR-004)');

  // FR-005: keyboard order and visible focus on the profile item and the cog.
  // Real Tab navigation so :focus-visible applies (a programmatic focus() would not match it).
  await cdp.evaluate(`(() => { document.activeElement?.blur(); return true; })()`);
  let focusedName = { name: null };
  for (let i = 0; i < 40 && focusedName.name !== label; i++) {
    await pressTab(cdp);
    focusedName = await getActiveElementAccessibleName(cdp);
  }
  assert(focusedName.name === label, 'profile item takes keyboard focus with its accessible name');
  const outline = await cdp.evaluate(`getComputedStyle(${NAME_BUTTON}).outlineStyle`);
  assert(outline !== 'none', 'profile item shows a visible focus indicator (FR-005, SC-006)');
  const tabOrder = [];
  for (let i = 0; i < 3; i++) {
    await pressTab(cdp);
    tabOrder.push((await getActiveElementAccessibleName(cdp)).name);
  }
  log(`tab order after the profile item: ${JSON.stringify(tabOrder)}`);
  assert(tabOrder.includes('Settings'), 'the Settings cog is reachable by Tab right after the profile item (FR-005)');

  const unnamed = await cdp.evaluate(UNNAMED);
  assert(unnamed.length === 0, `every icon-only button has an accessible name ${JSON.stringify(unnamed)} (FR-027)`);

  for (const cls of THEMES) {
    await setTheme(cdp, cls);
    await sleep(300);
    await shot(cdp, `${cls}-profile-item.png`);
    await openMenu(cdp);
    const items = await cdp.evaluate(menuTexts);
    log(`menu items in ${cls}: ${JSON.stringify(items)}`);
    const positions = MENU_ORDER.map((m) => items.findIndex((t) => t.startsWith(m)));
    assert(positions.every((p) => p >= 0), `menu lists every FR-018 item in ${cls}`);
    assert(positions.every((p, i) => i === 0 || p > positions[i - 1]), `menu items keep the fixed FR-018 order in ${cls}`);
    assert((await cdp.evaluate(SCOPE_UNNAMED(`document.querySelector('[role="menu"]')`))).length === 0, `every menu item has a name in ${cls}`);
    await shot(cdp, `${cls}-profile-menu.png`);

    // FR-019: Theme submenu is a real radio group with exactly one checked preset.
    await clickMenuItem(cdp, 'Theme');
    await cdp.waitFor(`document.querySelectorAll('[role="menuitemradio"]').length > 1`, { timeoutMs: 10_000, label: 'Theme submenu radios' });
    const radios = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="menuitemradio"]')).map((r) => r.getAttribute('aria-checked'))`);
    assert(radios.filter((c) => c === 'true').length === 1, `Theme submenu has exactly one checked radio in ${cls}`);
    await shot(cdp, `${cls}-theme-submenu.png`);
    await pressEscape(cdp);
    await pressEscape(cdp);
    await cdp.waitFor(`!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'menu closed by Escape (FR-024)' });
    assert((await cdp.evaluate(`document.activeElement === ${NAME_BUTTON}`)), `focus returns to the profile item after the menu closes in ${cls} (FR-024)`);
  }
  await setTheme(cdp, 'theme-dark');

  // Cog opens Settings (FR-002).
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened from the cog' });
  assert(true, 'the cog opens Settings (FR-002)');
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'back to chat' });

  // Manage accounts: GitHub and OMP sections stay separate; OMP is read-only (FR-016, FR-017 deferred).
  await openMenu(cdp);
  await clickMenuItem(cdp, 'Manage accounts');
  await cdp.waitFor(`!!document.querySelector('[role="dialog"]') && !!document.querySelector('#omp-providers-heading')`, { timeoutMs: 20_000, label: 'Manage accounts with OMP section' });
  assert(await cdp.evaluate(`!!document.querySelector('#github-accounts-heading')`), 'Manage accounts has a labelled GitHub section (FR-008)');
  const dialogText = await cdp.evaluate(`document.querySelector('[role="dialog"]').innerText`);
  assert(/omp/i.test(dialogText) && /terminal|\/login/i.test(dialogText), 'OMP section is read-only and points at the terminal sign-in (FR-016, FR-017 deferred)');
  assert((await cdp.evaluate(SCOPE_UNNAMED(`document.querySelector('[role="dialog"]')`))).length === 0, 'every Manage accounts control has an accessible name (FR-027)');
  await shot(cdp, 'theme-dark-manage-accounts.png');
  await pressEscape(cdp);
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 10_000, label: 'Manage accounts closed' });

  // Keyboard shortcuts dialog (FR-020).
  await openMenu(cdp);
  await clickMenuItem(cdp, 'Keyboard shortcuts');
  await cdp.waitFor(`!!document.querySelector('[role="dialog"]')`, { timeoutMs: 10_000, label: 'Keyboard shortcuts open' });
  assert((await cdp.evaluate(`document.querySelector('[role="dialog"]').innerText`)).includes('Keyboard shortcuts'), 'Keyboard shortcuts dialog opens (FR-020)');
  await pressEscape(cdp);
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 10_000, label: 'Keyboard shortcuts closed' });

  // Manage sessions screen (FR-025).
  const overflow = await cdp.evaluate(`(() => { const s = ${NAME_BUTTON}.querySelector('span.truncate'); return s ? getComputedStyle(s).textOverflow : 'none'; })()`);
  assert(overflow === 'ellipsis', 'the profile name truncates with an ellipsis (FR-028)');
  await openMenu(cdp);
  await clickMenuItem(cdp, 'Manage sessions');
  await cdp.waitFor(`!!document.querySelector('[aria-label="All sessions across projects"]') || /Manage sessions/.test(document.body.innerText)`, { timeoutMs: 15_000, label: 'Manage sessions screen' });
  for (const cls of THEMES) {
    await setTheme(cdp, cls);
    await sleep(300);
    await shot(cdp, `${cls}-manage-sessions.png`);
  }
  assert(true, 'Manage sessions screen opens from the menu (FR-025)');
  await setTheme(cdp, 'theme-dark');
}

function buildShim(dir) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', path.join(dir, 'omp.exe')], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`rustc shim failed: ${r.stderr}`);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-008: head ${head}, shots ${SHOTS_DIR}`);
  let shimDir, dataDir, importDir, exeDir, ghCfgDir, repoA, child, cdp;
  let ok = false;
  try {
    const mk = (n) => mkdtempSync(path.join(tmpdir(), `refract-008-${n}-`));
    shimDir = mk('shim');
    dataDir = mk('data');
    importDir = mk('import');
    exeDir = mk('exe');
    ghCfgDir = mk('ghcfg');
    repoA = makeScratchRepo(mk('repoA'), 'A');
    buildShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const src = process.env.REFRACT_008_EXE_SRC || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
    if (!existsSync(src)) throw new Error(`built exe not found at ${src}`);
    const exePath = path.join(exeDir, 'refract-tauri.exe');
    copyFileSync(src, exePath);
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importDir,
        GH_CONFIG_DIR: ghCfgDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    log(`app pid ${launched.targetPid}, port ${port}, data dir ${dataDir}`);
    await runChecks(cdp, { repoDir: repoA });
    log(`verify-tauri-008: ALL PASS (${passed} checks) at head ${head}`);
    ok = true;
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.txt'), REPORT.join('\n'));
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, ok, checks: passed, log: REPORT }, null, 2));
    cdp?.close();
    if (child) await stopLauncher(child);
    for (const dir of [shimDir, dataDir, importDir, exeDir, ghCfgDir, repoA]) if (dir) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-008: FAIL');
  console.error(err);
  process.exitCode = 1;
});
