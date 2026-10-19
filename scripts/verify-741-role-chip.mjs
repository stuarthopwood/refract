#!/usr/bin/env node
// Live CDP check for issue #741 (composer role chip, pin persistence, OMP-fallback signal,
// Session details card provider line). Decided (Stuart, 2026-10-19, `issuecomment-6266024041`).
//
// Fake-omp tape (`scripts/fixtures/omp-frames/role-chip-741.jsonl`, same preamble shape
// `session.jsonl`/`verify-555-user-message-time.mjs` already use): launches 1, 3 and 4 below are
// all BRAND-NEW Sessions (`launch.rs`'s `attachAndVerify` skips `switch_session` for those) and
// share this one tape; launch 2 reopens the EXISTING Session launch 1 created, so it drives a
// separate companion tape (`role-chip-741-reopen.jsonl`) that scripts the real `switch_session`
// request a genuine reattach sends first (same split `user-message-time`/`user-message-time-
// reopen.jsonl` already use for issue #555). What differs per launch is the literal content Node
// pre-writes into the Session's own Conversation file BEFORE launch (`$conversationFile`
// sentinel), since #741 decision 2/FINDINGS item 51 establishes `currentRole` has no RPC source
// at all: Rust's own `session::model::read_role_from_session_file` reads that file directly off
// disk. A role chip (Default, no chip for an unknown role, Fallback) is therefore proven by what
// this script seeds on disk BEFORE the app ever opens the Session, never by a tape frame.
//
// Five launches, one build (gate round 1 added launch 5, the empty-conversation case):
//   1. "default" conversation file -> Default chip, 60-char-plus model name truncation (real
//      geometry, not a guessed selector), details card name/provider line, AX names, muted-text
//      contrast >= 4.5:1 in all five theme presets (screenshots), a real keyboard path (Tab,
//      focus-visible, tooltip, Escape, Shift+Tab), then a real `set_model` IPC call (the backend
//      contract itself, matching `verify-rm-live-check.mjs`'s own established precedent for
//      RPC-level proof -- NOT a UI click, since #741's hand-pick is a Rust/registry concern the
//      DOM cannot exercise any more directly) pins the Session -> Custom chip. Gate round 1 fix
//      (MEDIUM #4): with the Session still pinned, a fallback `model_change` line is appended to
//      the SAME conversation file and the tape autonomously emits a real `retry_fallback_
//      succeeded` frame -- the chip must flip to Fallback with NO restart, proving `model.rs`'s
//      own "fallback outranks a pin" fix, and the registry's own `pinned` flag must stay true
//      underneath (never cleared by a fallback).
//   2. SAME `dataDir` as launch 1 (a fresh process, same `registry.json`): proves the pin survives
//      a restart (`ensure_pin_seeded` folding `pinnedModel` back in) -- Custom chip reappears with
//      NO hand-pick repeated this run.
//   3. "fallback" conversation file (`resolvedModelIsFallback:true` on its one `model_change`
//      line) -> Fallback chip, tape-proven per FINDINGS item 61 (a live-forced fallback could not
//      be produced in 90s against a real OMP; forcing/confirming that transition live is #650).
//   4. "unknown-role" conversation file (a role string outside every known chat role) -> no chip
//      at all (#741: "if the role cannot be established, show nothing rather than a guess"),
//      asserted only after `sessions.list()` itself reports the seeded `currentRole` (gate round
//      1 fix HIGH #3b: a fixed sleep used to stand in for that real wait).
//   5. Gate round 1 fix (HIGH #3b): an EMPTY conversation file (no `model_change` line at all)
//      -> `currentRole` reads `null` and no chip renders -- the other half of "show nothing
//      rather than a guess" launch 4 alone never exercised.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  safeRmSync,
  requireSharedCargoTarget,
  clearKnownOutputFiles,
  getAccessibleNameAndRole,
  axText
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv } from './verify-941-stage-naming-helpers.mjs';
import {
  openScratchSession,
  readRoleChip,
  runLaunch1Checks,
  ROLE_CHIP_FINDER,
  ROLE_CHIP_LABEL_EXPR,
  THEMES,
  DEFAULT_MODEL_CHANGE_LINE,
  FALLBACK_MODEL_CHANGE_LINE,
  UNKNOWN_ROLE_MODEL_CHANGE_LINE
} from './verify-741-role-chip-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TAPE_NAME = 'role-chip-741';
// Launch 2 reopens an EXISTING Session (`currentConversation` already set from launch 1), so
// `launch.rs`'s `attachAndVerify` sends a real `switch_session` request first -- a brand-new
// Session never does (see `TAPE_NAME`'s own README row). A separate tape scripts that frame.
const TAPE_NAME_REOPEN = 'role-chip-741-reopen';

