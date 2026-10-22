// scripts/verify-777-transcript-memo.mjs
// Live check for #777 (memoised TranscriptRow/Markdown) and the #769 retest, against a scratch
// debug Tauri build driving the FAKE omp (`session-two-turns-answered` tape, no model, no network).
//
// Needs a build that carries the TEMPORARY render-counter hook (`window.__refractRenderCounts`,
// keyed by transcript row id, and `window.__refractMdCounts`, keyed by Markdown id); the hook is
// never committed. Set REFRACT_777_EXE to an already-built exe to skip the rebuild.
//
// #777 PASS: after turn 1 settles, no row that existed then re-renders while turn 2 streams, and
// the streaming row's own counter climbs. #769: pastes a real PNG while the turn is working and
// records how long the chip takes to appear.

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, sha256OfFile } from './verify-tauri-scratch-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-777';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_777_SHOTS_DIR || path.join(tmpdir(), 'refract-777-shots', new Date().toISOString().replace(/[:.]/g, '-'));
const CHIP_COUNT = `document.querySelectorAll('[role="group"][aria-label="Pending attachments"] img').length`;
const LOG_TEXT = `(document.querySelector('[role="log"]')?.innerText ?? '')`;

function buildOmpShim(dir) {
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'omp.exe');
  const result = spawnSync('rustc', ['--edition', '2021', '-O', path.join(__dirname, 'verify-tauri-omp-shim.rs'), '-o', out], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`${LOG}: buildOmpShim rustc failed:\n${result.stderr}`);
  return out;
}

// Pastes a real noisy PNG (~hundreds of KB) and times how long the chip takes to render.
const PASTE_AND_TIME = `(async () => {
  const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 300;
  const ctx = canvas.getContext('2d'); const img = ctx.createImageData(400, 300);
  for (let i = 0; i < img.data.length; i += 4) { img.data[i] = Math.random() * 255; img.data[i + 1] = Math.random() * 255; img.data[i + 2] = Math.random() * 255; img.data[i + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const dt = new DataTransfer(); dt.items.add(new File([blob], 'pasted.png', { type: 'image/png' }));
  const before = ${CHIP_COUNT};
  const t0 = performance.now();
  document.querySelector('[aria-label="Message"]').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  return await new Promise((resolve) => {
    const tick = () => {
      const now = ${CHIP_COUNT};
      const elapsed = performance.now() - t0;
      if (now > before) resolve({ appeared: true, ms: Math.round(elapsed), bytes: blob.size, logText: ${LOG_TEXT} });
      else if (elapsed > 8000) resolve({ appeared: false, ms: Math.round(elapsed), bytes: blob.size, logText: ${LOG_TEXT} });
      else requestAnimationFrame(tick);
    };
    tick();
  });
})()`;

