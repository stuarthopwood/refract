#!/usr/bin/env node
// Live CDP check for #1590 (six new themes): scratch exe + data dir + WebView2 profile + OMP_PROFILE, fake `omp`.
// Per theme: pick it in the real Profile > Theme menu, assert root class / color-scheme / resolved --background, count
// sunlight-glare offenders (T022) from live tokens, screenshot Chat, Pull requests, Usage and Settings > Appearance.
// Dark is measured first; its offender count is the baseline no new theme may exceed.
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-tauri-1590.mjs
// Env: REFRACT_1590_SHOTS_DIR overrides the screenshot/report dir (default <os tmpdir>/refract-1590-shots).

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep, resolveCssVarColor } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget, gitHead, computeDirty, sha256OfFile, citeScreenshots, switchTheme } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExe } from './verify-tauri-560-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { parseComputedColorToEntry, linearToHex, resolvedLinear } from './contrast-math.mjs';
import { PROFILES } from './display-profiles.mjs';
import { PAIRS, offendersUnderProfile } from './display-profile-pairs.mjs';
import { themes as parsedThemes } from './theme-tokens.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1590';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1590_SHOTS_DIR || path.join(tmpdir(), 'refract-1590-shots');

// Names are the picker labels (`src/shared/themes.ts`); Dark leads because its glare count is the T022 baseline.
const BASELINE = { id: 'dark', name: 'Dark', light: false };
const NEW_THEMES = [
  { id: 'light', name: 'Light', light: true },
  { id: 'light-warm-paper', name: 'Light (warm paper)', light: true },
  { id: 'light-high-contrast', name: 'Light (high contrast)', light: true },
  { id: 'lagoon', name: 'Lagoon', light: false },
  { id: 'amethyst', name: 'Amethyst', light: false },
  { id: 'hearth', name: 'Hearth', light: false }
];
// T022 baseline: Dark's parsed-token glare offender count when #1590 was written; a drift means the baseline moved.
const DARK_PARSED_BASELINE = 11;
const GLARE = PROFILES.find((profile) => profile.id === 'sunlight-glare');
const AUDIT_TOKENS = [...new Set(PAIRS.flatMap((pair) => [pair.a, pair.b]))];

const report = [];
const shotNames = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
  if (ok !== true) process.exitCode = 1;
}
const shot = async (cdp, name) => {
  await sleep(500);
  await cdp.screenshot(path.join(SHOTS_DIR, name));
  shotNames.push(name);
};

const navButton = (label) => `Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)})`;
const viewButton = (label) => `Array.from(document.querySelectorAll('[role="group"][aria-label="Views"] button[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith(${JSON.stringify(label)}))`;

async function launch(env) {
  const port = await getFreePort();
  const launched = await launchBuiltExe(env.launcherExe, env.exe, {
    port,
    dataDir: env.dataDir,
    importSourceDir: env.importSourceDir,
    pathPrepend: env.shimDir,
    logFile: path.join(SHOTS_DIR, `app-${port}.log`),
    extraEnv: {
      OMP_PROFILE: 'verify-1590',
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      REFRACT_FAKE_OMP_SCENARIO: 'session'
    }
  });
  const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
  if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target not owned by launched pid');
  console.log(`${LOG}: launched exe pid ${launched.targetPid} on port ${port}`);
  return { cdp, child: launched.child };
}

async function openChat(cdp, repoName) {
  if (await cdp.evaluate(`!!document.querySelector('[aria-label="Back to chat"]')`)) {
    await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  }
  await cdp.click(`Array.from(document.querySelectorAll('[data-repository-id]')).find((el) => el.textContent.includes(${JSON.stringify(repoName)}))?.querySelector('li button')`);
  await cdp.waitFor(`(() => { const m = document.querySelector('[aria-label="Message"]'); return !!m && !m.disabled; })()`, { timeoutMs: 20_000, label: 'Chat composer mounted' });
}

async function openView(cdp, label) {
  await cdp.click(viewButton(label));
  await cdp.waitFor(`${viewButton(label)}?.getAttribute('aria-current') === 'page'`, { timeoutMs: 20_000, label: `${label} view selected` });
}

async function openAppearance(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await cdp.click(navButton('Appearance'));
  await cdp.waitFor(`Array.from(document.querySelectorAll('h1, h2')).some((h) => h.textContent.trim() === 'Appearance')`, { timeoutMs: 10_000, label: 'Appearance section mounted' });
}

// Resolves each audited token through a probe element so `color-mix()`/`var()` chains are computed by the webview itself.
async function resolveLiveTokens(cdp) {
  const props = {};
  for (const token of AUDIT_TOKENS) {
    props[token] = parseComputedColorToEntry(await resolveCssVarColor(cdp, `--${token}`, 'background-color'));
  }
  return props;
}

