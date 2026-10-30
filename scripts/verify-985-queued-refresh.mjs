#!/usr/bin/env node
// Live CDP check for #985: a `queued` Session's `startProgress` must survive an unrelated
// `sessions.list()` refresh. `queued` is used because it is set once and never re-emitted, so a
// wipe is permanent rather than a ~1s flicker and no tight timing window is needed.
// Fails without the #988 `summary_fields()` fix; exits 2 (NOT-PROVEN) if D/E never reach their stage.
// The omp shim rustc call is duplicated inline like other verify-*.mjs scripts.

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveCssVarColor, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import {
  setupLaunch, teardownLaunch, quickCreateSessionId,
  waitForStartProgressKind, readVisibleStartKind, assertFocusedPlainStageNotice, parseWaitTimeoutAbsence
} from './verify-672-start-message-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-985';
const SHOTS_DIR =
  process.env.REFRACT_985_SHOTS_DIR || path.join(tmpdir(), 'refract-985-queued-refresh-shots', new Date().toISOString().replace(/[:.]/g, '-'));

// Must outlast the worst-case cumulative wait (~60s) so a slot is not freed mid-check, yet stay
// under the Rust READY_CEILING_MS (180_000) so the start-failure ceiling never fires.
const READY_DELAY_MS = 120_000;

