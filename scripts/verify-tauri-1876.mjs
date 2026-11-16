#!/usr/bin/env node
// Live CDP check for #1876 (advisory stripe beside the expanded body only) and #1877 (--agent-message follows the theme accent;
// diff-stat tokens untouched) against a debug exe copy, fake omp, scratch data dir and its own debugging port.
// Usage: CARGO_TARGET_DIR=<shared target> REFRACT_1876_SCRATCH_DIR=<abs scratch dir> node scripts/verify-tauri-1876.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep, resolveCssVarColor } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, requireSharedCargoTarget, switchTheme, sha256OfFile } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SCRATCH = process.env.REFRACT_1876_SCRATCH_DIR;
if (!SCRATCH || !path.isAbsolute(SCRATCH)) throw new Error('REFRACT_1876_SCRATCH_DIR must be an absolute scratch directory');
const SHOTS_DIR = process.env.REFRACT_1876_SHOTS_DIR || path.join(SCRATCH, 'shots');
mkdirSync(SHOTS_DIR, { recursive: true });

const report = [];
function check(ok, label, extra) {
  report.push({ step: label, ok: ok === true, ...(extra ? { extra } : {}) });
  if (ok !== true) throw new Error(`FAIL: ${label} ${JSON.stringify(extra ?? {})}`);
  console.log(`PASS ${label}`);
}

const advisorTrigger = `document.querySelector('[data-advisory-severity] button[aria-expanded]')`;
const agentRow = `(Array.from(document.querySelectorAll('span.sr-only')).find((el) => (el.textContent ?? '').startsWith('Agent message from R1_Worker to Main agent'))?.closest('button') ?? null)`;

