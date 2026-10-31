#!/usr/bin/env node
// Live CDP check for spec 078 (#458 custom themes) against a real built Tauri debug exe with fake `omp`,
// a scratch REFRACT_DATA_DIR holding a themes folder, and its own debugging port (never %APPDATA%\refract-tauri).
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_078_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-078.mjs

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { addRepository, groupTriggerFinder } from './verify-tauri-session-list-helpers.mjs';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_078_SHOTS_DIR || path.join(tmpdir(), 'refract-078-shots');
mkdirSync(SHOTS_DIR, { recursive: true });

const REPORT = [];
let passed = 0;
const log = (line) => {
  console.log(line);
  REPORT.push(line);
};
function assert(cond, message) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
  passed += 1;
  log(`PASS: ${message}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (cdp, name) => cdp.screenshot(path.join(SHOTS_DIR, name));

const BUILTINS = ['Dark', 'Dark (high contrast)', 'Obsidian', 'Nordic Frost', 'Cyber Amber'];
const radio = (name) => `Array.from(document.querySelectorAll('[role="radio"]')).find((el) => el.textContent.trim().startsWith(${JSON.stringify(name)}))`;
const rootProp = (prop) => `document.documentElement.style.getPropertyValue(${JSON.stringify(prop)})`;

const THEME_FILES = {
  'hot-pink.json': { version: 1, name: 'Hot Pink', base: 'dark', tokens: { background: '#ff1493', foreground: '#ff69b4', primary: '#ffff00' } },
  'evil.json': { version: 1, name: 'Evil', base: 'dark', tokens: { background: 'url(https://example.invalid/x.png)' } },
  'bad-token.json': { version: 1, name: 'Bad token', base: 'dark', tokens: { fooo: '#fff' } }
};

async function pressResetChord(cdp) {
  const base = { modifiers: 2 | 8, key: ')', code: 'Digit0', windowsVirtualKeyCode: 48 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function runChecks(cdp, repoDir) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 120_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness green (fake omp)' }
  );
  await addRepository(cdp, repoDir);
  await cdp.waitFor(groupTriggerFinder(path.basename(repoDir)) + ' !== undefined', { timeoutMs: 15_000, label: 'Project rendered' });
  await cdp.evaluate(`window.__errs = []; const o = console.error; console.error = (...a) => { window.__errs.push(a.map(String).join(' ').slice(0, 800)); o(...a); }`);
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Appearance')`);
  await cdp.waitFor(`!!${radio('Hot Pink')}`, { timeoutMs: 15_000, label: 'custom theme listed' });

  for (const name of BUILTINS) {
    await cdp.click(radio(name));
    await cdp.waitFor(`${radio(name)}?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 10_000, label: `${name} checked` });
    await sleep(300);
    assert(await cdp.evaluate(`${rootProp('--background')} === ''`), `${name} leaves no custom --background override`);
    await shot(cdp, `theme-${name.toLowerCase().replace(/[^a-z]+/g, '-')}.png`);
  }

  await cdp.click(radio('Hot Pink'));
  await cdp.waitFor(`${radio('Hot Pink')}?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 10_000, label: 'Hot Pink checked' });
  await sleep(300);
  assert(await cdp.evaluate(`${rootProp('--background')} === '#ff1493'`), 'custom --background is applied inline');
  assert(await cdp.evaluate(`getComputedStyle(document.body).backgroundColor === 'rgb(255, 20, 147)'`), 'body paints the custom background');
  await shot(cdp, 'theme-custom-hot-pink.png');

  const warn = await cdp.evaluate(`document.querySelector('[data-slot="badge"][data-variant="warning"]')?.textContent?.trim() ?? ''`);
  log(`warning badge: ${warn}`);
  assert(/contrast warning/.test(warn), 'a low-contrast custom theme shows a contrast warning badge');

  const alerts = await cdp.evaluate(`Array.from(document.querySelectorAll('p[role="alert"]')).map((el) => el.textContent)`);
  log(`rejected: ${JSON.stringify(alerts)}`);
  assert(alerts.some((t) => t.includes('evil.json')) && alerts.some((t) => t.includes('bad-token.json')), 'both hostile files are rejected with a named error');
  assert(!(await cdp.evaluate(`!!${radio('Evil')} || !!${radio('Bad token')}`)), 'rejected files are never listed as themes');

  await pressResetChord(cdp);
  await cdp.waitFor(`${radio('Dark')}?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 10_000, label: 'Ctrl+Shift+0 resets to Dark' });
  assert(await cdp.evaluate(`${rootProp('--background')} === ''`), 'reset clears the custom overrides');
  await shot(cdp, 'after-reset.png');
}

function buildShim(dir) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', path.join(dir, 'omp.exe')], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`rustc shim failed: ${r.stderr}`);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-078: head ${head}, shots ${SHOTS_DIR}`);
  let shimDir, dataDir, importDir, exeDir, repoA, child, cdp;
  let ok = false;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-078-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-078-data-'));
    importDir = mkdtempSync(path.join(tmpdir(), 'refract-078-import-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-078-exe-'));
    repoA = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-078-repoA-')), 'A');
    mkdirSync(path.join(dataDir, 'themes'));
    for (const [file, body] of Object.entries(THEME_FILES)) writeFileSync(path.join(dataDir, 'themes', file), JSON.stringify(body));
    buildShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const src = process.env.REFRACT_078_EXE_SRC || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
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
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    log(`app pid ${launched.targetPid}, port ${port}, data dir ${dataDir}`);
    await runChecks(cdp, repoA);
    log(`verify-tauri-078: ALL PASS (${passed} checks) at head ${head}`);
    ok = true;
  } finally {
    if (!ok && cdp) {
      await shot(cdp, 'failure.png').catch(() => {});
      console.error(await cdp.evaluate(`JSON.stringify(window.__errs ?? [])`).catch(() => 'no errs'));
    }
    writeFileSync(path.join(SHOTS_DIR, 'report.txt'), REPORT.join('\n'));
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, ok, checks: passed, log: REPORT }, null, 2));
    cdp?.close();
    if (child) await stopLauncher(child);
    for (const dir of [shimDir, dataDir, importDir, exeDir, repoA]) if (dir) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-078: FAIL');
  console.error(err);
  process.exitCode = 1;
});
