#!/usr/bin/env node
// Live CDP check for issue #1300 (chat row verb emphasis + Tight / Compact / Comfy row density).
// Drives the already built debug exe against the FAKE `omp` shim (`mid-turn-prose-1236` tape:
// Note, tool, Note, tool, final reply). Proves: the verb is full foreground on non-agent rows,
// the gap between consecutive bookkeeping rows (Note rows included) is 8/4/16 px for
// Compact/Tight/Comfy while the turn gap stays 24 px, and the setting survives a restart.
// Usage: CARGO_TARGET_DIR=<shared target dir> node scripts/verify-1300-chat-row-density.mjs

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1300';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1300_SHOTS_DIR || path.join(tmpdir(), 'refract-1300-shots');

const report = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
}
const shot = async (cdp, name) => {
  await sleep(300);
  await cdp.screenshot(path.join(SHOTS_DIR, name));
};

// One entry per transcript row wrapper: its kind, margin-top and rendered gap above it.
const ROWS = `(() => {
  const items = Array.from(document.querySelectorAll('[data-slot="message-scroller-item"]')).filter((el) => el.offsetHeight > 0);
  return items.map((el, i) => {
    const btn = el.querySelector('button[aria-expanded]');
    const kind = el.querySelector('[data-slot="message"]') ? 'message' : /^Note/.test(btn?.textContent.trim() ?? '') ? 'note' : btn ? 'tool' : 'other';
    const prev = i > 0 ? items[i - 1] : null;
    return { kind, mt: getComputedStyle(el).marginTop, gap: prev ? Math.round(el.getBoundingClientRect().top - prev.getBoundingClientRect().bottom) : null, text: el.textContent.trim().slice(0, 40) };
  });
})()`;

const VERBS = `(() => {
  const probe = document.createElement('span');
  probe.className = 'text-foreground';
  document.body.appendChild(probe);
  const fg = getComputedStyle(probe).color;
  probe.remove();
  return { fg, rows: Array.from(document.querySelectorAll('button[aria-expanded]')).map((b) => {
    const label = b.querySelector('[data-slot="collapsed-line-label"]');
    return label ? { label: label.textContent.trim().slice(0, 30), labelColor: getComputedStyle(label).color, sibling: label.nextElementSibling ? getComputedStyle(label.nextElementSibling).color : null } : null;
  }).filter(Boolean) };
})()`;

async function launch(env) {
  const port = await getFreePort();
  const launched = await launchBuiltExe(env.launcherExe, env.exe, {
    port,
    dataDir: env.dataDir,
    pathPrepend: env.shimDir,
    logFile: path.join(SHOTS_DIR, `app-${port}.log`),
    extraEnv: {
      REFRACT_IMPORT_SOURCE_DIR: env.importSourceDir,
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      REFRACT_FAKE_OMP_SCENARIO: 'mid-turn-prose-1236'
    }
  });
  const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
  if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target not owned by launched pid');
  console.log(`${LOG}: launched exe pid ${launched.targetPid} on port ${port}`);
  return { cdp, child: launched.child };
}

async function openAppearance(cdp) {
  if (!(await cdp.evaluate(`!!document.querySelector('[aria-label="Back to chat"]')`))) {
    await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  }
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Appearance')`);
  await cdp.waitFor(`!!document.getElementById('chat-row-density-label')`, { timeoutMs: 10_000, label: 'Chat row spacing mounted' });
  await cdp.evaluate(`document.getElementById('chat-row-density-label').scrollIntoView({ block: 'center' })`);
  await sleep(300);
}
const selectedDensity = (cdp) =>
  cdp.evaluate(`Array.from(document.querySelectorAll('[aria-labelledby="chat-row-density-label"] button')).find((el) => el.getAttribute('data-state') === 'on')?.textContent.trim() ?? null`);
async function setDensity(cdp, label) {
  await openAppearance(cdp);
  await cdp.click(`Array.from(document.querySelectorAll('[aria-labelledby="chat-row-density-label"] button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)})`);
  await cdp.waitFor(`Array.from(document.querySelectorAll('[aria-labelledby="chat-row-density-label"] button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)})?.getAttribute('data-state') === 'on'`, { timeoutMs: 5_000, label: `${label} selected` });
}
async function backToChat(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 10_000, label: 'Back in chat' });
  await sleep(500);
}

