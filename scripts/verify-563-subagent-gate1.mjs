#!/usr/bin/env node
// Real-omp live gate check for issue #563 (requested by Main after the quality-gate remediation
// round): the fake-omp tape (`verify-563-subagent-stage.mjs`, one Stage, two subagents, no
// failure/cancel path) cannot exercise the multi-Stage chain, a visible Running/Cancelled status
// word, or the Show-thinking-toggle independence fix. This script drives a REAL `omp` (resolved
// from PATH, no fake, no shim -- `omp --version` reports 18.10.1) against the ambient, already
// signed-in default profile (no `OMP_PROFILE` override): the established pattern this repo's own
// `docs/spike/chat-lines-probe.mjs`/`get-subagents-probe.mjs`/`context-usage-probe.mjs` already
// use for "a real model is needed" checks -- cwd is a brand-new scratch git repo (never Stuart's
// real worktrees), and `REFRACT_DATA_DIR`/`WEBVIEW2_USER_DATA_FOLDER`/`REFRACT_IMPORT_SOURCE_DIR`
// are all scratch too, so this never reads or writes Stuart's real Session list. The Session this
// creates is a brand-new entry under the ambient profile's own `agent/sessions/`, keyed by this
// scratch cwd -- it can never collide with, or be read back by, any of Stuart's real sessions.
//
// Spends real model tokens (small, tiny-echo subagent prompts only, per the standing "keep
// prompts tiny" instruction). Three scenarios, one Session:
//   (a) one turn: two parallel task() calls (Stage 1, 2 agents), then a third serial task() call
//       (Stage 2) -> the Subagent chain row renders; open the panel from a chain entry, confirm
//       pre-selection + focus landed on it, confirm closing returns focus to that entry.
//   (b) a second turn: one task() call, Stopped mid-run -> Cancelled status word captured in the
//       StageGroupRow's `meta` slot (not the icon slot), not overlapping the agent name; a
//       Running-state screenshot captured first, before Stop is clicked.
//   (c) the same (a) turn, re-rendered with "Show thinking" toggled off via the IPC bridge
//       directly (`window.refract.settings.setTranscriptDisplay`, no Settings-screen navigation
//       needed) -> Stage count and numbering must read identically either way (the H1/H4 fix).
//
// Reuses the already-built debug exe (ci-local's own `tauri build --debug --no-bundle` this
// session), copied to a PRIVATE scratch dir first (the cross-lane shared-`CARGO_TARGET_DIR`
// overwrite lesson from this story's own earlier live check). Every scratch path is a fresh
// `mkdtempSync` result, removed in `finally` by that same literal variable -- never built from a
// variable interpolated into a shell string, never a bare drive letter, never touching anything
// inside this repo or Stuart's real `%APPDATA%/refract-tauri`/`~/.omp` data.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, createWriteStream, copyFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, launchViaJobObject, isTargetOwningPort, sleep } from './verify-tauri-cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
const SHOTS_DIR = 'C:/Users/shopwood/AppData/Local/Temp/refract-563-gate1-shots/';

const TURN_A_PROMPT =
  "Make your very first tool call be exactly ONE call to the task tool that starts TWO subagents together in that SAME call (not two separate calls -- one call, two subagents in it): the first subagent's entire job is to reply with exactly the single word 'uno' and nothing else; the second subagent's entire job is to reply with exactly the single word 'dos' and nothing else. Wait for both of those to finish. Then, once both have finished, call the task tool a second time, by itself, with one tiny subagent whose entire job is to reply with exactly the single word 'tres' and nothing else. Once all three subagents have replied, reply with exactly the single word 'gate563complete' yourself and nothing else.";
const TURN_B_PROMPT =
  // Gate round 2 fix: a bare one-word reply finished before Stop could land in testing here
  // (the subagent settled to Finished on its own, never giving Stop anything to interrupt), so
  // the subagent's own task now pads out a slow, pointless count first -- giving Stop a real
  // window to land mid-run -- before it replies with the sentinel word.
  "Call the task tool once with one tiny subagent whose entire job is to count out loud from 1 to 200, one number per line, then on its own final line reply with exactly the single word 'quattro' and nothing else. Do not reply with anything else yourself.";