// Resolves once the add-repo / new-session flow is done and the composer is live.
async function openSession(cdp, repoDir) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 60_000, label: 'Readiness mounted' });
  await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
  await cdp.openLocalFolderDialog();
  await cdp.click(`document.querySelector('[role="dialog"] input')`);
  await cdp.send('Input.insertText', { text: repoDir });
  await cdp.clickByText('Add project', { inDialog: true });
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`, { timeoutMs: 30_000, label: 'Repository added' });
  await cdp.clickByLabel('New session from a branch in ', { prefix: true });
  await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'Create session enabled' });
  await cdp.clickByText('Create session', { inDialog: true });
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'Dialog closed' });
  await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Composer enabled' });
  await cdp.typeIntoByLabel('Message', 'trigger the scripted turn');
  await cdp.clickByLabel('Send message');
}

// One scratch app launch (own data dir, WebView2 profile, import dir, port) driven by `body`.
async function withApp(tag, scenario, exe, launcherExe, shimDir, body) {
  const runId = `${tag}-${Date.now()}`; // fresh dirs every run: reused data skips the Readiness screen
  const dataDir = path.join(SCRATCH, `${runId}-data`);
  const importDir = path.join(SCRATCH, `${runId}-import`);
  const repoBase = path.join(SCRATCH, `${runId}-repo`);
  for (const d of [dataDir, importDir, repoBase]) mkdirSync(d, { recursive: true });
  const repoDir = makeScratchRepo(repoBase, `verify-1876-${tag}`);
  const port = await getFreePort();
  const launched = await launchBuiltExe(launcherExe, exe, {
    port,
    dataDir,
    pathPrepend: shimDir,
    logFile: path.join(SCRATCH, `${tag}-app.log`),
    extraEnv: {
      REFRACT_IMPORT_SOURCE_DIR: importDir,
      OMP_PROFILE: 'refract-live-1876',
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      REFRACT_FAKE_OMP_SCENARIO: scenario
    }
  });
  let cdp;
  try {
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`CDP target on port ${port} is not owned by pid ${launched.targetPid}`);
    console.log(`${tag}: pid ${launched.targetPid} port ${port} data ${dataDir}`);
    await openSession(cdp, repoDir);
    await body(cdp);
  } finally {
    cdp?.close();
    await stopLauncher(launched.child).catch(() => {});
  }
}

async function advisoryChecks(cdp) {
  await cdp.waitFor(`!!document.querySelector('[data-advisory-severity]')`, { timeoutMs: 30_000, label: 'Advisory card rendered' });
  const stripe = `(() => {
    const root = document.querySelector('[data-advisory-severity]');
    const trigger = ${advisorTrigger};
    const host = Array.from(root.querySelectorAll('*')).find((el) => { const s = getComputedStyle(el, '::before'); return s.content !== 'none' && s.position === 'absolute' && s.width === '3px' && el.getBoundingClientRect().height > 0; });
    if (!host) return { expanded: trigger.getAttribute('aria-expanded'), stripe: false };
    const h = host.getBoundingClientRect();
    const t = trigger.getBoundingClientRect();
    return { expanded: trigger.getAttribute('aria-expanded'), stripe: true, bg: getComputedStyle(host, '::before').backgroundColor, hostTop: h.top, triggerBottom: t.bottom, hostLeft: h.left };
  })()`;
  const setOpen = async (want) => {
    if ((await cdp.evaluate(`${advisorTrigger}.getAttribute('aria-expanded')`)) !== String(want)) await cdp.click(advisorTrigger);
    await cdp.waitFor(`${advisorTrigger}.getAttribute('aria-expanded') === '${want}'`, { timeoutMs: 5_000, label: `advisory ${want ? 'expanded' : 'collapsed'}` });
    await sleep(400);
  };
  await setOpen(true);
  const open = await cdp.evaluate(stripe);
  const warning = await resolveCssVarColor(cdp, '--severity-warning', 'background-color');
  await cdp.evaluate(`${advisorTrigger}.scrollIntoView({ block: 'center' })`);
  await cdp.screenshot(path.join(SHOTS_DIR, 'advisory-expanded.png'));
  check(open.stripe && open.hostTop >= open.triggerBottom - 1 && open.bg === warning, 'advisory expanded: stripe on the body, starts at/below the header, concern colour', { ...open, warning });
  await setOpen(false);
  const closed = await cdp.evaluate(stripe);
  await cdp.screenshot(path.join(SHOTS_DIR, 'advisory-collapsed.png'));
  check(closed.stripe === false, 'advisory collapsed: no stripe', closed);
}

async function themeChecks(cdp) {
  await cdp.waitFor(`document.querySelectorAll('[data-agent-message-direction]').length >= 4`, { timeoutMs: 30_000, label: 'Agent rows rendered' });
  const seen = {};
  for (const theme of [{ id: 'dark', name: 'Dark' }, { id: 'light-warm-paper', name: 'Light (warm paper)' }, { id: 'amethyst', name: 'Amethyst' }]) {
    if (theme.id !== 'dark') await switchTheme(cdp, theme.id, theme.name);
    const agent = await resolveCssVarColor(cdp, '--agent-message', 'color');
    const accent = await resolveCssVarColor(cdp, '--accent-text', 'color');
    const row = await cdp.evaluate(`(() => {
      const btn = ${agentRow};
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center' });
      const svg = btn.querySelector('svg[data-agent-message-direction]');
      const label = Array.from(btn.querySelectorAll('span')).find((s) => s.className.includes('text-agent-message'));
      return { glyph: svg ? getComputedStyle(svg).color : null, label: label ? getComputedStyle(label).color : null };
    })()`);
    await sleep(300);
    await cdp.screenshot(path.join(SHOTS_DIR, `agent-row-${theme.id}.png`));
    check(row !== null && row.glyph === agent && row.label === agent, `${theme.id}: agent row glyph and label render --agent-message`, { row, agent, accent });
    const diffAdded = await resolveCssVarColor(cdp, '--diff-added', 'color');
    const working = await resolveCssVarColor(cdp, '--state-working', 'color');
    const diffRemoved = await resolveCssVarColor(cdp, '--diff-removed', 'color');
    const destructive = await resolveCssVarColor(cdp, '--destructive', 'color');
    check(diffAdded === working && diffRemoved === destructive, `${theme.id}: --diff-added still resolves to --state-working, --diff-removed to --destructive`, { diffAdded, working, diffRemoved, destructive, agent });
    seen[theme.id] = { agent, accent };
  }
  check(seen.amethyst.agent !== seen.dark.agent && seen.amethyst.agent !== seen['light-warm-paper'].agent, 'amethyst: agent row colour differs from dark and light-warm-paper (follows the accent)', seen);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  console.log(`verify-tauri-1876: head ${head}, scratch ${SCRATCH}`);
  const exeDir = path.join(SCRATCH, 'exe');
  const shimDir = path.join(SCRATCH, 'shim');
  const launcherDir = path.join(SCRATCH, 'launcher');
  for (const d of [exeDir, shimDir, launcherDir]) mkdirSync(d, { recursive: true });
  let failed = null;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const reuse = process.env.REFRACT_1876_REUSE_EXE === '1'; // skips the ~12 min rebuild when the copy in the scratch dir is from this head
    const exeInfo = reuse
      ? { dest: path.join(exeDir, 'refract-tauri.exe'), hash: sha256OfFile(path.join(exeDir, 'refract-tauri.exe')) }
      : buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-tauri-1876' });
    report.push({ step: 'exe', ok: true, exe: exeInfo.dest, sha256: exeInfo.hash });
    await withApp('advisor', 'advisor-1430', exeInfo.dest, launcherExe, shimDir, advisoryChecks);
    await withApp('agentmsg', '997-notice-severity', exeInfo.dest, launcherExe, shimDir, themeChecks);
  } catch (err) {
    failed = err;
    report.push({ step: 'run crashed', ok: false, error: String(err?.stack ?? err) });
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, results: report }, null, 2));
  }
  if (failed) {
    console.error(failed);
    process.exitCode = 1;
  } else console.log(`verify-tauri-1876: ALL PASS; evidence in ${SHOTS_DIR}`);
}

main();