// Gap between consecutive bookkeeping rows (note/tool) and before the final message.
function summarise(rows) {
  const pairs = rows.filter((r, i) => i > 0 && rows[i - 1].kind !== 'message' && r.kind !== 'message' && r.kind !== 'other' && rows[i - 1].kind !== 'other');
  const final = rows.filter((r, i) => i > 0 && r.kind === 'message' && rows[i - 1].kind !== 'message').map((r) => r.mt);
  return { pairMargins: [...new Set(pairs.map((r) => r.mt))], pairGaps: pairs.map((r) => r.gap), pairKinds: pairs.map((r) => r.kind), finalMargins: final };
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1300-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1300-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1300-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1300-density');
  const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1300-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1300-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1300-shim-'));
  const exe = path.join(exeDir, 'refract-tauri.exe');
  let session;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    copyFileSync(path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe'), exe);
    const env = { launcherExe, exe, dataDir, shimDir, importSourceDir };
    session = await launch(env);
    let { cdp } = session;

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await cdp.openLocalFolderDialog();
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repo dialog' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`, { timeoutMs: 30_000, label: 'Repo added' });
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'New session dialog' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 90_000, label: 'dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'composer enabled' });
    await sleep(3000);
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);
    await cdp.send('Input.insertText', { text: 'do the multi-tool turn' });
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`Array.from(document.querySelectorAll('button[aria-expanded]')).filter((b) => /^Note/.test(b.textContent.trim())).length === 2 && Array.from(document.querySelectorAll('[data-slot="message"]')).some((m) => m.textContent.includes('FINAL-REPLY-1236'))`, { timeoutMs: 60_000, label: 'Two Notes and the final reply' });
    await sleep(800);

    // Verb emphasis.
    const verbs = await cdp.evaluate(VERBS);
    check(verbs.rows.length >= 3 && verbs.rows.every((r) => r.labelColor === verbs.fg), 'Verb emphasis: every collapsed-row label is full foreground', verbs);
    check(verbs.rows.some((r) => r.sibling && r.sibling !== r.labelColor), 'Verb emphasis: the summary/object stays a different (muted) colour', verbs.rows.map((r) => [r.label, r.labelColor, r.sibling]));

    // Compact (default).
    let rows = await cdp.evaluate(ROWS);
    let s = summarise(rows);
    check((await (async () => { await openAppearance(cdp); const v = await selectedDensity(cdp); await shot(cdp, '01-settings-default.png'); await backToChat(cdp); return v; })()) === 'Compact', 'Default: Compact is selected out of the box', null);
    rows = await cdp.evaluate(ROWS);
    s = summarise(rows);
    check(s.pairKinds.includes('note') && s.pairKinds.includes('tool'), 'Run contains Note rows and tool rows', s);
    check(s.pairMargins.length === 1 && s.pairMargins[0] === '8px', 'Compact: every bookkeeping pair (Notes included) has an 8px margin', s);
    check(s.finalMargins.every((m) => m === '24px') && s.finalMargins.length > 0, 'Compact: the turn gap before the final reply stays 24px', s);
    await shot(cdp, '02-transcript-compact.png');

    for (const [label, px, file] of [['Tight', '4px', '03-transcript-tight.png'], ['Comfy', '16px', '04-transcript-comfy.png']]) {
      await setDensity(cdp, label);
      await shot(cdp, `settings-${label.toLowerCase()}.png`);
      await backToChat(cdp);
      rows = await cdp.evaluate(ROWS);
      s = summarise(rows);
      check(s.pairMargins.length === 1 && s.pairMargins[0] === px && s.pairGaps.every((g) => g === Number.parseInt(px, 10)), `${label}: every bookkeeping pair has a ${px} margin and a rendered ${px} gap`, s);
      check(s.finalMargins.every((m) => m === '24px'), `${label}: the turn gap stays 24px`, s);
      await shot(cdp, file);
    }

    // Persistence across a restart (Comfy is still selected).
    await setDensity(cdp, 'Comfy');
    cdp.close();
    await stopLauncher(session.child).catch(() => {});
    await sleep(2500);
    const files = readdirSync(dataDir).filter((f) => f.endsWith('.json'));
    const onDisk = files.map((f) => readFileSync(path.join(dataDir, f), 'utf8')).find((t) => t.includes('chatRowDensity')) ?? '';
    check(/"chatRowDensity":\s*"comfy"/.test(onDisk), 'Persisted: settings file on disk holds chatRowDensity "comfy"', files);
    session = await launch(env);
    cdp = session.cdp;
    await cdp.waitFor(`!!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 60_000, label: 'app after relaunch' });
    await openAppearance(cdp);
    const after = await selectedDensity(cdp);
    check(after === 'Comfy', 'After relaunch: Chat row spacing is still Comfy', after);
    await shot(cdp, '05-after-relaunch-settings.png');
    await setDensity(cdp, 'Compact');
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
