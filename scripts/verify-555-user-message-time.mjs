#!/usr/bin/env node
// Live CDP check for issue #555 (chat: show the time above the user message, mark turn
// boundaries clearly), required before the draft PR -- same precedent #558/#570/#917/#565 set
// for a scoped visual change: a real send through the recorded-frame fake `omp`
// (scripts/verify-tauri-fake-omp.mjs, `fixtures/omp-frames/user-message-time.jsonl` -- a
// hand-extended copy of the shared `session.jsonl` scenario that omits `msg-u1`'s hardcoded
// `"timestamp":0` so the live-sent message gets a REAL, current `at` instead of every other
// tape's deliberately-zeroed placeholder; see that fixture's own README provenance row),
// driven over real CDP input, never a state poke.
//
// Assertions, in order:
//   1. A `<time dateTime=...>` element renders for the sent user message, inside the Transcript
//      region but NOT inside the bubble's own box (`[data-slot="message-content"]`) -- the
//      zero-box-rule placement decided on issue #555.
//   2. Its `dateTime` attribute parses to a timestamp within the last 2 minutes (proves it is
//      THIS message's own real `at`, not a stale/default value), and its visible text matches an
//      hour:minute clock format (locale-dependent AM/PM suffix, so the regex allows either).
//   3. It sits visually ABOVE the user bubble (`[data-slot="message"][data-align="end"]`):
//      bounding-rect bottom <= the bubble's own top.
//   4. Turn-boundary spacing (decided: no code change needed) still holds: the row immediately
//      after the user message (the tool-call group) carries the `mt-6` turn-gap margin, not the
//      tight `mt-1` bookkeeping margin -- proves the new sibling `<time>` row did not change how
//      `MessageScrollerItem`'s own margin class is computed for neighbouring rows.
// Not exercised (documented, not silently dropped): a SECOND human turn (the "above a NEW turn"
// half of turn-boundary spacing -- the existing `session.jsonl` fixture's tape ends after one
// turn, and extending it was judged out of scope for a pre-existing, unmodified code path); a
// reopened Conversation with a missing/sentinel timestamp (`at === 0`, "hide rather than
// invent") -- no history-replay fixture exercises that path in this harness.

import { mkdtempSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, launchViaJobObject } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
const SHOTS_DIR = process.env.REFRACT_555_SHOTS_DIR || path.join(tmpdir(), 'refract-555-user-message-time-shots', new Date().toISOString().replace(/[:.]/g, '-'));

// Deliberately never appears in the scripted prompt itself, matching `verify-tauri.mjs`'s own
// independence rule for its own reply token.
const PROMPT_MESSAGE = 'Checking issue 555 timestamp rendering now.';
const REPLY_TOKEN = 'xyzzy9'; // the session fixture's own fixed assistant reply token

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

// Local copy of the fake-omp-aware launcher (pathPrepend/extraEnv), matching every other
// verify-5xx script that drives the recorded-frame fake omp: the shared `launchBuiltExe` in
// `verify-tauri-scratch-helpers.mjs` supports only a real-omp launch (no PATH shim/extra env).
async function launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, pathPrepend, extraEnv = {}, logFile }) {
  const webview2DataDir = path.join(path.dirname(exePath), 'webview2-data');
  mkdirSync(webview2DataDir, { recursive: true });
  const pidFile = path.join(path.dirname(exePath), 'target.pid');
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
    ...extraEnv,
  };
  if (pathPrepend) env.PATH = `${pathPrepend};${process.env.PATH}`;
  const { child, targetPid } = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: path.dirname(exePath), env });
  if (logFile) {
    const stream = createWriteStream(logFile);
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
  }
  return { child, targetPid };
}

function worktreesDirFor(repoDir) {
  return path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
}