async function main() {
  const head = gitHead(REPO_ROOT);
  console.log(`${LOG}: git HEAD ${head}`);
  mkdirSync(SHOTS_DIR, { recursive: true });
  const report = [];
  const shots = [];
  const check = (cond, label, detail) => {
    report.push({ step: label, ok: !!cond, detail });
    if (!cond) throw new Error(`FAIL: ${label} ${JSON.stringify(detail)}`);
    console.log(`${LOG}: PASS ${label} ${detail === undefined ? '' : JSON.stringify(detail)}`);
  };

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-777-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-777-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-777-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-777');
  const worktreesRoot = path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-777-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-777-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-777-shim-'));
  let child;
  let cdp;
  const shot = async (name) => {
    const file = path.join(SHOTS_DIR, name);
    await cdp.screenshot(file);
    shots.push({ name, path: file, sha256: sha256OfFile(file) });
  };
  const counts = () => cdp.evaluate(`({ rows: { ...(window.__refractRenderCounts || {}) }, md: { ...(window.__refractMdCounts || {}) } })`);
  const settled = (label) =>
    cdp.waitFor(`!!document.querySelector('[aria-label^="Send"]') && !document.querySelector('[aria-label^="Stop"]')`, { timeoutMs: 30_000, label });

  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    let exe;
    if (process.env.REFRACT_777_EXE) {
      exe = { dest: path.join(exeDir, 'refract-tauri.exe') };
      copyFileSync(process.env.REFRACT_777_EXE, exe.dest);
      exe.hash = sha256OfFile(exe.dest);
    } else {
      exe = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    }
    console.log(`${LOG}: exe sha256 ${exe.hash}`);
    report.push({ step: 'exe', ok: true, sha256: exe.hash, head });

    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exe.dest, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'session-two-turns-answered'
      }
    });
    child = launched.child;
    cdp = await CdpSession.connect(await waitForCdpTarget(port, { timeoutMs: 60_000 }));
    if (!isTargetOwningPort(port, launched.targetPid)) throw new Error(`${LOG}: CDP target is not owned by the launched pid`);

    await cdp.waitFor(`(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`, { timeoutMs: 90_000, label: 'Readiness green' });
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`, { timeoutMs: 30_000, label: 'Repository added' });
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(`(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`, { timeoutMs: 15_000, label: 'Create session enabled' });
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'Dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 60_000, label: 'Composer enabled' });

    // Turn 1: tool call -> pending approval -> streamed reply.
    await cdp.typeIntoByLabel('Message', 'first question');
    await cdp.pressEnter();
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`, { timeoutMs: 30_000, label: 'Approval card (turn 1 working)' });
        check(await cdp.evaluate(`typeof window.__refractRenderCounts === 'object'`), 'render-counter hook is present in this build (else the exe is the wrong build)');
    // #769 case A: paste while the turn is working and blocked on the approval (no streaming).
    const pasteA = await cdp.evaluate(PASTE_AND_TIME);
    check(pasteA.appeared, '#769 A: chip appears while the turn is working (pending approval)', { ms: pasteA.ms, bytes: pasteA.bytes });
    await shot('01-paste-during-pending-approval.png');
    await cdp.evaluate(`document.querySelector('button[aria-label="Remove image"]').click()`);
    await cdp.waitFor(`${CHIP_COUNT} === 0`, { timeoutMs: 10_000, label: 'chip removed' });

    await cdp.clickByText('Approve');
    await cdp.waitFor(`/\\bxy\\b/.test(${LOG_TEXT}) && !${LOG_TEXT}.includes('xyzzy9')`, { timeoutMs: 30_000, label: 'turn 1 mid-stream ("xy" shown, final text not yet)' });
    // #769 case B: paste while assistant text is actively streaming.
    const pasteB = await cdp.evaluate(PASTE_AND_TIME);
    check(pasteB.appeared, '#769 B: chip appears while assistant text is streaming', { ms: pasteB.ms, bytes: pasteB.bytes });
    check(!pasteB.logText.includes('xyzzy9'), '#769 B: the reply was still streaming when the chip appeared (not retested after the turn)', { logTail: pasteB.logText.slice(-80) });
    await shot('02-paste-during-streaming.png');
    await cdp.waitFor(`${LOG_TEXT}.includes('xyzzy9')`, { timeoutMs: 30_000, label: 'turn 1 final text' });
    await settled('turn 1 settled');
    await cdp.evaluate(`document.querySelector('button[aria-label="Remove image"]').click()`);
    await cdp.waitFor(`${CHIP_COUNT} === 0`, { timeoutMs: 10_000, label: 'chip 2 removed' });
    await sleep(1500);

    // #777: counters over turn 2.
    const before = await counts();
    const olderRowIds = Object.keys(before.rows);
    check(olderRowIds.length >= 3, '#777: several older rows exist and were counted before turn 2', { rows: olderRowIds.length, counts: before.rows });
    await shot('03-before-turn-2.png');
    await cdp.typeIntoByLabel('Message', 'second question');
    await cdp.pressEnter();
    await cdp.waitFor(`${LOG_TEXT}.includes('turn-two-streamed-ok')`, { timeoutMs: 30_000, label: 'turn 2 final text' });
    await settled('turn 2 settled');
    const after = await counts();
    await shot('04-after-turn-2.png');

    const rerendered = olderRowIds.filter((id) => (after.rows[id] ?? 0) !== before.rows[id]);
    check(rerendered.length === 0, '#777: no older row re-rendered while turn 2 streamed', { rerendered, before: before.rows, after: after.rows });
    const mdRerendered = Object.keys(before.md).filter((id) => (after.md[id] ?? 0) !== before.md[id]);
    check(mdRerendered.length === 0, '#777: no older Markdown re-rendered while turn 2 streamed', { mdRerendered, before: before.md, after: after.md });
    const newRows = Object.keys(after.rows).filter((id) => !(id in before.rows));
    const streamingRow = newRows.find((id) => after.rows[id] >= 2);
    check(!!streamingRow, '#777: the streaming row counter climbed (>= 2 renders) so the counter really measures', { newRows: Object.fromEntries(newRows.map((id) => [id, after.rows[id]])) });
    const newMd = Object.keys(after.md).filter((id) => !(id in before.md));
    check(newMd.some((id) => after.md[id] >= 2), '#777: the streaming Markdown re-rendered as its text changed', { newMd: Object.fromEntries(newMd.map((id) => [id, after.md[id]])) });
    report.push({ step: 'summary', ok: true, olderRowIds: olderRowIds.length, pasteA, pasteB: { ...pasteB, logText: undefined } });
  } catch (err) {
    report.push({ step: 'run crashed', ok: false, error: String(err && err.stack ? err.stack : err) });
    throw err;
  } finally {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ head, results: report, shots }, null, 2));
    } catch (writeErr) {
      console.error(`${LOG}: failed to write report.json: ${writeErr}`);
    }
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir, LOG);
    await safeRmSync(importSourceDir, LOG);
    await safeRmSync(repoDirBase, LOG);
    await safeRmSync(worktreesRoot, LOG);
    await safeRmSync(exeDir, LOG);
    await safeRmSync(launcherDir, LOG);
    await safeRmSync(shimDir, LOG);
  }
  console.log(`${LOG}: done; evidence in ${SHOTS_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
