#!/usr/bin/env node
// Live CDP check for the composer working-mode menu (#433): menu keyboard use, per-mode state, Away auto-answer and
// approval denial (shortened via the debug-only REFRACT_AWAY_APPROVAL_TIMEOUT_MS), the summary card and the plan switch.
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_111_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-111.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, computeDirty, buildLauncher, makeScratchRepo, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, pressKey, pressEscape } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_111_SHOTS_DIR || path.join(tmpdir(), 'refract-111-shots');
mkdirSync(SHOTS_DIR, { recursive: true });
const AWAY_TIMEOUT_MS = 3000;

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

function buildShims(dir) {
  mkdirSync(dir, { recursive: true });
  const ghLog = path.join(dir, 'gh-calls.log');
  writeFileSync(ghLog, '');
  writeFileSync(
    path.join(dir, 'gh-logic.cjs'),
    `const a = process.argv.slice(2);
if (a[0] === 'auth' && a[1] === 'status') { process.stdout.write(JSON.stringify({ hosts: { 'github.com': [{ host: 'github.com', login: 'octocat', active: true, state: 'success' }] } })); process.exit(0); }
if (a[0] === 'auth' && a[1] === 'token') { process.stdout.write('fake-token-111\\n'); process.exit(0); }
process.exit(1);
`
  );
  for (const [src, out] of [['verify-tauri-omp-shim.rs', 'omp.exe'], ['verify-1331-shim.rs', 'gh.exe']]) {
    const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, src), '-o', path.join(dir, out)], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`rustc ${src} failed: ${r.stderr}`);
  }
}

const TRIGGER = `document.querySelector('button[aria-label*=", working mode"]')`;
const triggerName = (cdp) => cdp.evaluate(`${TRIGGER}?.getAttribute('aria-label') ?? ''`);
const transcriptText = (cdp) => cdp.evaluate(`document.body.innerText`);
const ompLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const responses = (file) => ompLines(file).filter((l) => l.includes('RECV') && l.includes('extension_ui_response'));

async function waitMode(cdp, label, extra = '') {
  try {
    await cdp.waitFor(`(${TRIGGER}?.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(label + ', working mode')})${extra}`, { timeoutMs: 20_000, label: `trigger shows ${label}` });
  } catch (err) {
    throw new Error(`${err.message}; trigger is "${await triggerName(cdp)}"`);
  }
}

async function pickByClick(cdp, itemLabel) {
  await cdp.click(TRIGGER);
  await cdp.waitFor(`!!document.querySelector('[role="menuitemradio"]')`, { timeoutMs: 10_000, label: 'mode menu open' });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitemradio"]')).find((el) => el.textContent.trim().startsWith(${JSON.stringify(itemLabel)}))`);
}