async function main() {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const findings = [];
  const failures = [];
  const notExercised = [
    'A second human turn (space ABOVE a new user turn): the session.jsonl fixture tape ends after one turn.',
    'A reopened Conversation with a missing/sentinel timestamp (at === 0, "hide rather than invent").',
  ];
  let shimDir, dataDir, importSourceDir, repoDir, exeDir;
  let child;
  let cdp;
  let exeHash = null;
  let gitHeadSha = null;
  try {
    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-555-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-555-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-555-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-555-repo-')), 'verify-555');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-555-exe-'));
    gitHeadSha = gitHead(REPO_ROOT);
    const port = await getFreePort();

    console.log(`verify-555: git HEAD ${gitHeadSha}`);
    console.log(`verify-555: data dir ${dataDir}`);
    console.log(`verify-555: repo dir ${repoDir}`);
    console.log(`verify-555: shots dir ${SHOTS_DIR}`);
    console.log(`verify-555: CDP port ${port}`);

    // Native PATH shim for the fake omp (same bare rustc compile every verify-5xx script uses).
    mkdirSync(shimDir, { recursive: true });
    const shimSrc = path.join(__dirname, 'verify-tauri-omp-shim.rs');
    const shimOut = path.join(shimDir, 'omp.exe');
    const shimResult = spawnSync_('rustc', ['--edition', '2021', '-O', shimSrc, '-o', shimOut]);
    if (shimResult.status !== 0) throw new Error(`buildOmpShim: rustc failed (exit ${shimResult.status}):\n${shimResult.stderr}`);

    const launcherExe = buildLauncher(shimDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-555' });
    const exePath = built.dest;
    exeHash = built.hash;
    console.log(`verify-555: exe copied to ${exePath} (sha256 ${exeHash.slice(0, 12)}...)`);

    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(SHOTS_DIR, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'user-message-time',
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(SHOTS_DIR, 'fake-omp-invocations.log'),
      },
    });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-555: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
    }

    // Readiness -> Add repository -> create a Session -> send the message (mirrors
    // `verify-tauri.mjs`'s own proveUs1/proveUs4, trimmed to what #555's assertions need).
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness checklist green' }
    );
    await cdp.screenshot(path.join(SHOTS_DIR, '01-readiness-green.png'));

    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Repository added, session-list row rendered' }
    );

    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open, Create session enabled' }
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });

    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Session opened, composer enabled',
    });
    await cdp.screenshot(path.join(SHOTS_DIR, '02-session-opened.png'));

    const sendStartedAt = Date.now();
    await cdp.typeIntoByLabel('Message', PROMPT_MESSAGE);
    await cdp.clickByLabel('Send message');

    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.includes(${JSON.stringify(PROMPT_MESSAGE)}); })()`,
      { timeoutMs: 30_000, label: 'Sent message rendered in transcript' }
    );
    await cdp.screenshot(path.join(SHOTS_DIR, '03-sent-message.png'));

    // --- Assertion 1-3: the new <time> row, its value, and its placement -------------------
    const timeProbe = await cdp.evaluate(`
      (() => {
        const transcript = document.querySelector('[aria-label="Transcript"]');
        if (!transcript) return { error: 'no Transcript region' };
        const bubble = Array.from(transcript.querySelectorAll('[data-slot="message"][data-align="end"]'))
          .find((el) => el.textContent.includes(${JSON.stringify(PROMPT_MESSAGE)}));
        if (!bubble) return { error: 'no matching user bubble' };
        // UserMessageRow renders the time row and the bubble as DIRECT siblings (a Fragment
        // creates no DOM node of its own), so the time row immediately precedes the bubble.
        const timeRow = bubble.previousElementSibling;
        const timeEl = timeRow ? timeRow.querySelector('time') : null;
        if (!timeEl) return { error: 'no <time> element found as the bubble\\'s previous sibling' };
        const insideBubbleBox = !!timeEl.closest('[data-slot="message-content"]');
        const timeRect = timeEl.getBoundingClientRect();
        const bubbleRect = bubble.getBoundingClientRect();
        return {
          dateTime: timeEl.getAttribute('dateTime'),
          visibleText: timeEl.textContent.trim(),
          insideBubbleBox,
          timeBottom: timeRect.bottom,
          bubbleTop: bubbleRect.top,
          className: timeEl.parentElement ? timeEl.parentElement.className : null,
        };
      })()
    `);
    console.log('verify-555: time probe', JSON.stringify(timeProbe));

    if (timeProbe.error) {
      failures.push(`<time> probe failed: ${timeProbe.error}`);
    } else {
      if (!timeProbe.dateTime) {
        failures.push('the <time> element has no dateTime attribute');
      } else {
        const parsed = new Date(timeProbe.dateTime).getTime();
        const ageMs = Date.now() - parsed;
        if (!Number.isFinite(parsed)) {
          failures.push(`dateTime="${timeProbe.dateTime}" did not parse as a valid date`);
        } else if (ageMs < -5000 || ageMs > 120_000) {
          failures.push(`dateTime="${timeProbe.dateTime}" is not within the last 2 minutes of the real send (age ${ageMs}ms) -- not this message's own timestamp`);
        } else {
          findings.push(`dateTime="${timeProbe.dateTime}" parses to ${ageMs}ms after send start -- confirmed this message's own real timestamp.`);
        }
      }
      if (!/^\d{1,2}:\d{2}(\s?[AP]M)?$/i.test(timeProbe.visibleText || '')) {
        failures.push(`visible timestamp text "${timeProbe.visibleText}" does not match an hour:minute clock format`);
      } else {
        findings.push(`visible timestamp text "${timeProbe.visibleText}" matches an hour:minute clock format (locale toLocaleTimeString).`);
      }
      if (timeProbe.insideBubbleBox) {
        failures.push('the <time> element is INSIDE the bubble\'s own [data-slot="message-content"] box -- violates the zero-box-rule placement decided on #555');
      } else {
        findings.push('the <time> element is NOT inside the bubble\'s own box (renders as a sibling row above it), matching the decision record.');
      }
      if (typeof timeProbe.timeBottom === 'number' && typeof timeProbe.bubbleTop === 'number') {
        if (timeProbe.timeBottom > timeProbe.bubbleTop + 1) {
          failures.push(`the <time> row's own bottom (${timeProbe.timeBottom}) is BELOW the bubble's top (${timeProbe.bubbleTop}) -- not rendered above the bubble`);
        } else {
          findings.push(`the <time> row sits visually above the bubble (time bottom ${timeProbe.timeBottom} <= bubble top ${timeProbe.bubbleTop}).`);
        }
      }
    }

    // --- Assertion 4: turn-boundary mt-6 margin still lands on the row AFTER the user message -
    const marginProbe = await cdp.evaluate(`
      (() => {
        const transcript = document.querySelector('[aria-label="Transcript"]');
        const items = Array.from(transcript.querySelectorAll('[data-slot="message-scroller-item"]'));
        const userIdx = items.findIndex((el) => el.textContent.includes(${JSON.stringify(PROMPT_MESSAGE)}));
        if (userIdx === -1 || userIdx + 1 >= items.length) return { error: 'could not find a row after the user message' };
        const next = items[userIdx + 1];
        return { className: next.className, marginTop: getComputedStyle(next).marginTop };
      })()
    `);
    console.log('verify-555: margin probe', JSON.stringify(marginProbe));
    if (marginProbe.error) {
      failures.push(`turn-boundary margin probe failed: ${marginProbe.error}`);
    } else if (!/\bmt-6\b/.test(marginProbe.className)) {
      failures.push(`the row after the user message does not carry the mt-6 turn-gap class (got: "${marginProbe.className}", computed marginTop ${marginProbe.marginTop})`);
    } else {
      findings.push(`the row after the user message still carries mt-6 (computed marginTop ${marginProbe.marginTop}) -- turn-boundary spacing is unaffected by the new sibling <time> row.`);
    }

    // Let the scripted turn settle (approval -> streamed reply) so the Session ends in a clean
    // state, then take a final full-transcript screenshot as delivery evidence.
    await cdp.waitFor(`!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`, {
      timeoutMs: 30_000,
      label: 'Approval card rendered',
    });
    await cdp.clickByText('Approve');
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.includes(${JSON.stringify(REPLY_TOKEN)}); })()`,
      { timeoutMs: 60_000, label: 'Turn settled (reply token present)' }
    );
    await cdp.screenshot(path.join(SHOTS_DIR, '04-turn-settled.png'));

    const report = { gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, notExercised, exitCode: failures.length > 0 ? 1 : 0 };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-555: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-555: findings ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-555: NOT exercised (documented, not silently dropped) ===');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-555: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    console.error('verify-555: FAIL');
    console.error(err);
    try {
      writeFileSync(
        path.join(SHOTS_DIR, 'report.json'),
        JSON.stringify({ gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2)
      );
    } catch {
      // best-effort only
    }
    process.exitCode = 1;
  } finally {
    cdp?.close();
    if (child) await stopLauncher(child);
    await safeRmSync(shimDir, 'verify-555');
    await safeRmSync(dataDir, 'verify-555');
    await safeRmSync(importSourceDir, 'verify-555');
    if (repoDir) await safeRmSync(worktreesDirFor(repoDir), 'verify-555');
    await safeRmSync(repoDir, 'verify-555');
    await safeRmSync(exeDir, 'verify-555');
  }
}

main();