const TURN_A_SENTINEL = 'gate563complete';

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

async function pressKey(cdp, key, windowsVirtualKeyCode) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode });
}

function buildLauncher(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-launcher.rs');
  const out = path.join(dir, 'verify-tauri-launcher.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', src, '-o', out]);
  if (result.status !== 0) throw new Error(`buildLauncher: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

function makeScratchRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const run = (args) => {
    const result = spawnSync_('git', ['-C', dir, ...args]);
    if (result.status !== 0) throw new Error(`makeScratchRepo: git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    return result;
  };
  run(['init', '-q', '-b', 'main']);
  run(['-c', 'user.name=verify-563-gate1', '-c', 'user.email=verify-563-gate1@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

function worktreesDirFor(repoDir) {
  return path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
}

function sha256OfFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** Rebuilds the debug exe fresh, then copies it to `destDir` IMMEDIATELY -- the standing rule
 * from this story's own earlier live check (the shared `CARGO_TARGET_DIR`'s own `debug/
 * refract-tauri.exe` can be overwritten mid-session by a concurrent lane's own build). Confirms
 * the source file's own mtime/hash are UNCHANGED from the instant the build finished to the
 * instant the copy completed; if a concurrent write landed in that window (detected by the
 * source's mtime/size/hash differing from what was read right after the build), the whole
 * build-and-copy is retried from scratch, up to `maxAttempts` times, rather than trusting a
 * copy that might have raced a concurrent writer mid-file. */
function buildAndCopyExeFresh(destDir, { maxAttempts = 3 } = {}) {
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'refract-tauri.exe');
  const src = path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`verify-563-gate1: rebuilding the debug exe fresh (attempt ${attempt}/${maxAttempts}, this takes a few minutes)...`);
    const buildResult = spawnSync_('pnpm', ['tauri', 'build', '--debug', '--no-bundle'], { cwd: REPO_ROOT, stdio: 'inherit', shell: true });
    if (buildResult.status !== 0) throw new Error(`buildAndCopyExeFresh: pnpm tauri build failed (exit ${buildResult.status}${buildResult.error ? `, error: ${buildResult.error.message}` : ''})`);
    if (!existsSync(src)) throw new Error(`buildAndCopyExeFresh: built exe not found at ${src} after a successful build`);
    const preCopyStat = statSync(src);
    const preCopyHash = sha256OfFile(src);
    copyFileSync(src, dest);
    const postCopyStat = statSync(src);
    const postCopyHash = existsSync(src) ? sha256OfFile(src) : null;
    const unchanged = postCopyHash === preCopyHash && postCopyStat.mtimeMs === preCopyStat.mtimeMs && postCopyStat.size === preCopyStat.size;
    if (unchanged) {
      console.log(`verify-563-gate1: built exe copied to ${dest} (private, never the shared CARGO_TARGET_DIR copy; sha256 ${preCopyHash.slice(0, 12)}…, confirmed unchanged through the copy)`);
      return { dest, hash: preCopyHash };
    }
    console.warn(`verify-563-gate1: source exe changed between build and copy (attempt ${attempt}) -- a concurrent lane is rebuilding the shared target dir; rebuilding and copying again.`);
  }
  throw new Error(`buildAndCopyExeFresh: source exe kept changing across ${maxAttempts} rebuild attempts -- a concurrent lane is rebuilding continuously; try again once it is done.`);
}

async function launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile }) {
  const webview2DataDir = path.join(path.dirname(exePath), 'webview2-data');
  mkdirSync(webview2DataDir, { recursive: true });
  const pidFile = path.join(path.dirname(exePath), 'target.pid');
  // No PATH override, no OMP_PROFILE: resolves the REAL ambient omp (already on PATH, 18.10.1)
  // against the REAL, already-signed-in default profile -- the established "real model needed"
  // isolation posture this repo's own docs/spike probes already use (scratch cwd/session dir,
  // never a credential copy, never touching ~/.omp/agent/sessions in a way Stuart would ever see
  // or reopen, since this Session's cwd is a path that has never existed until this run).
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
  };
  const { child, targetPid } = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: path.dirname(exePath), env });
  if (logFile) {
    const stream = createWriteStream(logFile);
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
  }
  return { child, targetPid };
}

