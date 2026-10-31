#!/usr/bin/env node
// Live CDP check for spec 081 (#458 slice 4 per-element tokens) against a real built Tauri debug exe with fake `omp`,
// a scratch REFRACT_DATA_DIR holding a themes folder, and its own debugging port (never %APPDATA%\refract-tauri).
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_081_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-081.mjs

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
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
const SHOTS_DIR = process.env.REFRACT_081_SHOTS_DIR || path.join(tmpdir(), 'refract-081-shots');
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

// The 081 tokens are exactly the ones declared in the shared default block of globals.css.
const css = readFileSync(path.join(REPO_ROOT, 'src/renderer/styles/globals.css'), 'utf8');
const TOKENS = [...css.match(/:is\(:root,[^)]*\)\s*\{([^}]*)\}/)[1].matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]);
const hexFor = (i) => `#${(0x10 + ((i * 53) % 0xe0)).toString(16).padStart(2, '0')}${(0x20 + ((i * 97) % 0xd0)).toString(16).padStart(2, '0')}${(0x30 + ((i * 29) % 0xc0)).toString(16).padStart(2, '0')}`;
const toRgb = (hex) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
const UTILITY = (token) => (token.endsWith('-fg') ? `text-${token}` : token.endsWith('-border') ? `border-${token}` : `bg-${token}`);
const PROP = (token) => (token.endsWith('-fg') ? 'color' : token.endsWith('-border') ? 'borderTopColor' : 'backgroundColor');

const CUSTOM_TOKENS = Object.fromEntries(TOKENS.map((t, i) => [t, hexFor(i)]));
const THEME_FILES = {
  'per-element.json': { version: 1, name: 'Per Element', base: 'dark', tokens: CUSTOM_TOKENS }
};

// Computed colour of a probe element wearing the Tailwind utility for each token.
const probeAll = (tokens) => `(() => {
  const out = {};
  for (const [token, utility, prop] of ${JSON.stringify(tokens.map((t) => [t, UTILITY(t), PROP(t)]))}) {
    const el = document.createElement('div');
    el.style.cssText = 'border:1px solid;' + (prop === 'color' ? 'color' : prop === 'borderTopColor' ? 'border-color' : 'background-color') + ':var(--' + token + ')';
    document.body.appendChild(el);
    out[token] = getComputedStyle(el)[prop];
    el.remove();
  }
  return out;
})()`;

async function runChecks(cdp, repoDir) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 120_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness green (fake omp)' }
  );
  await addRepository(cdp, repoDir);
  await cdp.waitFor(groupTriggerFinder(path.basename(repoDir)) + ' !== undefined', { timeoutMs: 15_000, label: 'Project rendered' });
  assert(TOKENS.length === 38, `the shared default block declares 38 tokens (found ${TOKENS.length})`);

  for (const name of BUILTINS) {
    await cdp.click(`document.querySelector('[aria-label="Settings"]')`).catch(() => {});
    await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
    await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Appearance')`);
    await cdp.waitFor(`!!${radio(name)}`, { timeoutMs: 15_000, label: `${name} listed` });
    await cdp.click(radio(name));
    await cdp.waitFor(`${radio(name)}?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 10_000, label: `${name} checked` });
    await sleep(300);
    const colours = await cdp.evaluate(probeAll(TOKENS));
    const unresolved = TOKENS.filter((t) => !colours[t] || colours[t] === 'rgba(0, 0, 0, 0)' && !t.includes('hover') && !t.includes('pill'));
    assert(unresolved.length === 0, `${name}: every per-element token resolves to a colour (unresolved: ${unresolved.join(', ') || 'none'})`);
    await shot(cdp, `theme-${name.toLowerCase().replace(/[^a-z]+/g, '-')}.png`);
    await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
    await sleep(200);
    await shot(cdp, `chat-${name.toLowerCase().replace(/[^a-z]+/g, '-')}.png`);
  }

  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened again' });
  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Appearance')`);
  await cdp.waitFor(`!!${radio('Per Element')}`, { timeoutMs: 15_000, label: 'custom theme listed' });
  await cdp.click(radio('Per Element'));
  await cdp.waitFor(`${radio('Per Element')}?.getAttribute('aria-checked') === 'true'`, { timeoutMs: 10_000, label: 'Per Element checked' });
  await sleep(300);

  const custom = await cdp.evaluate(probeAll(TOKENS));
  const wrong = TOKENS.filter((t) => custom[t] !== toRgb(CUSTOM_TOKENS[t]));
  assert(wrong.length === 0, `custom theme recolours all 38 tokens independently (mismatches: ${wrong.join(', ') || 'none'})`);
  await shot(cdp, 'theme-custom-per-element.png');

  const outlineBg = await cdp.evaluate(`getComputedStyle(Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Import theme'))).backgroundColor`);
  assert(outlineBg === toRgb(CUSTOM_TOKENS['button-outline-bg']), 'the real Import button (outline) paints --button-outline-bg');

  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await sleep(300);
  const bar = await cdp.evaluate(`(() => { const f = document.querySelector('footer'); const s = getComputedStyle(f); return { bg: s.backgroundColor, fg: s.color }; })()`);
  assert(bar.bg === toRgb(CUSTOM_TOKENS['status-bar-bg']) && bar.fg === toRgb(CUSTOM_TOKENS['status-bar-fg']), 'the real status bar paints --status-bar-bg and --status-bar-fg');
  await shot(cdp, 'chat-custom-per-element.png');
}

function buildShim(dir) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', path.join(dir, 'omp.exe')], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`rustc shim failed: ${r.stderr}`);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-081: head ${head}, shots ${SHOTS_DIR}`);
  let shimDir, dataDir, importDir, exeDir, repoA, child, cdp;
  let ok = false;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-081-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-081-data-'));
    importDir = mkdtempSync(path.join(tmpdir(), 'refract-081-import-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-081-exe-'));
    repoA = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-081-repoA-')), 'A');
    mkdirSync(path.join(dataDir, 'themes'));
    for (const [file, body] of Object.entries(THEME_FILES)) writeFileSync(path.join(dataDir, 'themes', file), JSON.stringify(body));
    buildShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const src = process.env.REFRACT_081_EXE_SRC || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
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
    log(`verify-tauri-081: ALL PASS (${passed} checks) at head ${head}`);
    ok = true;
  } finally {
    if (!ok && cdp) await shot(cdp, 'failure.png').catch(() => {});
    writeFileSync(path.join(SHOTS_DIR, 'report.txt'), REPORT.join('\n'));
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, ok, checks: passed, log: REPORT }, null, 2));
    cdp?.close();
    if (child) await stopLauncher(child);
    for (const dir of [shimDir, dataDir, importDir, exeDir, repoA]) if (dir) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-081: FAIL');
  console.error(err);
  process.exitCode = 1;
});
