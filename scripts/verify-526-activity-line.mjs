#!/usr/bin/env node
// Live CDP check for issue #526: the Session row's Activity line. Two Sessions (one open, one in
// the background) both play the `activity-line-526` fake-omp tape: a long "Working..." stretch,
// then intent, subagents, todo, a pending question and a pending approval. Copies the already
// built debug exe (it never rebuilds); evidence goes to REFRACT_526_SHOTS_DIR.

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-526';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_526_SHOTS_DIR || path.join(tmpdir(), 'refract-526-shots');

const PLAYFUL = ['Thinking hard…', 'Connecting the dots…', 'Rolling up sleeves…', 'Piecing it together…', 'Turning it over…', 'Mulling it over…', 'Following the thread…', 'Sketching a plan…', 'Gathering thoughts…', 'Working the problem…', 'Lining things up…', 'Making progress…'];
const BANNER_TEXT = `(document.querySelector('[data-testid="current-work-banner-text"]')?.textContent ?? null)`;

const report = [];
function check(ok, label, evidence) {
  report.push({ step: label, ok: ok === true, evidence });
  console.log(`${LOG}: ${ok ? 'PASS' : 'FAIL'} ${label} ${evidence === undefined ? '' : JSON.stringify(evidence)}`);
}

// One entry per Session row: open flag, Activity line text, branch text, and its description.
const ROWS = `(() => Array.from(document.querySelectorAll('li[data-choice-item]')).map((li) => {
  const btn = li.querySelector('button[aria-describedby]');
  const ids = (btn?.getAttribute('aria-describedby') ?? '').split(/\\s+/).filter(Boolean);
  return {
    open: !!li.querySelector('[aria-current]'),
    activity: li.querySelector('[data-testid="session-activity-line"]')?.textContent ?? null,
    branch: li.querySelector('span.font-code')?.textContent ?? null,
    described: ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' | ')
  };
}))()`;

// Runs in the page: every 100 ms, records each distinct Activity line a Session row showed,
// keyed by Session name and whether its row was the open one at the time.
function installSampler() {
  window.__seen = {};
  setInterval(() => {
    for (const li of document.querySelectorAll('li[data-choice-item]')) {
      const btn = li.querySelector('button[aria-describedby]');
      const text = (btn?.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
      const name = (text.match(/\. (\S+) from /) ?? [])[1] ?? '?';
      const act = li.querySelector('[data-testid="session-activity-line"]')?.textContent ?? null;
      const key = `${name} ${li.querySelector('[aria-current]') ? '(open)' : '(background)'}`;
      window.__seen[key] ??= [];
      if (act && !window.__seen[key].includes(act)) window.__seen[key].push(act);
    }
  }, 100);
  return true;
}

const rowsNow = (cdp) => cdp.evaluate(ROWS);
const openRow = async (cdp) => (await rowsNow(cdp)).find((r) => r.open);
const bgRow = async (cdp) => (await rowsNow(cdp)).find((r) => !r.open);
async function shot(cdp, name) {
  await sleep(300);
  await cdp.screenshot(path.join(SHOTS_DIR, name));
}
async function waitRows(cdp, pred, label, timeoutMs = 90_000) {
  await cdp.waitFor(`(() => { const r = ${ROWS}; return r.length >= 2 && (${pred.toString()})(r); })()`, { timeoutMs, label });
  return rowsNow(cdp);
}

async function openAppearance(cdp) {
  if (!(await cdp.evaluate(`!!document.querySelector('[aria-label="Back to chat"]')`))) {
    await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  }
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Appearance')`);
  await cdp.waitFor(`!!document.getElementById('activity-text-label')`, { timeoutMs: 10_000, label: 'Appearance mounted' });
}
async function backToChat(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 10_000, label: 'Back in chat' });
}
async function setActivityText(cdp, label) {
  await openAppearance(cdp);
  await cdp.evaluate(`document.getElementById('activity-text-label').scrollIntoView({ block: 'center' })`);
  await sleep(300);
  await cdp.click(`Array.from(document.querySelectorAll('[aria-labelledby="activity-text-label"] button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)})`);
  await cdp.waitFor(`Array.from(document.querySelectorAll('[aria-labelledby="activity-text-label"] button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)})?.getAttribute('data-state') === 'on'`, { timeoutMs: 5_000, label: `${label} selected` });
}
const selectedActivityText = (cdp) => cdp.evaluate(`Array.from(document.querySelectorAll('[aria-labelledby="activity-text-label"] button')).find((el) => el.getAttribute('data-state') === 'on')?.textContent.trim() ?? null`);