const hexOf = (entry) => (entry ? linearToHex(resolvedLinear(entry, entry)) : null);
const channelsClose = (a, b) => !!a && !!b && [1, 3, 5].every((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= 1);

/** Asserts the theme took effect, then returns the number of sunlight-glare offenders measured from the live tokens. */
async function auditTheme(cdp, theme, baseline) {
  const applied = await cdp.evaluate(`(() => { const r = document.documentElement; return { cls: r.classList.contains(${JSON.stringify(`theme-${theme.id}`)}), dark: r.classList.contains('dark'), themeClasses: Array.from(r.classList).filter((c) => c.startsWith('theme-')), colorScheme: getComputedStyle(r).colorScheme }; })()`);
  check(applied.cls && applied.themeClasses.length === 1, `${theme.id}: exactly the theme-${theme.id} root class is applied`, applied);
  check(applied.colorScheme === (theme.light ? 'light' : 'dark') && applied.dark === !theme.light, `${theme.id}: color-scheme is ${theme.light ? 'light' : 'dark'} and the dark class ${theme.light ? 'is absent' : 'is present'}`, applied);

  const live = await resolveLiveTokens(cdp);
  const unparsed = AUDIT_TOKENS.filter((token) => !live[token]);
  check(unparsed.length === 0, `${theme.id}: every audited token resolves to a parseable colour in the webview`, { unparsed });
  const offline = parsedThemes[theme.id];
  const liveBg = hexOf(live.background);
  check(channelsClose(liveBg, hexOf(offline?.background)), `${theme.id}: resolved --background matches the parsed token block`, { live: liveBg, parsed: hexOf(offline?.background) });
  const liveOffenders = offendersUnderProfile(theme.id, live, GLARE);
  const offlineOffenders = offendersUnderProfile(theme.id, offline, GLARE);
  const evidence = { live: liveOffenders.length, parsed: offlineOffenders.length, baseline: baseline?.live ?? null, offenders: liveOffenders.map((pair) => pair.name) };
  // T022 rule: a new theme must not have more glare offenders than Dark; Dark itself defines the baseline.
  if (baseline) check(liveOffenders.length <= baseline.live && offlineOffenders.length <= baseline.parsed, `${theme.id}: sunlight-glare offenders do not regress vs Dark (${liveOffenders.length} <= ${baseline.live})`, evidence);
  else check(offlineOffenders.length === DARK_PARSED_BASELINE, `${theme.id}: baseline recorded (${liveOffenders.length} live, ${offlineOffenders.length} parsed; expected ${DARK_PARSED_BASELINE} parsed)`, evidence);
  return { live: liveOffenders.length, parsed: offlineOffenders.length };
}

async function captureViews(cdp, theme, repoName) {
  await openChat(cdp, repoName);
  await shot(cdp, `${theme.id}-1-chat.png`);
  await openView(cdp, 'Pull requests');
  await shot(cdp, `${theme.id}-2-pull-requests.png`);
  await openView(cdp, 'Usage');
  await cdp.waitFor(`!!document.querySelector('section[aria-label="Usage"]')`, { timeoutMs: 15_000, label: 'Usage view mounted' });
  await shot(cdp, `${theme.id}-3-usage.png`);
  await openAppearance(cdp);
  await shot(cdp, `${theme.id}-4-settings-appearance.png`);
  await openChat(cdp, repoName);
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1590-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1590-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1590-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1590-themes');
  const repoName = path.basename(repoDir);
  const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', repoName);
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1590-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1590-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1590-shim-'));
  const exe = path.join(exeDir, 'refract-tauri.exe');
  let session;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    copyFileSync(path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe'), exe);
    const exeHash = sha256OfFile(exe);
    report.push({ step: 'build identity', ok: true, evidence: { head: gitHead(REPO_ROOT), dirty: computeDirty(REPO_ROOT), exeSha256: exeHash } });
    console.log(`${LOG}: head ${gitHead(REPO_ROOT)} exe sha256 ${exeHash}`);

    session = await launch({ launcherExe, exe, dataDir, shimDir, importSourceDir });
    const { cdp } = session;
    // Isolation proof: exe, data dir and the WebView2 profile (created beside the exe by launchBuiltExe) are all scratch.
    check(path.dirname(exe).startsWith(tmpdir()) && dataDir.startsWith(tmpdir()), 'Isolation: exe, data dir and WebView2 profile are scratch copies under the temp dir', { exe, dataDir });

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]') || !!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 60_000, label: 'Readiness or main screen' });
    if (await cdp.evaluate(`!!document.querySelector('[data-readiness-primary]')`)) {
      await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
      await addRepository(cdp, repoDir);
    }
    await cdp.waitFor(`!!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 30_000, label: 'Settings button' });
    await createSessionViaQuickCreate(cdp, repoName);

    // Dark first: its glare count is the baseline the six new themes are held to.
    let baseline = null;
    for (const theme of [BASELINE, ...NEW_THEMES]) {
      await switchTheme(cdp, theme.id, theme.name);
      await sleep(400);
      const counts = await auditTheme(cdp, theme, baseline);
      baseline ??= counts;
      await captureViews(cdp, theme, repoName);
    }
    report.push({ step: 'sunlight-glare baseline (Dark)', ok: true, evidence: baseline });

    // The last pick must have round-tripped through the real store, not just the renderer.
    const settingsFile = path.join(dataDir, 'settings.json');
    const saved = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')).theme : null;
    const last = NEW_THEMES[NEW_THEMES.length - 1].id;
    check(saved === last, `Persistence: settings.json stores the last selected theme (${last})`, { saved });
    report.push({ step: 'screenshots (sha256)', ok: true, evidence: citeScreenshots(SHOTS_DIR, shotNames) });
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    console.error(err);
    try { if (session) await session.cdp.screenshot(path.join(SHOTS_DIR, 'crash.png')); } catch {}
    process.exitCode = 1;
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    if (session) {
      session.cdp.close();
      await stopLauncher(session.child).catch(() => {});
    }
    for (const dir of [dataDir, importSourceDir, repoDirBase, worktreesRoot, exeDir, launcherDir, shimDir]) await safeRmSync(dir, LOG);
  }
  if (report.some((r) => !r.ok)) process.exitCode = 1;
  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main();