async function main() {
  let launch = null;
  const findings = [];
  const failures = [];
  const notExercised = [];
  let exeHash = null;
  let gitHeadSha = null;
  let dirty = 'unknown';
  let buildOutputDir = null;
  let exeDir = null;
  let launcherDir = null;
  let shimDir = null;
  try {
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;
    buildOutputDir = requireSharedCargoTarget(REPO_ROOT);

    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-985-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-985-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });

    console.log(`${LOG}: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`${LOG}: shots dir ${SHOTS_DIR}`);

    // The omp.exe shim must be first on PATH, else the real omp becomes ready in 1-2s and C1/D
    // never hold a start-queue slot.
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-985-shim-'));
    const shimSrc = path.join(__dirname, 'verify-tauri-omp-shim.rs');
    const shimOut = path.join(shimDir, 'omp.exe');
    const shimResult = spawnSync('rustc', ['--edition', '2021', '-O', shimSrc, '-o', shimOut], { encoding: 'utf8', windowsHide: true });
    if (shimResult.status !== 0) throw new Error(`buildOmpShim: rustc failed (exit ${shimResult.status}):\n${shimResult.stderr}`);

    const built = buildAndCopyExeFresh(exeDir, buildOutputDir, REPO_ROOT, { label: LOG });
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    // The debug log stays in setupLaunch's fresh mkdtemp dir: pointing it at a reusable SHOTS_DIR
    // would let a stale log satisfy the "shim confirmed" guard.
    launch = await setupLaunch(exePath, launcherExe, 'queued-refresh', {
      REFRACT_FAKE_OMP_READY_DELAY_MS: String(READY_DELAY_MS),
      REFRACT_FORCE_LOW_MEMORY: '1'
    }, shimDir);
    const cdp = launch.cdp;
    const muted = await resolveCssVarColor(cdp, '--muted-foreground', 'color');

    // C1 takes slot 1 and spawns; D takes slot 2 but defers (low memory); E queues behind both.
    const sessionC1 = await quickCreateSessionId(cdp, 'C1 (1st of 2 real slots)');
    await waitForStartProgressKind(cdp, sessionC1.id, 'waiting', 10_000);
    findings.push(`Session C1 (id ${sessionC1.id}) created, real 'waiting', holding 1 of 2 real start-queue slots.`);

    const sessionD = await quickCreateSessionId(cdp, 'D (2nd of 2 real slots, defers)');
    let dReached = false;
    try {
      await waitForStartProgressKind(cdp, sessionD.id, 'memory-deferred', 20_000);
      findings.push(`Session D (id ${sessionD.id}) created, real 'memory-deferred', holding the 2nd real slot.`);
      dReached = true;
    } catch (err) {
      const { isKnownAbsence } = parseWaitTimeoutAbsence(err);
      if (isKnownAbsence) notExercised.push(`memory-deferred startProgress.kind did not become observable live this run: ${err.message} -- Session E's own 'queued' check below cannot be exercised without Session D holding the 2nd real slot.`);
      else throw err;
    }

    if (dReached) {
      const sessionE = await quickCreateSessionId(cdp, 'E (3rd concurrent start, queues)');
      try {
        const queuedProgress = await waitForStartProgressKind(cdp, sessionE.id, 'queued', 15_000);
        findings.push(`Session E (id ${sessionE.id}) real startProgress ${JSON.stringify(queuedProgress)} -- both real slots (C1, D) held (start_queue.rs:36, MAX_CONCURRENT_STARTS=2).`);
        await assertFocusedPlainStageNotice(cdp, {
          sessionId: sessionE.id, kind: 'queued', expectedText: 'Waiting to start…',
          muted, failures, findings, screenshotPath: path.join(SHOTS_DIR, '01-queued-before-refresh.png')
        });

        // Trigger an unrelated refresh (repository rename) while E is queued, using the public
        // onSessionListChanged API to know when the refresh actually landed.
        await cdp.evaluate(`(() => {
          window.__verify985ListChanged = false;
          window.refract.onSessionListChanged(() => { window.__verify985ListChanged = true; });
          return true;
        })()`);
        const repoListBefore = await cdp.evaluate('window.refract.repositories.list().then((r) => r.ok ? r.value : null)');
        if (!Array.isArray(repoListBefore) || repoListBefore.length !== 1) {
          throw new Error(`${LOG}: expected exactly 1 repository in this scratch launch, found ${JSON.stringify(repoListBefore)}.`);
        }
        const repoId = repoListBefore[0].id;
        const renameResult = await cdp.evaluate(`window.refract.repositories.rename(${JSON.stringify(repoId)}, 'renamed-to-trigger-refresh')`);
        if (!renameResult?.ok) throw new Error(`${LOG}: repositories.rename did not return ok (${JSON.stringify(renameResult)}) -- cannot trigger the refresh this check depends on.`);
        findings.push(`Repository ${repoId} renamed (real repositories.rename, unrelated to Session E) -- triggers a real notify_list_changed()/sessions.list() refresh (repositories.rs:364).`);

        const eventDeadline = Date.now() + 5_000;
        let eventSeen = false;
        while (Date.now() < eventDeadline) {
          eventSeen = await cdp.evaluate('window.__verify985ListChanged === true');
          if (eventSeen) break;
          await sleep(100);
        }
        if (!eventSeen) {
          failures.push(`repositories.rename resolved ok, but the renderer's own real session:list-changed listener (window.refract.onSessionListChanged) never fired within 5s -- the refresh this check depends on never landed at all.`);
        } else {
          findings.push('Renderer received the real session:list-changed event (window.refract.onSessionListChanged fired) -- the refresh this check depends on genuinely landed.');
        }

        // Fail on the FIRST non-'queued' sample: one lucky read could precede the re-render of a wipe.
        const sampleDeadline = Date.now() + 5_000;
        let sampleCount = 0;
        let failingRead = null;
        while (Date.now() < sampleDeadline) {
          const read = await readVisibleStartKind(cdp);
          sampleCount += 1;
          if (read?.kind !== 'queued') { failingRead = read; break; }
          await sleep(100);
        }
        await cdp.screenshot(path.join(SHOTS_DIR, '02-queued-after-refresh.png'));

        // Fetch the raw IPC row so a DOM failure is not blamed on summary_fields() without checking.
        const listAfter = await cdp.evaluate('window.refract.sessions.list().then((r) => r.ok ? r.value : null)');
        const rowE = Array.isArray(listAfter) ? listAfter.find((s) => s.id === sessionE.id) : null;
        const rowEProgressText = rowE ? JSON.stringify(rowE.startProgress) : '(no row at all)';

        if (failingRead) {
          failures.push(`#985 regression reproduced: Session E's own 'queued' notice did not stay 'queued' across every DOM sample after the unrelated repository-rename refresh -- read ${JSON.stringify(failingRead)} after ${sampleCount} sample(s) (expected {"kind":"queued"} on every one). sessions.list()'s own row for Session E right now has startProgress ${rowEProgressText} (session/agent/mod.rs summary_fields()).`);
        } else {
          findings.push(`Session E's 'queued' notice stayed exactly {"kind":"queued"} across all ${sampleCount} DOM samples over the post-refresh window -- sessions.list() summary row now carries startProgress (session/agent/mod.rs summary_fields fix, issue #985/#988).`);
        }

        if (!rowE) {
          failures.push(`sessions.list() after the refresh has no row at all for Session E (id ${sessionE.id}).`);
        } else if (rowE.startProgress?.kind !== 'queued') {
          failures.push(`sessions.list()'s own summary row for Session E is missing startProgress (got ${rowEProgressText}) -- summary_fields() did not include it.`);
        } else {
          findings.push(`sessions.list()'s own summary row for Session E carries startProgress ${rowEProgressText} directly from the IPC response (summary_fields() fix confirmed at the wire level, not just via the DOM).`);
        }

        const cancelE = await cdp.evaluate(`window.refract.sessions.cancelStart(${JSON.stringify(sessionE.id)})`);
        if (!cancelE?.ok) failures.push(`cleanup: cancelStart(E) did not return ok (${JSON.stringify(cancelE)}).`);
      } catch (err) {
        const { isKnownAbsence, lastRead } = parseWaitTimeoutAbsence(err);
        if (isKnownAbsence) {
          notExercised.push(`queued startProgress.kind did not become observable live this run: ${err.message} -- last read had no kind at all, despite both real slots (C1, D) confirmed held moments earlier.`);
        } else {
          failures.push(`queued: unexpected failure, not the known absence pattern (last read parsed as ${JSON.stringify(lastRead)}): ${err.message}`);
        }
      }

      const cancelD = await cdp.evaluate(`window.refract.sessions.cancelStart(${JSON.stringify(sessionD.id)})`);
      if (!cancelD?.ok) failures.push(`cleanup: cancelStart(D) did not return ok (${JSON.stringify(cancelD)}).`);
    }

    // Exit 2 (NOT-PROVEN) when a needed stage never became observable, so it never looks like a pass.
    const status = failures.length > 0 ? 'FAILED' : notExercised.length > 0 ? 'NOT-PROVEN' : 'DONE';
    const exitCode = failures.length > 0 ? 1 : notExercised.length > 0 ? 2 : 0;
    const report = { gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, status, exitCode };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`\n=== ${LOG}: FAILURES (always fail the run) ===`);
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log(`\n=== ${LOG}: FINDINGS ===`);
    for (const f of findings) console.log(`- ${f}`);
    console.log(`\n=== ${LOG}: NOT EXERCISED (genuine skips only) ===`);
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`${LOG}: ${status}.`);
    process.exitCode = exitCode;
  } catch (err) {
    try {
      mkdirSync(SHOTS_DIR, { recursive: true });
      writeFileSync(
        path.join(SHOTS_DIR, 'report.json'),
        JSON.stringify({ gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2)
      );
    } catch {
      // best-effort only
    }
    console.error(`${LOG}: FAILED:`, err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    // Archive the fake-omp log before teardownLaunch deletes launchDir.
    if (launch?.launchDir) {
      try {
        copyFileSync(path.join(launch.launchDir, 'fake-omp-invocations.log'), path.join(SHOTS_DIR, 'fake-omp-invocations.log'));
      } catch {
        // best-effort only
      }
    }
    await teardownLaunch(launch);
    await safeRmSync(exeDir, LOG);
    await safeRmSync(launcherDir, LOG);
    await safeRmSync(shimDir, LOG);
  }
}

main().catch((err) => {
  console.error(`${LOG}: unhandled error:`, err?.stack ?? err);
  process.exitCode = 1;
});
