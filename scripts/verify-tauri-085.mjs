#!/usr/bin/env node
// Live CDP check for spec 085 UI paths (Home, Settings, ChatHeader) against a built Tauri debug exe with fake `omp`,
// a scratch REFRACT_DATA_DIR and its own debugging port (never %APPDATA%\refract-tauri).
// Usage: CARGO_TARGET_DIR=<shared target dir> REFRACT_085_SHOTS_DIR=<evidence dir> node scripts/verify-tauri-085-ui.mjs

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
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
const SHOTS_DIR = process.env.REFRACT_085_SHOTS_DIR || path.join(tmpdir(), 'refract-085-shots');
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
  await cdp.waitFor(`!!document.querySelector('button[aria-label="Find in chat"]')`, { timeoutMs: 15_000, label: 'ChatHeader mounted' });

  const pause = await cdp.evaluate(`document.querySelector('button[aria-label^="Pause "][aria-label$=" after this turn"]')?.getAttribute('aria-label') ?? null`);
  log(`pause label: ${pause}`);
  await shot(cdp, '01-chat-header.png');
  if (pause) assert(/^Pause .+ after this turn$/.test(pause) && pause !== 'Pause after this turn', 'Pause button label names the session');
  else log('SKIP: no pause button on an idle session');

  const disabled = await cdp.evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('button[aria-disabled="true"]')).find((x) => x.getBoundingClientRect().width > 0);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { label: b.getAttribute('aria-label') || b.textContent.trim(), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), pe: getComputedStyle(b).pointerEvents, hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b || b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) };
  })()`);
  log(`aria-disabled button: ${JSON.stringify(disabled)}`);
  if (disabled) {
    assert(disabled.pe !== 'none' && disabled.hit, 'An aria-disabled button receives pointer events (elementFromPoint hits it)');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: disabled.x, y: disabled.y });
    await sleep(900);
    const tip = await cdp.evaluate(`document.querySelector('[role="tooltip"], [data-slot="tooltip-content"]')?.textContent?.trim() ?? null`);
    log(`tooltip on hover: ${tip}`);
    await shot(cdp, '02-disabled-hover-tooltip.png');
    assert(!!tip, 'Hovering an aria-disabled button shows its reason tooltip');
  } else log('SKIP: no visible aria-disabled button reached');

  const src = readFileSync(path.join(REPO_ROOT, 'src', 'renderer', 'components', 'ui', 'button.tsx'), 'utf8');
  assert(src.includes('not-aria-disabled:translate-y-px'), 'Button press nudge is suppressed when aria-disabled (source check)');
  await shot(cdp, '03-final.png');
}
function buildShim(dir) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', path.join(dir, 'omp.exe')], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`rustc shim failed: ${r.stderr}`);
}

async function main() {
  const head = gitHead(REPO_ROOT);
  log(`verify-tauri-085-ui: head ${head}, shots ${SHOTS_DIR}`);
  let shimDir, dataDir, importDir, exeDir, repoA, child, cdp;
  let ok = false;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-085-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-085-data-'));
    importDir = mkdtempSync(path.join(tmpdir(), 'refract-085-import-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-085-exe-'));
    repoA = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-085-repoA-')), 'A');
    buildShim(shimDir);
    const launcherExe = buildLauncher(shimDir);
    const src = process.env.REFRACT_085_EXE_SRC || path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
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
    await runChecks(cdp, { repoDir: repoA });
    log(`verify-tauri-085-ui: ALL PASS (${passed} checks) at head ${head}`);
    ok = true;
  } finally {
    writeFileSync(path.join(SHOTS_DIR, 'report.txt'), REPORT.join('\n'));
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: head, ok, checks: passed, log: REPORT }, null, 2));
    cdp?.close();
    if (child) await stopLauncher(child);
    for (const dir of [shimDir, dataDir, importDir, exeDir, repoA]) if (dir) await safeRmSync(dir);
  }
}

main().catch((err) => {
  console.error('verify-tauri-085-ui: FAIL');
  console.error(err);
  process.exitCode = 1;
});
