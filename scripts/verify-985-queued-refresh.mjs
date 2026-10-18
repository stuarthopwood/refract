#!/usr/bin/env node
// Live CDP check for issue #985 (the real, surviving part -- the harness-bug symptoms were
// traced and fixed separately, PR #978): a `queued` Session's own `startProgress` row is wiped
// by ANY unrelated `sessions.list()` refresh, because `SessionAgent::summary_fields()`
// (`src-tauri/src/session/agent/mod.rs`) never included `startProgress` in a `sessions.list()`
// summary row -- only the live `session:status` event (`status_event_locked`) and
// `SessionSnapshot.runtime` (`runtime_view`) carried it. `init-stores.ts`'s own
// `onSessionListChanged` handler reacts to ANY `notify_list_changed()` call anywhere in the app
// (repository rename, archive/restore/delete/worktree-reset, PR-link, another Session's own
// open/recover) by calling `useSessionsStore.getState().refresh()` (`sessions-store.ts`), which
// does a wholesale `set({ sessions: result.value })` -- replacing EVERY row, including one for a
// Session still genuinely starting, with whatever `sessions.list()` just returned.
//
// `queued` is the one `startProgress.kind` this is provable WITHOUT racing a self-heal: unlike
// `waiting`/`prompt`/`extended` (re-emitted every ~1s by `on_start_progress`'s own ticker,
// `start_queue.rs`) or `memory-deferred` (~2s), `Queued` is set exactly ONCE by `acquire_slot`
// (`set_stage`, `start_queue.rs:369`) and never re-emits on its own timer -- it only changes once
// the queue itself advances. A wipe here is therefore permanent (not a ~1s flicker) until a slot
// frees, so this check needs no tight timing window at all.
//
// Fix proof: triggers a genuinely unrelated `notify_list_changed()` (a real
// `repositories.rename` call on the one scratch repository already in this launch -- confirmed
// trigger, `src-tauri/src/ipc/repositories.rs:364`) while a 3rd Session (E) is held `queued`
// behind two real start-queue slots (same real setup `verify-672-start-message.mjs`'s own
// `queued` exercise uses), then re-reads E's own notice both via the DOM and via a direct
// `sessions.list()` call. FAILS on `main` before #988 (`summary_fields()` never inserts
// `startProgress`, so the rename's refresh wipes E's notice for good, no self-heal). PASSES with
// #988 (E's `startProgress` survives the refresh because the new summary row now carries it).
//
// Reuses the shared Tauri CDP harness (`verify-tauri-cdp.mjs`/`verify-tauri-scratch-helpers.mjs`)
// and `verify-672-start-message-helpers.mjs`'s own exported `setupLaunch`/`teardownLaunch`
// (the omp shim pattern, including its "shim confirmed" guard and its guard that refuses a
// stale/missing fake-omp debug log), `quickCreateSessionId`, `waitForStartProgressKind`,
// `readVisibleStartKind`, `assertFocusedPlainStageNotice`, `parseWaitTimeoutAbsence` -- rather
// than duplicating them. `verify-672-start-message.mjs` itself is already at the #806 600-line
// file-size soft cap, so this is a small, separate script instead of growing it further. The
// `buildOmpShim` rustc call itself is duplicated inline, matching every other `verify-*.mjs`
// script in this repo (it is a ~40-line dependency-free file, never exported, same precedent as
// `verify-556-zero-box.mjs`/`verify-563-subagent-stage.mjs`/etc.).

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

