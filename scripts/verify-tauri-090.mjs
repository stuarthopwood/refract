#!/usr/bin/env node
// Live CDP check for spec 090 UI paths (Question card hint and advance-never-submit, Settings suspect-window notice)
// against a built Tauri debug exe with fake `omp` (ask tape and a scratch model catalog), a scratch REFRACT_DATA_DIR and
// its own debugging port (never %APPDATA%\refract-tauri). The composer spelling menu needs the Windows spell checker
// and is not driven here.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_090_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-090.mjs

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, groupTriggerFinder } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_090_SHOTS_DIR || path.join(tmpdir(), 'refract-090-shots');
mkdirSync(SHOTS_DIR, { recursive: true });

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
const rowFinder = (role, label) => `(() => {
  const els = Array.from(document.querySelectorAll('[role="${role}"]'));
  return els.find((el) => { const s = el.querySelector('.col-start-2.break-words'); const n = s && s.firstChild; return !!n && typeof n.nodeValue === 'string' && n.nodeValue.trim() === ${JSON.stringify(label)}; });
})()`;

async function checkQuestionCard(cdp) {
  await cdp.typeIntoByLabel('Message', 'Please ask me the batch of questions now.');
  await cdp.clickByLabel('Send message');
  await cdp.waitFor(`document.querySelectorAll('[role="tab"]').length === 2`, { timeoutMs: 30_000, label: 'Question card tab row rendered' });
  const hint = `Array.from(document.querySelectorAll('p')).find((p) => p.textContent.includes('moves to the next unanswered question'))`;
  assert(await cdp.evaluate(`!!(${hint})`), 'Single-choice hint is shown while another question is incomplete');
  const described = await cdp.evaluate(`(() => { const h = ${hint}; const g = document.querySelector('[role="radiogroup"]'); return !!h && !!g && (g.getAttribute('aria-describedby') ?? '').split(' ').includes(h.id); })()`);
  assert(described, 'The radio group is described by the hint');
  const order = await cdp.evaluate(`(() => { const h = ${hint}; const input = document.querySelector('[aria-label="Other answer"]'); return !!(input.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING); })()`);
  assert(order, 'The hint sits after the Other answer input');
  await shot(cdp, '01-question-hint.png');
  await cdp.click(rowFinder('radio', 'Postgres'));
  await cdp.waitFor(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.includes('Features')`, { timeoutMs: 15_000, label: 'Features tab active after the pick' });
  const buttons = await cdp.evaluate(`Array.from(document.querySelectorAll('button')).map((b) => b.textContent.trim())`);
  assert(!buttons.some((t) => t.startsWith('Submit')) && buttons.some((t) => t.startsWith('Next')), `The pick advanced without submitting: footer still reads Next (buttons: ${JSON.stringify(buttons)})`);
  await shot(cdp, '02-question-advanced-not-submitted.png');
  await cdp.click(rowFinder('checkbox', 'Auth'));
  await cdp.click(`Array.from(document.querySelectorAll('[role="tab"]')).find((t) => t.textContent.includes('Database'))`);
  await cdp.click(rowFinder('radio', 'Postgres'));
  await sleep(400);
  const submitNow = await cdp.evaluate(`Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim().startsWith('Submit'))`);
  assert(submitNow, 'With every question answered, only the Submit button submits (it is offered, the card is still open)');
  await shot(cdp, '03-question-all-answered.png');
}

async function checkSettingsNotice(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings opened' });
  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Models')`);
  await cdp.waitFor(`!!document.querySelector('[data-slot="alert"][role="note"]')`, { timeoutMs: 20_000, label: 'Suspect-window notice mounted' });
  const layout = await cdp.evaluate(`(() => {
    const alert = document.querySelector('[data-slot="alert"][role="note"]');
    const title = alert.querySelector('[data-slot="alert-title"]');
    const actions = alert.querySelector('[data-slot="alert-actions"]');
    const link = actions.querySelector('a');
    const t = title.getBoundingClientRect(); const a = actions.getBoundingClientRect(); const ar = alert.getBoundingClientRect();
    return { title: title.textContent.trim(), titleLeft: Math.round(t.left), actionsLeft: Math.round(a.left), actionsInside: a.right <= ar.right + 1, link: link.textContent.trim(), href: link.href, target: link.target, sr: /opens in a new tab/.test(link.textContent) };
  })()`);
  log(`notice layout: ${JSON.stringify(layout)}`);
  await shot(cdp, '04-settings-suspect-notice.png');
  assert(layout.title === 'Some context windows may be wrong', 'Notice title reads "Some context windows may be wrong"');
  assert(layout.actionsLeft === layout.titleLeft, 'The link row aligns with the title column, not under the icon');
  assert(layout.actionsInside, 'The link row stays inside the alert');
  assert(layout.link.includes('Why this window may be wrong (oh-my-pi#17481)') && layout.sr && layout.target === '_blank', 'The link uses the shake-menu label, opens in a new tab and announces it');
  assert(await cdp.evaluate(`document.querySelector('[data-slot="alert"][role="note"]').textContent.includes('modelOverrides')`), 'The note names the next step');
}

function buildShim(dir) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', path.join(dir, 'omp.exe')], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`rustc shim failed: ${r.stderr}`);
}

async function runChecks(cdp, { repoDir }) {
  await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 120_000, label: 'Readiness screen mounted' });
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 60_000, label: 'Readiness green (fake omp)' }
  );
  await addRepository(cdp, repoDir);
  const repoName = path.basename(repoDir);
  await cdp.waitFor(groupTriggerFinder(repoName) + ' !== undefined', { timeoutMs: 15_000, label: 'Project rendered' });
  await createSessionViaQuickCreate(cdp, repoName);
  await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Composer enabled' });
  await checkQuestionCard(cdp);
  await checkSettingsNotice(cdp);
  await shot(cdp, '99-final.png');
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-090: head ${head}, shots ${SHOTS_DIR}`);
  let shimDir, dataDir, importDir, exeDir, repoA, catalogDir, child, cdp;
  let ok = false;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-090-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-090-data-'));
    importDir = mkdtempSync(path.join(tmpdir(), 'refract-090-import-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-090-exe-'));
    catalogDir = mkdtempSync(path.join(tmpdir(), 'refract-090-catalog-'));
    repoA = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-090-repoA-')), 'A');
    const entry = (id, name) => ({ provider: 'scratch', id, selector: `scratch/${id}`, name, reasoning: false, thinking: null, contextWindow: 200000 });
    const catalogPath = path.join(catalogDir, 'catalog.json');
    writeFileSync(catalogPath, JSON.stringify({ chat: [entry('big', 'Scratch Big'), entry('big-1m', 'Scratch Big 1M')] }));
    buildShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const src = process.env.REFRACT_090_EXE_SRC || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
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
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'ask',
        REFRACT_FAKE_OMP_MODEL_CATALOG: catalogPath
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    log(`app pid ${launched.targetPid}, port ${port}, data dir ${dataDir}`);
    await runChecks(cdp, { repoDir: repoA });
    log(`verify-tauri-090: ALL PASS (${passed} checks) at head ${head}`);
    ok = true;
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.txt'), REPORT.join('\n'));
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, ok, checks: passed, log: REPORT }, null, 2));
    cdp?.close();
    if (child) await stopLauncher(child);
    for (const dir of [shimDir, dataDir, importDir, exeDir, catalogDir, repoA]) if (dir) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-090: FAIL');
  console.error(err);
  process.exitCode = 1;
});
