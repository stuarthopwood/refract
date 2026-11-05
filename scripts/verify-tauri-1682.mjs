#!/usr/bin/env node
// Live CDP check for #1682: chat inline code chips use the muted --chat-code-* tokens, while the Pull requests
// view chip keeps --md-code-*. Fake omp (tool-chips-1583 tape) plus fake gh; scratch data dir, no network.
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-tauri-1682.mjs
// Env: REFRACT_1682_SHOTS_DIR overrides the screenshot/report directory.

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, safeRmSync, requireSharedCargoTarget, switchTheme, gitHead, computeDirty } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { addRepository } from './verify-tauri-session-list-helpers.mjs';
import { buildFakeGh, makeFakeGithubRepo } from './verify-1121-pr-polish-fake-gh.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1682';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1682_SHOTS_DIR || 'C:/Users/shopwood/AppData/Local/Temp/lane1682/shots';
const THEMES = [['dark', 'Dark'], ['dark-high-contrast', 'Dark (high contrast)'], ['light', 'Light'], ['light-high-contrast', 'Light (high contrast)']];

const report = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
}
const shot = async (cdp, name) => {
  await sleep(400);
  await cdp.screenshot(path.join(SHOTS_DIR, name));
};
const isClear = (v) => !v || v === 'transparent' || /,\s*0(\.0+)?\s*\)$/.test(v) || /\/\s*0(\.0+)?%?\s*\)$/.test(v);

// Token probes go through inline styles so a Tailwind class missing from the bundle cannot fake a pass.
const CHAT_CHIP = `(() => {
  const probe = (css, prop) => { const el = document.createElement('span'); el.style.cssText = css; document.body.appendChild(el); const v = getComputedStyle(el)[prop]; el.remove(); return v; };
  const chip = Array.from(document.querySelectorAll('[data-slot="message"] [data-slot="inline-code"]')).pop();
  if (!chip) return null;
  const s = getComputedStyle(chip);
  return { text: chip.textContent, bg: s.backgroundColor, color: s.color,
    chatBg: probe('background-color: var(--chat-code-bg)', 'backgroundColor'), chatFg: probe('color: var(--chat-code-fg)', 'color'),
    mdBg: probe('background-color: var(--md-code-bg)', 'backgroundColor'), mdFg: probe('color: var(--md-code-fg)', 'color') };
})()`;
const PR_CHIP = `(() => {
  const probe = (css, prop) => { const el = document.createElement('span'); el.style.cssText = css; document.body.appendChild(el); const v = getComputedStyle(el)[prop]; el.remove(); return v; };
  const chip = Array.from(document.querySelectorAll('[data-slot="inline-code"]')).find((el) => el.textContent === 'pr-chip');
  if (!chip) return null;
  const s = getComputedStyle(chip);
  return { bg: s.backgroundColor, color: s.color, mdBg: probe('background-color: var(--md-code-bg)', 'backgroundColor'), mdFg: probe('color: var(--md-code-fg)', 'color'),
    chatBg: probe('background-color: var(--chat-code-bg)', 'backgroundColor') };
})()`;

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1682-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1682-import-'));
  const repoDir = mkdtempSync(path.join(tmpdir(), 'refract-1682-repo-'));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1682-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1682-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1682-shim-'));
  const ghDir = mkdtempSync(path.join(tmpdir(), 'refract-1682-gh-'));
  const ghConfigDir = mkdtempSync(path.join(tmpdir(), 'refract-1682-ghcfg-'));
  const exe = path.join(exeDir, 'refract-tauri.exe');
  let cdp, child;
  try {
    buildOmpShim(shimDir);
    buildFakeGh(ghDir);
    makeFakeGithubRepo(repoDir);
    const launcherExe = buildLauncher(launcherDir);
    copyFileSync(path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe'), exe);
    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exe, {
      port, dataDir, pathPrepend: `${shimDir};${ghDir}`, logFile: path.join(SHOTS_DIR, `app-${port}.log`),
      extraEnv: {
        GH_CONFIG_DIR: ghConfigDir, REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'), REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'tool-chips-1583'
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target not owned by launched pid');

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]:not(:disabled)') || !!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Add project' && !el.disabled)`, { timeoutMs: 60_000, label: 'app ready' });
    await addRepository(cdp, repoDir);
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'New session dialog' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 90_000, label: 'dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'composer enabled' });
    await sleep(3000);
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);
    await cdp.send('Input.insertText', { text: 'show the chips' });
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`Array.from(document.querySelectorAll('[data-slot="message"]')).some((m) => m.textContent.includes('FINAL-REPLY-1583'))`, { timeoutMs: 60_000, label: 'Final reply' });
    await sleep(1000);

    for (const [id, name] of THEMES) {
      await switchTheme(cdp, id, name);
      await sleep(600);
      const c = await cdp.evaluate(CHAT_CHIP);
      check(!!c && c.text === 'prose-chip' && !isClear(c.bg) && c.bg === c.chatBg && c.color === c.chatFg && c.bg !== c.mdBg && c.color !== c.mdFg,
        `${name}: chat chip uses --chat-code-* (translucent bg, muted fg), distinct from --md-code-*`, c);
      await shot(cdp, `10-chat-${id}.png`);
    }

    await switchTheme(cdp, 'dark', 'Dark');
    await cdp.clickByText('Pull requests');
    await cdp.waitFor(`document.querySelector('h1') && document.querySelector('h1').textContent.trim() === 'Pull requests'`, { timeoutMs: 15_000, label: 'Pull requests view' });
    await cdp.waitFor(`document.querySelectorAll('[data-pr-row]').length > 0`, { timeoutMs: 30_000, label: 'PR rows' });
    await cdp.click(`document.querySelector('[data-pr-row][data-pr-number="1"]')`);
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('[data-slot="inline-code"]')).find((el) => el.textContent === 'pr-chip')`, { timeoutMs: 15_000, label: 'PR description chip' });
    for (const [id, name] of [THEMES[0], THEMES[2]]) {
      await switchTheme(cdp, id, name);
      await sleep(600);
      const p = await cdp.evaluate(PR_CHIP);
      check(!!p && !isClear(p.bg) && p.bg === p.mdBg && p.color === p.mdFg && p.bg !== p.chatBg, `${name}: Pull requests chip still uses --md-code-* (unchanged)`, p);
      await shot(cdp, `20-pr-${id}.png`);
    }
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    console.error(err);
    try { if (cdp) await cdp.screenshot(path.join(SHOTS_DIR, 'crash.png')); } catch {}
    process.exitCode = 1;
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHead(REPO_ROOT), dirty: computeDirty(REPO_ROOT), steps: report }, null, 2));
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    for (const dir of [dataDir, importSourceDir, repoDir, exeDir, launcherDir, shimDir, ghDir, ghConfigDir]) await safeRmSync(dir, LOG);
  }
  if (report.some((r) => !r.ok)) process.exitCode = 1;
  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main();