async function safeRmSync(dir) {
  if (!dir) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 2) {
        console.warn(`verify-563-gate1: could not remove scratch dir ${dir} (left on disk): ${err.message}`);
        return;
      }
      await sleep(1000);
    }
  }
}

/** Gate round 2 fix ([CRITICAL] N-new, G899Tests): re-hashes the private-scratch exe copy and
 * throws loudly if it has drifted from the hash recorded right after the build-and-copy step --
 * a concurrent lane's own rebuild overwriting the SHARED CARGO_TARGET_DIR mid-run cannot reach
 * this private copy, but this still catches the equivalent failure mode (anything else touching
 * `exePath` after launch) before a critical assertion below is allowed to trust stale output. */
function assertExeUnchanged(exePath, expectedHash, label) {
  const actualHash = sha256OfFile(exePath);
  if (actualHash !== expectedHash) {
    throw new Error(
      `assertExeUnchanged (${label}): ${exePath} hash is ${actualHash.slice(0, 12)}…, expected ${expectedHash.slice(0, 12)}… -- the exe under test changed after launch; this run's findings cannot be trusted.`,
    );
  }
}

async function transcriptText(cdp) {
  return cdp.evaluate(`document.querySelector('[aria-label="Transcript"]')?.textContent ?? ''`);
}

/** Background poller: clicks every visible "Approve" button (RequestCard.tsx's own approval
 * card, exact button text, no aria-label of its own) as it appears, so the default "Ask"
 * Approval mode never blocks this script's task() calls on a manual click. Runs until `stop()`
 * is awaited; never throws on a transient evaluate failure (a mid-close/mid-render DOM read),
 * since a single missed poll just gets caught on the next 400ms tick. */
function startAutoApprove(cdp) {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        const hasApprove = await cdp.evaluate(
          `!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`,
        );
        if (hasApprove) await cdp.clickByText('Approve');
      } catch {
        // transient; retried next tick
      }
      await sleep(400);
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