async function main() {
  const findings = [];
  const failures = [];
  const notExercised = [];
  let SHOTS_DIR = path.join(tmpdir(), `refract-741-role-chip-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  let BUILD_OUTPUT_DIR = null;
  let gitHeadSha = null;
  let dirty = 'unknown';
  let exeHash = null;
  let shimDir, launcherDir, exeDir;
  let dataDir1, importSourceDir1, repoDir1, convDir1, conversationFile1;
  let dataDir3, importSourceDir3, repoDir3, convDir3, conversationFile3;
  let dataDir4, importSourceDir4, repoDir4, convDir4, conversationFile4;
  let dataDir5, importSourceDir5, repoDir5, convDir5, conversationFile5;
  let child1, child2, child3, child4, child5;
  let cdp1, cdp2, cdp3, cdp4, cdp5;

  try {
    SHOTS_DIR = process.env.REFRACT_741_SHOTS_DIR || SHOTS_DIR;
    mkdirSync(SHOTS_DIR, { recursive: true });
    clearKnownOutputFiles(SHOTS_DIR, 'refract-741-role-chip-shots', [
      'report.json',
      'app1.log',
      'app2.log',
      'app3.log',
      'app4.log',
      'app5.log',
      'fake-omp-1.log',
      'fake-omp-2.log',
      'fake-omp-3.log',
      'fake-omp-4.log',
      'fake-omp-5.log',
      ...THEMES.map((t) => `01-chip-default-${t.id}.png`),
      '02-chip-custom.png',
      '03-chip-custom-after-restart.png',
      '04-chip-fallback.png',
      '05-no-chip-unknown-role.png',
      '06-details-card.png',
      '06-composer-row.png',
      '07-chip-fallback-while-pinned.png',
      '08-narrow-380.png',
      '09-narrow-520.png',
      '10-no-chip-empty-conversation.png'
    ]);
    BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;
    console.log(`verify-741: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);

    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-741-shim-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-741-launcher-'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-741-exe-'));
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-741' });
    const exePath = built.dest;
    exeHash = built.hash;
    console.log(`verify-741: exe copied to ${exePath} (sha256 ${exeHash.slice(0, 12)}...)`);

    // ---------------------------------------------------------------------
    // Launch 1: Default role chip, 60-char truncation, details card, AX names, 5 theme
    // screenshots, then a real `model.setModel` pin -> Custom.
    // ---------------------------------------------------------------------
    dataDir1 = mkdtempSync(path.join(tmpdir(), 'refract-741-data1-'));
    importSourceDir1 = mkdtempSync(path.join(tmpdir(), 'refract-741-import1-'));
    repoDir1 = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-741-repo1-')), 'verify-741-1');
    convDir1 = mkdtempSync(path.join(tmpdir(), 'refract-741-conv1-'));
    conversationFile1 = path.join(convDir1, 'conversation.jsonl');
    writeFileSync(conversationFile1, DEFAULT_MODEL_CHANGE_LINE + '\n');

    const port1 = await getFreePort();
    const launched1 = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port: port1,
      dataDir: dataDir1,
      importSourceDir: importSourceDir1,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app1.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: TAPE_NAME,
        REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile1,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(SHOTS_DIR, 'fake-omp-1.log')
      }
    });
    child1 = launched1.child;
    const wsUrl1 = await waitForCdpTarget(port1, { timeoutMs: 60_000 });
    cdp1 = await CdpSession.connect(wsUrl1);
    if (!isTargetOwningPort(port1, launched1.targetPid)) throw new Error(`verify-741: CDP target on port ${port1} is not owned by this run's own process`);

    const sessionId1 = await openScratchSession(cdp1, repoDir1);
    findings.push('Launch 1: scratch Session created and opened (fake omp, role-chip-741 tape, "default" seeded conversation file).');

    await runLaunch1Checks(cdp1, sessionId1, conversationFile1, dataDir1, findings, failures, notExercised, SHOTS_DIR);

    cdp1.close();
    cdp1 = undefined;
    await stopLauncher(child1);
    child1 = undefined;

    // ---------------------------------------------------------------------
    // Launch 2: SAME dataDir1 -- proves the pin (registry.json's pinnedModel field) survives a
    // full app restart with no hand-pick repeated this run.
    // ---------------------------------------------------------------------
    const port2 = await getFreePort();
    const launched2 = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port: port2,
      dataDir: dataDir1,
      importSourceDir: importSourceDir1,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app2.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: TAPE_NAME_REOPEN,
        REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile1,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(SHOTS_DIR, 'fake-omp-2.log')
      }
    });
    child2 = launched2.child;
    const wsUrl2 = await waitForCdpTarget(port2, { timeoutMs: 60_000 });
    cdp2 = await CdpSession.connect(wsUrl2);
    if (!isTargetOwningPort(port2, launched2.targetPid)) throw new Error(`verify-741: CDP target on port ${port2} is not owned by this run's own process`);

    await cdp2.waitFor(`!!document.querySelector('[data-session-open]')`, { timeoutMs: 60_000, label: 'Relaunch: existing session row rendered (story DOM marker)' });
    await cdp2.click(`document.querySelector('[data-session-open]')`);
    await cdp2.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Relaunch: Session reattached, composer enabled'
    });
    await cdp2.waitFor(`${ROLE_CHIP_LABEL_EXPR} === 'Custom'`, { timeoutMs: 15_000, label: 'Role chip reads Custom after a restart with the same REFRACT_DATA_DIR, no hand-pick repeated' }).catch((err) => {
      failures.push(`Role chip did not read Custom after restart: ${err.message}`);
    });
    const restartList = await cdp2.evaluate(`window.refract.sessions.list()`);
    // Gate round 1 fix (LOW #13a): looked up by `sessionId1` (the real id launch 1 created),
    // never an assumed `[0]` -- a brand-new, incidental Session (readiness probes, import, etc.)
    // could otherwise silently shift the index this reads.
    const restartSummary = restartList.ok ? restartList.value.find((s) => s.id === sessionId1) : undefined;
    if (restartSummary?.pinned === true) {
      findings.push('Pin persisted across a full app restart with the same REFRACT_DATA_DIR (registry.json\'s pinnedModel field round-tripped) -- Custom chip shown with zero hand-pick repeated this run.');
    } else {
      failures.push(`sessions.list() after restart: pinned=${restartSummary?.pinned}, expected true.`);
    }
    await cdp2.screenshot(path.join(SHOTS_DIR, '03-chip-custom-after-restart.png'));

    cdp2.close();
    cdp2 = undefined;
    await stopLauncher(child2);
    child2 = undefined;

    // ---------------------------------------------------------------------
    // Launch 3: a fresh Session whose conversation file's one model_change entry already carries
    // resolvedModelIsFallback:true -> Fallback chip (tape-proven per FINDINGS item 61; forcing
    // this transition live against a real OMP is #650).
    // ---------------------------------------------------------------------
    dataDir3 = mkdtempSync(path.join(tmpdir(), 'refract-741-data3-'));
    importSourceDir3 = mkdtempSync(path.join(tmpdir(), 'refract-741-import3-'));
    repoDir3 = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-741-repo3-')), 'verify-741-3');
    convDir3 = mkdtempSync(path.join(tmpdir(), 'refract-741-conv3-'));
    conversationFile3 = path.join(convDir3, 'conversation.jsonl');
    writeFileSync(conversationFile3, FALLBACK_MODEL_CHANGE_LINE + '\n');

    const port3 = await getFreePort();
    const launched3 = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port: port3,
      dataDir: dataDir3,
      importSourceDir: importSourceDir3,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app3.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: TAPE_NAME,
        REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile3,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(SHOTS_DIR, 'fake-omp-3.log')
      }
    });
    child3 = launched3.child;
    const wsUrl3 = await waitForCdpTarget(port3, { timeoutMs: 60_000 });
    cdp3 = await CdpSession.connect(wsUrl3);
    if (!isTargetOwningPort(port3, launched3.targetPid)) throw new Error(`verify-741: CDP target on port ${port3} is not owned by this run's own process`);

    await openScratchSession(cdp3, repoDir3);
    await cdp3.waitFor(`!!(${ROLE_CHIP_FINDER})`, { timeoutMs: 30_000, label: 'Role chip rendered (fallback scenario)' });
    const fallbackChipText = await readRoleChip(cdp3);
    const fallbackAx = await getAccessibleNameAndRole(cdp3, `(${ROLE_CHIP_FINDER})`);
    if (fallbackChipText === 'Fallback') {
      findings.push('Role chip reads "Fallback" for a Session whose latest model_change entry carries resolvedModelIsFallback:true, overriding its own role:"default" field.');
    } else {
      failures.push(`Fallback-scenario chip text was ${JSON.stringify(fallbackChipText)}, expected "Fallback".`);
    }
    if (fallbackAx.name === 'Fallback, role') {
      findings.push('Fallback chip accessible name is "Fallback, role" (visible text first, sr-only ", role" suffix confirmed via the AX tree).');
    } else {
      failures.push(`Fallback chip accessible name was ${JSON.stringify(fallbackAx.name)}, expected "Fallback, role".`);
    }
    const fallbackTooltipText = await axText(cdp3, `(${ROLE_CHIP_FINDER})`).catch(() => null);
    const tooltipShown = await cdp3.evaluate(`
      (async () => {
        const chip = ${ROLE_CHIP_FINDER};
        chip.focus();
        await new Promise((r) => setTimeout(r, 300));
        return document.body.textContent.includes('OMP switched models after repeated failures');
      })()
    `).catch(() => false);
    if (tooltipShown) {
      findings.push('Fallback chip\'s tooltip reads the issue\'s own wording ("OMP switched models after repeated failures...") on keyboard focus.');
    } else {
      failures.push('Fallback chip\'s tooltip did not show the expected wording on keyboard focus.');
    }
    await cdp3.screenshot(path.join(SHOTS_DIR, '04-chip-fallback.png'));

    cdp3.close();
    cdp3 = undefined;
    await stopLauncher(child3);
    child3 = undefined;

    // ---------------------------------------------------------------------
    // Launch 4: a fresh Session whose conversation file's role string matches no known chat role
    // -> no chip at all (#741: "show nothing rather than a guess").
    // ---------------------------------------------------------------------
    dataDir4 = mkdtempSync(path.join(tmpdir(), 'refract-741-data4-'));
    importSourceDir4 = mkdtempSync(path.join(tmpdir(), 'refract-741-import4-'));
    repoDir4 = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-741-repo4-')), 'verify-741-4');
    convDir4 = mkdtempSync(path.join(tmpdir(), 'refract-741-conv4-'));
    conversationFile4 = path.join(convDir4, 'conversation.jsonl');
    writeFileSync(conversationFile4, UNKNOWN_ROLE_MODEL_CHANGE_LINE + '\n');

    const port4 = await getFreePort();
    const launched4 = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port: port4,
      dataDir: dataDir4,
      importSourceDir: importSourceDir4,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app4.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: TAPE_NAME,
        REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile4,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(SHOTS_DIR, 'fake-omp-4.log')
      }
    });
    child4 = launched4.child;
    const wsUrl4 = await waitForCdpTarget(port4, { timeoutMs: 60_000 });
    cdp4 = await CdpSession.connect(wsUrl4);
    if (!isTargetOwningPort(port4, launched4.targetPid)) throw new Error(`verify-741: CDP target on port ${port4} is not owned by this run's own process`);

    await openScratchSession(cdp4, repoDir4);
    // Gate round 1 fix (HIGH #3b): a real wait for `sessions.list()` to report the SEEDED
    // unrecognised `currentRole` (proving the Rust side actually read it off disk), not a fixed
    // sleep standing in for that real signal before asserting absence.
    await cdp4.waitFor(
      `window.refract.sessions.list().then((r) => r.ok && r.value[0]?.currentRole === 'a-role-no-chat-role-map-recognises')`,
      { timeoutMs: 15_000, label: 'sessions.list() reports the seeded unrecognised currentRole' }
    );
    const noChipFound = await cdp4.evaluate(`!(${ROLE_CHIP_FINDER})`);
    if (noChipFound) {
      findings.push('No role chip renders at all for a Session whose latest model_change entry carries an unrecognised role string -- never a guess.');
    } else {
      failures.push('A role chip rendered even though the Session\'s role string is not a recognised chat role.');
    }
    await cdp4.screenshot(path.join(SHOTS_DIR, '05-no-chip-unknown-role.png'));

    cdp4.close();
    cdp4 = undefined;
    await stopLauncher(child4);
    child4 = undefined;

    // ---------------------------------------------------------------------
    // Launch 5 (gate round 1 fix HIGH #3b): an EMPTY conversation file (no `model_change` line
    // at all) -> `currentRole` reads `null` and no chip renders -- unlike launch 4 (a role
    // STRING that fails to resolve against any known chat role), this proves the "no
    // `model_change` entry found at all" branch too (the other half of "show nothing rather
    // than a guess").
    // ---------------------------------------------------------------------
    dataDir5 = mkdtempSync(path.join(tmpdir(), 'refract-741-data5-'));
    importSourceDir5 = mkdtempSync(path.join(tmpdir(), 'refract-741-import5-'));
    repoDir5 = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-741-repo5-')), 'verify-741-5');
    convDir5 = mkdtempSync(path.join(tmpdir(), 'refract-741-conv5-'));
    conversationFile5 = path.join(convDir5, 'conversation.jsonl');
    writeFileSync(conversationFile5, '');

    const port5 = await getFreePort();
    const launched5 = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port: port5,
      dataDir: dataDir5,
      importSourceDir: importSourceDir5,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app5.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: TAPE_NAME,
        REFRACT_FAKE_OMP_CONVERSATION_FILE: conversationFile5,
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(SHOTS_DIR, 'fake-omp-5.log')
      }
    });
    child5 = launched5.child;
    const wsUrl5 = await waitForCdpTarget(port5, { timeoutMs: 60_000 });
    cdp5 = await CdpSession.connect(wsUrl5);
    if (!isTargetOwningPort(port5, launched5.targetPid)) throw new Error(`verify-741: CDP target on port ${port5} is not owned by this run's own process`);

    await openScratchSession(cdp5, repoDir5);
    await cdp5.waitFor(
      `window.refract.sessions.list().then((r) => r.ok && r.value[0]?.currentRole == null)`,
      { timeoutMs: 15_000, label: 'sessions.list() reports currentRole: null for an empty conversation file' }
    );
    const noChipFoundEmpty = await cdp5.evaluate(`!(${ROLE_CHIP_FINDER})`);
    if (noChipFoundEmpty) {
      findings.push('No role chip renders for a Session whose conversation file has no model_change entry at all -- currentRole reads null, never a guess.');
    } else {
      failures.push('A role chip rendered even though the Session\'s conversation file has no model_change entry at all.');
    }
    await cdp5.screenshot(path.join(SHOTS_DIR, '10-no-chip-empty-conversation.png'));

    cdp5.close();
    cdp5 = undefined;
    await stopLauncher(child5);
    child5 = undefined;

    const report = { gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, exitCode: failures.length > 0 ? 1 : 0 };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-741: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-741: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-741: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-741: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(
        path.join(SHOTS_DIR, 'report.json'),
        JSON.stringify({ gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2)
      );
    } catch {
      // best-effort only
    }
    console.error('verify-741: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp1) cdp1.close();
    if (cdp2) cdp2.close();
    if (cdp3) cdp3.close();
    if (cdp4) cdp4.close();
    if (cdp5) cdp5.close();
    if (child1) await stopLauncher(child1).catch(() => {});
    if (child2) await stopLauncher(child2).catch(() => {});
    if (child3) await stopLauncher(child3).catch(() => {});
    if (child4) await stopLauncher(child4).catch(() => {});
    if (child5) await stopLauncher(child5).catch(() => {});
    try {
      for (const [name, dir] of [
        ['app1.log', exeDir],
        ['app2.log', exeDir],
        ['app3.log', exeDir],
        ['app4.log', exeDir],
        ['app5.log', exeDir]
      ]) {
        const src = path.join(dir ?? '', name);
        if (dir && existsSync(src)) copyFileSync(src, path.join(SHOTS_DIR, name));
      }
    } catch (err) {
      console.warn('verify-741: could not preserve logs:', err.message);
    }
    for (const dir of [
      shimDir,
      launcherDir,
      exeDir,
      dataDir1,
      importSourceDir1,
      repoDir1,
      convDir1,
      dataDir3,
      importSourceDir3,
      repoDir3,
      convDir3,
      dataDir4,
      importSourceDir4,
      repoDir4,
      convDir4,
      dataDir5,
      importSourceDir5,
      repoDir5,
      convDir5
    ]) {
      await safeRmSync(dir);
    }
  }
}

main().catch((err) => {
  console.error('verify-741: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