async function createSession(cdp) {
  await cdp.clickByLabel('New session from a branch in ', { prefix: true });
  await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'New session dialog open' });
  await cdp.clickByText('Create session', { inDialog: true });
  await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 90_000, label: 'dialog closed' });
  await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'composer enabled' });
}
async function prompt(cdp, text) {
  await sleep(4000);
  await cdp.typeIntoByLabel('Message', text);
  await cdp.clickByLabel('Send message');
}

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
      REFRACT_FAKE_OMP_DEBUG_LOG: path.join(SHOTS_DIR, 'fake-omp-invocations.log'),
      REFRACT_FAKE_OMP_SCENARIO: 'activity-line-526'
    }
  });
  const cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
  if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target not owned by launched pid');
  console.log(`${LOG}: launched exe pid ${launched.targetPid} on port ${port}`);
  return { cdp, child: launched.child };
}

async function answerQuestion(cdp) {
  await cdp.waitFor(`!!document.querySelector('[role="radio"]')`, { timeoutMs: 10_000, label: 'question card' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="radio"]')).find((el) => (el.textContent ?? '').includes('Postgres'))`);
  await cdp.clickByText('Submit');
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-526-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-526-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-526-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-526-activity');
  const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-526-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-526-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-526-shim-'));
  const exe = path.join(exeDir, 'refract-tauri.exe');
  let session;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    copyFileSync(path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe'), exe);
    const env = { launcherExe, exe, dataDir, shimDir, exeDir, importSourceDir };
    session = await launch(env);
    let { cdp } = session;

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness' });
    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 60_000, label: 'Readiness green' });
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repo dialog' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`, { timeoutMs: 30_000, label: 'Repo added' });

    await createSession(cdp);
    await prompt(cdp, 'first');
    await createSession(cdp);
    await prompt(cdp, 'second');

    await cdp.evaluate(`(${installSampler.toString()})()`);
    // (1)(2) both rows working, Plain fallback in row and banner.
    let rows = await waitRows(cdp, (r) => r.every((x) => x.activity === 'Working…'), 'both rows show Working…', 30_000);
    check(rows.length === 2 && rows.some((r) => r.open) && rows.some((r) => !r.open), 'two rows, one open one background', rows);
    check(rows.every((r) => r.activity === 'Working…' && !r.branch), 'Plain: both rows show "Working…" in place of the branch', rows);
    check(/Working…/.test(await cdp.evaluate(BANNER_TEXT)), 'Plain: banner shows Working…', await cdp.evaluate(BANNER_TEXT));
    await shot(cdp, '01-plain-working.png');

    // (5) Playful, live, rotating.
    await setActivityText(cdp, 'Playful');
    await shot(cdp, '02-settings-playful.png');
    await backToChat(cdp);
    rows = await waitRows(cdp, (r) => r.every((x) => x.activity && x.activity !== 'Working…'), 'rows go playful', 10_000);
    const p1 = rows.map((r) => r.activity);
    const b1 = await cdp.evaluate(BANNER_TEXT);
    check(p1.every((t) => PLAYFUL.includes(t)), 'Playful: both rows show a phrase from the Playful set', p1);
    check(PLAYFUL.some((t) => b1.includes(t)), 'Playful: banner shows a Playful phrase', b1);
    await shot(cdp, '03-playful-a.png');
    const start = Date.now();
    await cdp.waitFor(`JSON.stringify(${ROWS}.map((x) => x.activity)) !== ${JSON.stringify(JSON.stringify(p1))}`, { timeoutMs: 14_000, label: 'phrase rotates' }).catch(() => {});
    await sleep(500);
    const p2 = (await rowsNow(cdp)).map((r) => r.activity);
    const b2 = await cdp.evaluate(BANNER_TEXT);
    check(JSON.stringify(p2) !== JSON.stringify(p1) && p2.every((t) => PLAYFUL.includes(t)), `Playful: phrases rotated within ${Date.now() - start} ms`, { before: p1, after: p2, bannerBefore: b1, bannerAfter: b2 });
    await shot(cdp, '04-playful-b.png');

    // Plain again, live.
    await setActivityText(cdp, 'Plain');
    await backToChat(cdp);
    rows = await waitRows(cdp, (r) => r.every((x) => x.activity === 'Working…'), 'rows return to Working…', 10_000);
    check(true, 'Plain again: rows return to "Working…" live', { rows, banner: await cdp.evaluate(BANNER_TEXT) });
    await setActivityText(cdp, 'Playful');
    await backToChat(cdp);

    // (1)(2) intent, subagents, todo: the two Sessions run ~8 s apart, so wait for ANY row to show each state, then
    // assert from the in-page sampler that BOTH Sessions (including while open) showed it.
    for (const [re, shotName, label] of [[/Reading ChatPane\.tsx/, '05-intent.png', 'intent'], [/Waiting for 2 subagents/, '06-subagents.png', 'subagents'], [/^Task 1 of 2 · Wire the banner$/, '06b-todo.png', 'todo']]) {
      await cdp.waitFor(`(${ROWS}).some((x) => ${re.toString()}.test(x.activity ?? ''))`, { timeoutMs: 90_000, intervalMs: 100, label: `a row shows ${label}` });
      await shot(cdp, shotName);
      console.log(`${LOG}: rows at ${label}: ${JSON.stringify((await rowsNow(cdp)).map((r) => ({ open: r.open, activity: r.activity, branch: r.branch })))}`);
    }
    // (3) needs-you question.
    rows = await waitRows(cdp, (r) => r.every((x) => /^Needs your input: Which database\?$/.test(x.activity ?? '')), 'rows show the question', 30_000);
    const bq = await cdp.evaluate(BANNER_TEXT);
    check(true, 'Question: both rows show "Needs your input: Which database?"', rows);
    check(/Needs your input: Which database\?/.test(bq), 'Question: banner shows the question text', bq);
    await shot(cdp, '08-question.png');
    const seen = await cdp.evaluate('window.__seen');
    const sessionsSeen = [...new Set(Object.keys(seen).map((k) => k.replace(/ \((open|background)\)$/, '')))];
    for (const re of [/Reading ChatPane\.tsx/, /Waiting for 2 subagents/, /^Task 1 of 2 · Wire the banner$/]) {
      const all = Object.keys(seen).filter((k) => seen[k].some((t) => re.test(t)));
      const bySession = sessionsSeen.every((n) => all.some((k) => k.startsWith(`${n} `)));
      check(bySession, `Both Sessions showed ${re} on their row`, all);
      check(all.some((k) => k.endsWith('(open)')), `${re} was shown on an OPEN Session row`, all);
    }
    console.log(`${LOG}: sampler ${JSON.stringify(seen)}`);
    // (6) hover card + aria-describedby on the open row's trigger.
    const full = (await openRow(cdp)).activity;
    const rect = await cdp.evaluate(`(() => { const r = document.querySelector('li[data-choice-item] button[aria-describedby]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await sleep(500);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + 2, y: rect.y + 1 });
    await cdp.waitFor(`Array.from(document.querySelectorAll('[data-radix-popper-content-wrapper]')).some((w) => w.textContent.includes(${JSON.stringify(full)}))`, { timeoutMs: 12_000, label: 'details card' }).catch(() => {});
    const cardText = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-radix-popper-content-wrapper]')).map((w) => w.textContent).find((t) => t.includes(${JSON.stringify(full)})) ?? null`);
    check(!!cardText && cardText.includes(full), 'Hover details card contains the full Activity text', { full, cardText });
    const rowsH = await rowsNow(cdp);
    check(rowsH.every((r) => r.described.includes(full)), 'Rows aria-describedby include the Activity text', rowsH.map((r) => r.described));
    await shot(cdp, '07-hover-card.png');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });

    await answerQuestion(cdp);

    // Open Session: approval.
    await cdp.waitFor(`(() => { const r = ${ROWS}.find((x) => x.open); return !!r && /^Waiting for approval: bash pnpm install$/.test(r.activity ?? ''); })()`, { timeoutMs: 30_000, label: 'open row approval' });
    const ro = await openRow(cdp);
    const ba = await cdp.evaluate(BANNER_TEXT);
    check(true, 'Approval: open row shows "Waiting for approval: bash pnpm install"', ro);
    check(/Waiting for approval: bash pnpm install/.test(ba), 'Approval: banner shows the approval text', ba);
    await shot(cdp, '09-approval.png');
    const t0 = Date.now();
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 300 });
    await sleep(600);
    await cdp.clickByText('Approve');
    await cdp.waitFor(`(() => { const r = ${ROWS}.find((x) => x.open); return !!r && r.activity === null && !!r.branch; })()`, { timeoutMs: 6_000, intervalMs: 50, label: 'open row idle' });
    check(true, `Idle: open row reverted to the branch ${Date.now() - t0} ms after approval`, await openRow(cdp));
    await shot(cdp, '10-open-idle.png');

    // Background Session: question already answered? no -- it is still waiting. Open it and walk it through.
    const bg = await bgRow(cdp);
    check(/Needs your input: Which database\?/.test(bg.activity ?? ''), 'Background row still shows its question while the open one finished', bg);
    await cdp.click(`Array.from(document.querySelectorAll('li[data-choice-item]')).find((li) => li.querySelector('[data-testid="session-activity-line"]'))?.querySelector('button[aria-describedby]')`);
    await answerQuestion(cdp);
    await cdp.waitFor(`(() => { const r = ${ROWS}.find((x) => x.open); return !!r && /^Waiting for approval: bash pnpm install$/.test(r.activity ?? ''); })()`, { timeoutMs: 30_000, label: 'second row approval' });
    check(true, 'Approval on the second Session row', await openRow(cdp));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 300 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1000, y: 230, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1000, y: 230, button: 'left', clickCount: 1 });
    await sleep(1500);
    await cdp.evaluate(`Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Approve')?.click()`);
    await cdp.waitFor(`${ROWS}.every((r) => r.activity === null && !!r.branch)`, { timeoutMs: 8_000, intervalMs: 50, label: 'all idle' });
    check(true, 'Idle: every row back to the branch', await rowsNow(cdp));
    check((await cdp.evaluate(BANNER_TEXT)) === null, 'Idle: banner gone', await cdp.evaluate(BANNER_TEXT));
    await shot(cdp, '11-all-idle.png');

    // Persistence across a relaunch.
    check((await (async () => { await openAppearance(cdp); return selectedActivityText(cdp); })()) === 'Playful', 'Before relaunch: Playful selected', null);
    cdp.close();
    await stopLauncher(session.child).catch(() => {});
    await sleep(2000);
    session = await launch(env);
    cdp = session.cdp;
    await cdp.waitFor(`!!document.querySelector('[aria-label="Settings"]')`, { timeoutMs: 60_000, label: 'app after relaunch' });
    await openAppearance(cdp);
    const after = await selectedActivityText(cdp);
    check(after === 'Playful', 'After relaunch: Activity text is still Playful', after);
    await shot(cdp, '12-after-relaunch-settings.png');
    await setActivityText(cdp, 'Plain');
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
  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main();