async function main() {
  let dataDir, importSourceDir, repoDir, exeDir, launcherDir;
  let child;
  let cdp;
  let autoApprove;
  const findings = [];
  const notExercised = [];
  try {
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-563g1-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-563g1-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-563g1-repo-')));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-563g1-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-563g1-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    const port = await getFreePort();

    console.log(`verify-563-gate1: data dir ${dataDir}`);
    console.log(`verify-563-gate1: repo dir ${repoDir}`);
    console.log(`verify-563-gate1: shots dir ${SHOTS_DIR}`);
    console.log(`verify-563-gate1: CDP port ${port}`);

    const { dest: exePath, hash: exeHash } = buildAndCopyExeFresh(exeDir);
    const launcherExe = buildLauncher(launcherDir);

    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      logFile: path.join(exeDir, 'app.log'),
    });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-563-gate1: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green (real omp --version + get_state round trip)' },
    );
    await cdp.screenshot(path.join(SHOTS_DIR, '01-readiness-green.png'));
    findings.push('Readiness green against the REAL ambient omp install (18.10.1), scratch data dir.');

    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Scratch repository added' },
    );
    findings.push('Scratch repository added (brand-new, never-seen-before path).');

    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open, Create session enabled' },
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    // Real omp spawn + handshake can take noticeably longer than the fake shim.
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 90_000,
      label: 'Session opened, real agent attached, composer enabled',
    });
    findings.push('Session created; REAL omp process attached (ambient signed-in profile, scratch cwd/worktree).');

    // Default Approval mode is "Ask" (FR-015), which gates the `task` tool behind its own
    // Allow-tool card per subagent batch (observed live: two separate "Allow tool: task" cards,
    // one per parallel subagent, before Stage 1 ever renders). Switching Approval mode to Auto
    // via the IPC bridge did NOT take effect in time for the very next message in testing here
    // (FR-020's "restart behind the scenes" is asynchronous and this script raced ahead of it),
    // so instead a background poller clicks every pending "Approve" button as it appears,
    // throughout both scenario (a) and (b) below -- started now, stopped in the `finally` block.
    autoApprove = startAutoApprove(cdp);

    // ---- Scenario (a): 2 parallel task() calls then 1 serial -> chain row, pre-select, focus ----
    await cdp.typeIntoByLabel('Message', TURN_A_PROMPT);
    await cdp.clickByLabel('Send message');

    try {
      // The composer stays enabled during a running turn (queuing is supported), so it is NOT a
      // turn-completion signal -- wait for the literal final reply ("done", the exact word this
      // prompt asked for) to actually appear in the transcript instead.
      await cdp.waitFor(
        // The sentinel appears once already, inside the user's own prompt bubble (quoted
        // instructional text) -- a SECOND occurrence means the assistant actually said it back,
        // not merely that the prompt asking for it rendered.
        `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && (t.textContent.match(/${TURN_A_SENTINEL}/g) ?? []).length >= 2; })()`,
        { timeoutMs: 180_000, label: 'Turn (a) finished (assistant echoed the sentinel back)' },
      );
    } catch (err) {
      await cdp.screenshot(path.join(SHOTS_DIR, '99-diag-turn-a-stage1-failure.png'));
      const htmlOnFailure = await cdp.evaluate(`document.querySelector('[aria-label="Transcript"]')?.outerHTML ?? ''`).catch(() => '');
      writeFileSync(path.join(SHOTS_DIR, 'turn-a-transcript-onfailure.html'), htmlOnFailure);
      throw err;
    }
    // Always dump the raw transcript HTML for this turn (not only on failure): the exact class
    // names/structure are the fastest way to tell a genuine Stage-group render from a bare
    // SubagentRow render apart, which plain `.textContent` cannot disambiguate reliably.
    const transcriptHtml = await cdp.evaluate(`document.querySelector('[aria-label="Transcript"]')?.outerHTML ?? ''`);
    writeFileSync(path.join(SHOTS_DIR, 'turn-a-transcript.html'), transcriptHtml);
    const hasStageHeader = await cdp.evaluate(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.includes('Stage 1'); })()`,
    );
    if (!hasStageHeader) {
      await cdp.screenshot(path.join(SHOTS_DIR, '99-diag-turn-a-stage1-failure.png'));
      notExercised.push('No "Stage 1" header text found after turn (a) settled; see turn-a-transcript.html for the raw DOM dump. Continuing to check what did render.');
    }
    // Capture a Running-state screenshot while Stage 1's agents are still in flight, if we are
    // not already past it (real model timing is not controllable the way the fake tape is).
    const stillRunningA = await cdp.evaluate(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.includes('Running'); })()`,
    );
    if (stillRunningA) {
      await cdp.screenshot(path.join(SHOTS_DIR, '02-turn-a-stage1-running.png'));
      findings.push('Stage 1 captured mid-run ("Running" visible in the transcript) before it settled.');
    } else {
      findings.push('Stage 1 had already settled by the time this script could poll for a Running state (real-model timing); the Running status word is instead captured from turn (b) below.');
    }

    // Wait for the full turn to finish: Stage 2 (the serial third task()) plus the chain row,
    // which only renders for 2+ Stages (FR-065). Poll the chain's own distinguishing summary
    // text ("N stages, M agents") rather than guessing a fixed wait.
    try {
      await cdp.waitFor(
        `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && /\\d+\\s+stages,\\s+\\d+\\s+agents/.test(t.textContent); })()`,
        { timeoutMs: 120_000, label: 'Subagent chain row rendered (2+ Stages this turn)' },
      );
      assertExeUnchanged(exePath, exeHash, 'chain row rendered');
      await cdp.screenshot(path.join(SHOTS_DIR, '03-turn-a-chain-row.png'));
      const chainSummary = await cdp.evaluate(
        `(document.querySelector('[aria-label="Transcript"]')?.textContent.match(/\\d+\\s+stages,\\s+\\d+\\s+agents[^.]*/) ?? [''])[0]`,
      );
      if (!chainSummary) throw new Error('chainSummary matched empty: the chain row text did not actually contain "N stages, M agents" despite the waitFor above passing.');
      // Gate round 2 fix ([CRITICAL] N-new): a #563 DOM marker, not just substring text that an
      // OLDER build (lacking this story's own code) could never produce by coincidence -- the
      // `role="group"`-labelled Stage line this round's own `ChainStageLine` introduces. Proves
      // the running build genuinely contains this PR's code, not a stale pre-#563 binary.
      const hasStageGroupMarker = await cdp.evaluate(
        `!!document.querySelector('[role="group"][aria-label^="Stage "]')`,
      );
      if (!hasStageGroupMarker) throw new Error('No [role="group"][aria-label^="Stage "] element found in the chain body -- the running build may not actually contain this PR\u2019s ChainStageLine markup.');
      findings.push(`Subagent chain row rendered: "${chainSummary}" -- confirms the real model followed the 2-parallel-then-1-serial instruction into two Stages within one turn; the chain's own [role="group"] Stage marker is present, confirming this build.`);

      // Decision 6: the chain row defaults OPEN while any agent in the turn is running, failed,
      // cancelled, or exited -- by the time this script polls for it, Stage 1 (uno/dos) has
      // likely already settled but Stage 2 (tres) may still be running, so the chain can already
      // be mounted EXPANDED. The `[role="group"][aria-label^="Stage "]` check just above only
      // ever finds a match while expanded (Radix unmounts `CollapsibleContent` while collapsed),
      // so reaching this point already proves the chain is open -- clicking its trigger
      // unconditionally would COLLAPSE it instead, leaving `entryFinder` below searching
      // unmounted content (the real cause of this check's prior failures, not a timing race).
      // Read `aria-expanded` first; click only when it is genuinely "false".
      const chainTriggerFinder = `(() => { const t = document.querySelector('[aria-label="Transcript"]'); if (!t) return null; return Array.from(t.querySelectorAll('button,[role="button"]')).find((el) => el.textContent.includes('Subagents')); })()`;
      const chainExpandedAlready = await cdp.evaluate(`${chainTriggerFinder}?.getAttribute('aria-expanded')`);
      if (chainExpandedAlready !== 'true') {
        await cdp.click(chainTriggerFinder);
      }
      findings.push(`Chain trigger aria-expanded before this step: ${JSON.stringify(chainExpandedAlready)} -- ${chainExpandedAlready === 'true' ? 'already open, left untouched' : 'was closed, clicked to open'}.`);
      await cdp.waitFor(
        `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.toLowerCase().includes('uno') && t.textContent.toLowerCase().includes('tres'); })()`,
        { timeoutMs: 15_000, label: 'Chain expanded, entries visible' },
      );
      await cdp.screenshot(path.join(SHOTS_DIR, '04-turn-a-chain-expanded.png'));
      findings.push('Chain row expands to show its per-Stage entries (uno/dos in Stage 1, tres in Stage 2).');

      // Click the "tres" chain entry (a real <button>, since the tracker still knows it) and
      // confirm the panel opens pre-selected on it with focus landed there. Gate round 2 fix:
      // scoped to a `[role="group"][aria-label^="Stage "]` wrapper -- the chain's own
      // `ChainStageLine` markup -- not just "any button containing 'tres'", which also matches
      // Stage 2's OWN in-place disclosure trigger now that gate round 2 addendum B renders a
      // solo Stage with the agent's bare name as its label ("Tres"), identical text to the
      // chain's compact entry; the two are only distinguishable by DOM position/ancestry.
      const entryFinder = `(() => { const groups = document.querySelectorAll('[role="group"][aria-label^="Stage "]'); for (const g of groups) { const btn = Array.from(g.querySelectorAll('button')).find((el) => el.textContent.toLowerCase().includes('tres')); if (btn) return btn; } return null; })()`;
      const entryExists = await cdp.evaluate(`!!${entryFinder}`);
      if (!entryExists) {
        notExercised.push('The "tres" chain entry rendered as plain (untracked) text, not a clickable button -- the live SubagentSummary readout never correlated to it in time (toolCallId/specIndex match), so the pre-select/focus/close-return path below could not be driven through it.');
      } else {
        await cdp.click(entryFinder);
        await cdp.waitFor(`!!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 15_000, label: 'Subagent panel opened from the chain entry' });
        await cdp.waitFor(
          `(() => { const sel = document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"][aria-selected="true"]'); return !!sel && sel.textContent.toLowerCase().includes('tres'); })()`,
          { timeoutMs: 10_000, label: 'Panel pre-selected on the "tres" agent' },
        );
        const focusOnSelected = await cdp.evaluate(
          `(() => { const sel = document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"][aria-selected="true"]'); return document.activeElement === sel; })()`,
        );
        await cdp.screenshot(path.join(SHOTS_DIR, '05-turn-a-panel-preselected.png'));
        findings.push(`Activating the "tres" chain entry opened the panel pre-selected on it (decision 13); focus landed on the selected tree row: ${focusOnSelected}.`);

        // Gate round 3 (M7, code-reviewer/accessibility-auditor High on PR #899): the pre-select
        // focus above landed via a plain `.focus()` call, which Chromium does not always treat
        // as keyboard-originated for `:focus-visible` purposes. A real ArrowDown (`Input.
        // dispatchKeyEvent`, not a script `.focus()`) is unambiguously keyboard input, so the row
        // it moves focus to is a genuine `:focus-visible` test case -- the exact case the fix
        // (`outline-hidden` + `focus-visible:outline-solid`, SubagentPanel.tsx) targets. No new
        // model turn needed: reuses the tree already open from the pre-select above.
        await pressKey(cdp, 'ArrowDown', 40);
        await cdp.waitFor(
          `(() => { const sel = document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"][aria-selected="true"]'); return !!sel && !sel.textContent.toLowerCase().includes('tres'); })()`,
          { timeoutMs: 10_000, label: 'ArrowDown moved the roving tab stop off "tres"' },
        );
        const m7Outline = await cdp.evaluate(
          `(() => { const el = document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"][aria-selected="true"]'); if (!el) return null; const cs = getComputedStyle(el); return { isActiveElement: el === document.activeElement, outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, text: el.textContent }; })()`,
        );
        await cdp.screenshot(path.join(SHOTS_DIR, '05b-turn-a-panel-keyboard-focus-ring.png'));
        if (!m7Outline || !m7Outline.isActiveElement) {
          notExercised.push(`M7 live check could not confirm the ArrowDown-focused tree row is document.activeElement: ${JSON.stringify(m7Outline)}`);
        } else if (m7Outline.outlineStyle === 'none' || m7Outline.outlineWidth === '0px') {
          notExercised.push(`M7 REGRESSION: the keyboard-focused tree row paints no outline live (outline-style=${m7Outline.outlineStyle}, outline-width=${m7Outline.outlineWidth}).`);
        } else {
          findings.push(`M7 live confirmation: a REAL keyboard ArrowDown (Input.dispatchKeyEvent, not a script focus() call) moved the roving tab stop to "${m7Outline.text}", whose own computed style is outline-style=${m7Outline.outlineStyle}, outline-width=${m7Outline.outlineWidth}, outline-color=${m7Outline.outlineColor} -- a real, painting :focus-visible ring on the real build, not just a compiled utility that looks right in isolation.`);
        }

        await cdp.click(`document.querySelector('[data-panel-close]')`);
        await cdp.waitFor(`!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 10_000, label: 'Panel closed' });
        await sleep(300);
        const focusReturnedToEntry = await cdp.evaluate(`document.activeElement?.textContent?.toLowerCase().includes('tres') ?? false`);
        await cdp.screenshot(path.join(SHOTS_DIR, '06-turn-a-panel-closed-focus-return.png'));
        findings.push(`Closing the panel returned focus to the chain entry that opened it (the recorded opener): ${focusReturnedToEntry}.`);
      }
    } catch (err) {
      await cdp.screenshot(path.join(SHOTS_DIR, '99-diag-turn-a-chain-failure.png'));
      notExercised.push(`Chain row / pre-select / focus-return path did not complete: ${err.message}`);
    }

    // ---- Scenario (c): toggle "Show thinking" off, confirm Stage count/numbering unchanged ----
    try {
      assertExeUnchanged(exePath, exeHash, 'before thinking-toggle check');
      const stagesBefore = await cdp.evaluate(`(document.querySelector('[aria-label="Transcript"]')?.textContent.match(/Stage \\d+/g) ?? []).join(',')`);
      // Gate round 2 fix ([CRITICAL] N-new, G899Tests): the prior version compared `stagesBefore
      // === stagesAfter` unconditionally, so two EMPTY strings (no "Stage N" text ever found,
      // meaning this check was run against a build with no Stage rendering at all, or ran before
      // the chain-row wait above actually settled) silently passed as "identical: true". Assert
      // non-empty first, so a vacuous pass is impossible.
      if (!stagesBefore) throw new Error('stagesBefore matched empty: no "Stage N" text found before toggling -- this check cannot prove anything about numbering stability.');
      await cdp.evaluate(`window.refract.settings.setTranscriptDisplay('thinking', false)`);
      await sleep(500);
      assertExeUnchanged(exePath, exeHash, 'after thinking-toggle');
      const stagesAfter = await cdp.evaluate(`(document.querySelector('[aria-label="Transcript"]')?.textContent.match(/Stage \\d+/g) ?? []).join(',')`);
      if (!stagesAfter) throw new Error('stagesAfter matched empty: "Stage N" text disappeared entirely once thinking was hidden -- either a real regression, or the transcript re-rendered onto a different build; either way this is not "identical".');
      await cdp.screenshot(path.join(SHOTS_DIR, '07-thinking-off-stages-unchanged.png'));
      const chainSummaryAfter = await cdp.evaluate(
        `(document.querySelector('[aria-label="Transcript"]')?.textContent.match(/\\d+\\s+stages,\\s+\\d+\\s+agents[^.]*/) ?? [''])[0]`,
      );
      if (!chainSummaryAfter) throw new Error('chainSummaryAfter matched empty: the chain summary text disappeared once thinking was hidden.');
      const identical = stagesBefore === stagesAfter;
      if (!identical) throw new Error(`Stage labels changed when "Show thinking" toggled off: before="${stagesBefore}" after="${stagesAfter}" -- H2/H4 regression.`);
      findings.push(`Show-thinking toggle (H2/H4 fix): Stage labels before="${stagesBefore}" after="${stagesAfter}" (both non-empty, genuinely identical); chain summary after toggle: "${chainSummaryAfter}".`);
      // Toggle back on, so the rest of this run (and any later screenshot) reflects the default.
      await cdp.evaluate(`window.refract.settings.setTranscriptDisplay('thinking', true)`);
    } catch (err) {
      await cdp.screenshot(path.join(SHOTS_DIR, '99-diag-thinking-toggle-failure.png'));
      notExercised.push(`Show-thinking toggle check failed or regressed: ${err.message}`);
    }

    // ---- Scenario (b): a second turn, Stopped mid-run -> Cancelled status word, no overlap ----
    try {
      await cdp.typeIntoByLabel('Message', TURN_B_PROMPT);
      await cdp.clickByLabel('Send message');
      await cdp.waitFor(
        // Exact-text match on a span (the subagent row's own label), not a substring-anywhere
        // check -- the user's own prompt bubble already contains the word "quattro" in prose,
        // so a substring check resolves instantly, before the model has even called task().
        `(() => { const t = document.querySelector('[aria-label="Transcript"]'); if (!t) return false; return Array.from(t.querySelectorAll('span')).some((el) => el.textContent.trim().toLowerCase() === 'quattro'); })()`,
        { timeoutMs: 60_000, label: 'Turn (b) subagent "quattro" row rendered (its own label span, case-insensitive -- the model may title-case the subagent name)' },
      );
      await cdp.screenshot(path.join(SHOTS_DIR, '08-turn-b-running.png'));
      // Measured overlap check: the status word (meta slot) and the label (agent name/Stage N)
      // must not share horizontal space -- read both elements' own getBoundingClientRect. Gate
      // round 2 fix: starts from the exact label span (same query as the waitFor above), then
      // walks up to its own `CollapsedLine` row container (`rounded-md`, that component's own
      // class) -- the prior "any element whose combined textContent includes both substrings"
      // search could match an unrelated ancestor wrapping the whole transcript (anything with
      // "quattro" and "Running" ANYWHERE inside it, observed live matching an unrelated
      // "Info:" notice row instead).
      const runningLayout = await cdp.evaluate(
        `(() => { const t = document.querySelector('[aria-label="Transcript"]'); if (!t) return null; const label = Array.from(t.querySelectorAll('span')).find((el) => el.textContent.trim().toLowerCase() === 'quattro'); const row = label ? label.closest('[class*="rounded-md"]') : null; if (!row || !row.textContent.includes('Running')) return null; const r = row.getBoundingClientRect(); return { rowText: row.textContent.trim().slice(0, 120), rowWidth: r.width }; })()`,
      );
      findings.push(`Turn (b) captured Running state live: ${JSON.stringify(runningLayout)}.`);

      await cdp.clickByLabel('Stop');
      await cdp.waitFor(
        `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && (t.textContent.includes('Cancelled') || t.textContent.includes('cancelled')); })()`,
        { timeoutMs: 30_000, label: 'Turn (b) subagent settled to Cancelled after Stop' },
      );
      await cdp.screenshot(path.join(SHOTS_DIR, '09-turn-b-cancelled.png'));
      // Confirm the visible "Cancelled" word sits in the meta slot (not inside the icon's own
      // fixed-width span) and does not visually collide with the label text -- compare the
      // label span's right edge against the word's left edge.
      const cancelledLayout = await cdp.evaluate(
        `(() => { const t = document.querySelector('[aria-label="Transcript"]'); if (!t) return null; const wordEl = Array.from(t.querySelectorAll('span')).find((el) => el.textContent.trim() === 'Cancelled'); if (!wordEl) return { found: false }; const wr = wordEl.getBoundingClientRect(); const row = wordEl.closest('div'); const labelEl = row ? Array.from(row.querySelectorAll('span')).find((el) => el !== wordEl && el.textContent.toLowerCase().includes('quattro')) : null; const lr = labelEl ? labelEl.getBoundingClientRect() : null; return { found: true, wordRect: { x: wr.x, width: wr.width }, labelRect: lr ? { x: lr.x, right: lr.x + lr.width } : null, overlaps: lr ? wr.x < lr.x + lr.width : null }; })()`,
      );
      findings.push(`Cancelled status word layout check: ${JSON.stringify(cancelledLayout)} (overlaps:false expected -- the word sits after the label, never painted on top of it).`);
    } catch (err) {
      await cdp.screenshot(path.join(SHOTS_DIR, '99-diag-turn-b-failure.png'));
      notExercised.push(`Turn (b) (fail/cancel + status-word layout) did not complete: ${err.message}`);
    }

    writeFileSync(path.join(SHOTS_DIR, 'findings.json'), JSON.stringify({ findings, notExercised }, null, 2));
    if (notExercised.length) {
      // Gate round 2 fix ([CRITICAL] N-new): the prior version always printed PASS regardless of
      // this list, so an incomplete run (a target missing, an assertion that degraded itself to
      // "not exercised" instead of failing) was indistinguishable from a genuinely clean one in
      // both this console output and the caller's exit code.
      console.log('verify-563-gate1: INCOMPLETE -- see findings below, then NOT EXERCISED.');
      for (const f of findings) console.log(' -', f);
      console.log('verify-563-gate1: NOT EXERCISED:');
      for (const n of notExercised) console.log(' -', n);
      process.exitCode = 1;
      return;
    }
    console.log('verify-563-gate1: PASS -- see findings below.');
    for (const f of findings) console.log(' -', f);
  } finally {
    if (autoApprove) await autoApprove.stop();
    cdp?.close();
    if (child) await stopLauncher(child);
    try {
      if (exeDir && existsSync(path.join(exeDir, 'app.log'))) copyFileSync(path.join(exeDir, 'app.log'), path.join(SHOTS_DIR, 'app.log'));
    } catch (err) {
      console.warn('verify-563-gate1: could not preserve logs:', err.message);
    }
    await safeRmSync(importSourceDir);
    await safeRmSync(dataDir);
    if (repoDir) await safeRmSync(worktreesDirFor(repoDir));
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
  }
}

main().catch((err) => {
  console.error('verify-563-gate1: FAIL');
  console.error(err);
  process.exitCode = 1;
});