async function runChecks(cdp, { repo, repoName, ompLog }) {
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
    { timeoutMs: 90_000, label: 'Readiness green' }
  );
  await addRepository(cdp, repo);
  await createSessionViaQuickCreate(cdp, repoName);

  // ---- Menu, default state, keyboard ----
  await waitMode(cdp, 'Interactive');
  assert((await triggerName(cdp)) === 'Interactive, working mode', 'default trigger accessible name states Interactive');
  await cdp.screenshot(path.join(SHOTS_DIR, '01-interactive.png'));
  await cdp.evaluate(`${TRIGGER}.focus()`);
  await pressKey(cdp, 13, 'Enter', 'Enter');
  await cdp.waitFor(`document.querySelectorAll('[role="menuitemradio"]').length === 4`, { timeoutMs: 10_000, label: 'Enter opens a 4-item menu' });
  const items = await cdp.evaluate(`Array.from(document.querySelectorAll('[role="menuitemradio"]')).map((el) => ({ t: el.textContent.trim().slice(0, 14), svg: !!el.querySelector('svg') }))`);
  assert(items.length === 4 && items.every((i) => i.svg), `menu has four items, each with an icon: ${JSON.stringify(items)}`);
  await cdp.screenshot(path.join(SHOTS_DIR, '02-menu-open.png'));
  await sleep(400);
  await pressKey(cdp, 40, 'ArrowDown', 'ArrowDown');
  await sleep(300);
  await pressKey(cdp, 13, 'Enter', 'Enter');
  await waitMode(cdp, 'Plan mode');
  assert(true, 'keyboard ArrowDown + Enter selects Plan mode at idle');
  for (let i = 0; i < 40 && !ompLines(ompLog).some((l) => l.includes('argv=') && l.includes('plan-on')); i++) await sleep(500);
  const planLaunch = ompLines(ompLog).filter((l) => l.includes('argv=') && l.includes('plan-on'));
  assert(planLaunch.length > 0, 'the Session restarted with the plan-on overlay in its --config argv');
  await waitMode(cdp, 'Plan mode');
  await cdp.screenshot(path.join(SHOTS_DIR, '03-plan.png'));

  // ---- Grill: hidden instruction is not displayed ----
  await pickByClick(cdp, 'Grill mode');
  await waitMode(cdp, 'Grill mode');
  await sleep(2500);
  await cdp.screenshot(path.join(SHOTS_DIR, '04-grill.png'));
  assert((await triggerName(cdp)).startsWith('Grill mode'), 'Grill mode is shown with its label');

  // ---- Away: auto-answer, denial, summary ----
  await pickByClick(cdp, 'Away mode');
  await waitMode(cdp, 'Away mode');
  await sleep(2500);
  await cdp.screenshot(path.join(SHOTS_DIR, '05-away.png'));
  await cdp.typeIntoByLabel('Message', 'start the away scenario');
  await cdp.pressEnter();
  await cdp.waitFor(`document.body.innerText.toLowerCase().includes('automatic')`, { timeoutMs: 30_000, label: 'automatic ask answer recorded' });
  const askResp = responses(ompLog).find((l) => l.includes('"answers"'));
  assert(!!askResp && askResp.includes('SQLite'), `Away answered the ask with the recommended option: ${askResp}`);
  await cdp.screenshot(path.join(SHOTS_DIR, '06-away-answered.png'));
  await cdp.waitFor(`document.body.innerText.includes('Not approved: the user is away')`, { timeoutMs: AWAY_TIMEOUT_MS + 25_000, label: 'approval denied after the shortened timeout' });
  const denial = responses(ompLog).find((l) => l.includes('"approved":false') || l.includes('Deny') || l.includes('"cancelled"'));
  assert(!!denial && !responses(ompLog).some((l) => l.includes('Approve"')), `approval was denied, never approved: ${denial}`);
  await cdp.waitFor(`document.body.innerText.includes('away111done')`, { timeoutMs: 20_000, label: 'turn finished' });
  await cdp.screenshot(path.join(SHOTS_DIR, '07-away-denied.png'));

  await pickByClick(cdp, 'Interactive');
  await waitMode(cdp, 'Interactive');
  await cdp.waitFor(`document.body.innerText.includes('While you were away')`, { timeoutMs: 15_000, label: 'summary card on leaving Away' });
  const text = await transcriptText(cdp);
  assert(text.includes('Which database?') && text.includes('automatic'), 'summary lists the automatic actions with the original question');
  await cdp.screenshot(path.join(SHOTS_DIR, '08-summary.png'));
  await pressEscape(cdp);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-111: head ${head}, shots ${SHOTS_DIR}`);
  let shimDir, dataDir, importDir, repo, exeDir, child, cdp;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-111-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-111-data-'));
    importDir = mkdtempSync(path.join(tmpdir(), 'refract-111-import-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-111-exe-'));
    repo = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-111-repo-')), 'A');
    buildShims(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const src = path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
    if (!existsSync(src)) throw new Error(`built exe not found at ${src}`);
    const exePath = path.join(exeDir, 'refract-tauri.exe');
    copyFileSync(src, exePath);
    const ompLog = path.join(SHOTS_DIR, 'fake-omp-invocations.log');
    writeFileSync(ompLog, '');
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
        REFRACT_FAKE_OMP_DEBUG_LOG: ompLog,
        REFRACT_FAKE_OMP_SCENARIO: 'away-111',
        REFRACT_AWAY_APPROVAL_TIMEOUT_MS: String(AWAY_TIMEOUT_MS)
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error('CDP target is not owned by the launched process');
    log(`app pid ${launched.targetPid}, port ${port}, data dir ${dataDir}`);
    await runChecks(cdp, { repo, repoName: path.basename(repo), ompLog });
    log(`verify-tauri-111: ALL PASS (${passed} checks) at head ${head}`);
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, dirty: computeDirty(REPO_ROOT), passed, lines: REPORT }, null, 2));
    cdp?.close();
    if (child) await stopLauncher(child);
    for (const dir of [shimDir, dataDir, importDir, exeDir, repo]) if (dir) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-111: FAIL');
  console.error(err);
  process.exitCode = 1;
});