// Must outlast this script's own worst-case cumulative wait (~60s: 10s C1 'waiting' + 20s D
// 'memory-deferred' + 15s E 'queued' + up to 10s for the refresh-event-then-sample window below)
// with real margin, or a slow run can free a slot before the check finishes and fail a correct
// build -- but stays comfortably under the real Rust `READY_CEILING_MS` (180_000,
// `src-tauri/src/omp/process.rs`) so a start-failure ceiling never fires mid-check either.
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

    // Built ONCE: puts a real `omp.exe` shim first on PATH (issue #985 root cause, fixed in
    // `verify-672-start-message.mjs` -- without it, `which::which_global("omp")` resolves the
    // REAL installed omp, ready in 1-2s, and neither C1 nor D stays spawned long enough to hold
    // a real start-queue slot for this check).
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-985-shim-'));
    const shimSrc = path.join(__dirname, 'verify-tauri-omp-shim.rs');
    const shimOut = path.join(shimDir, 'omp.exe');
    const shimResult = spawnSync('rustc', ['--edition', '2021', '-O', shimSrc, '-o', shimOut], { encoding: 'utf8', windowsHide: true });
    if (shimResult.status !== 0) throw new Error(`buildOmpShim: rustc failed (exit ${shimResult.status}):\n${shimResult.stderr}`);

    const built = buildAndCopyExeFresh(exeDir, buildOutputDir, REPO_ROOT, { label: LOG });
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    // No REFRACT_FAKE_OMP_DEBUG_LOG override: `setupLaunch`'s own default writes it inside the
    // freshly `mkdtemp`'d `launchDir` (guaranteed unique every run, never stale) -- pointing it
    // at SHOTS_DIR instead (overridable to the SAME directory across runs via
    // REFRACT_985_SHOTS_DIR) would let a leftover log from an earlier run satisfy `setupLaunch`'s
    // own "shim confirmed" guard without this run's shim ever having written anything. Copied out
    // to SHOTS_DIR for archival in the `finally` block below, before teardown deletes `launchDir`.
    launch = await setupLaunch(exePath, launcherExe, 'queued-refresh', {
      REFRACT_FAKE_OMP_READY_DELAY_MS: String(READY_DELAY_MS),
      REFRACT_FORCE_LOW_MEMORY: '1'
    }, shimDir);
    const cdp = launch.cdp;
    const muted = await resolveCssVarColor(cdp, '--muted-foreground', 'color');

    // ---- Real `queued`: same real setup `verify-672-start-message.mjs`'s own `queued` exercise
    // uses -- C1 grabs the 1st real start-queue slot and spawns (MAX_CONCURRENT_STARTS,
    // start_queue.rs:36); D grabs the 2nd but defers (REFRACT_FORCE_LOW_MEMORY=1,
    // start_queue.rs:387); E then queues behind both real slots. ----
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

        // ---- The #985 regression: trigger a genuinely UNRELATED sessions.list() refresh (a
        // real `repositories.rename` on the one scratch repository in this launch) while E is
        // still held `queued`. Registers our own real `onSessionListChanged` listener first --
        // the SAME public preload API `init-stores.ts` itself subscribes with, never a dev-only
        // seam -- so we can tell the refresh genuinely landed, not guess an arbitrary instant. ----
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

        // Sample the DOM across the WHOLE remaining window and fail on the FIRST read that is
        // not 'queued' -- never trust a single lucky read: a store `set()` that landed but whose
        // React re-render this script's own first poll happened to beat would otherwise look
        // like a pass even on a genuine wipe.
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

        // Independent, zero-timing-dependency ground truth for the message below: the raw IPC
        // row itself either carries the field or it does not, fetched fresh right now rather
        // than assumed, so a DOM failure is never blamed on `summary_fields()` without checking
        // whether Session E's own backend stage is still genuinely `queued` at all.
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

    // Exit codes: 0 clean pass, 1 a real failure (the regression reproduced, or anything else
    // genuinely wrong), 2 NOT-PROVEN (no failure, but something this check needed never became
    // observable live -- D or E never reaching their stage -- so the fix is neither confirmed
    // nor refuted this run, and that must never look identical to a clean pass).
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
    // Archive the fake-omp debug log before `teardownLaunch` deletes `launchDir` -- best-effort:
    // absent if `setupLaunch` itself failed before the shim ever ran.
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
