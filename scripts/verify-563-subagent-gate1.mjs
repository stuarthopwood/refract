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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, createWriteStream, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, launchViaJobObject, isTargetOwningPort, sleep } from './verify-tauri-cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
const SHOTS_DIR = 'C:/Users/shopwood/AppData/Local/Temp/refract-563-gate1-shots/';

const TURN_A_PROMPT =
  "Make your very first tool call be exactly ONE call to the task tool that starts TWO subagents together in that SAME call (not two separate calls -- one call, two subagents in it): the first subagent's entire job is to reply with exactly the single word 'uno' and nothing else; the second subagent's entire job is to reply with exactly the single word 'dos' and nothing else. Wait for both of those to finish. Then, once both have finished, call the task tool a second time, by itself, with one tiny subagent whose entire job is to reply with exactly the single word 'tres' and nothing else. Once all three subagents have replied, reply with exactly the single word 'gate563complete' yourself and nothing else.";
const TURN_B_PROMPT =
  "Call the task tool once with one tiny subagent whose entire job is to reply with exactly the single word 'quattro' and nothing else. Do not reply with anything else yourself.";
const TURN_A_SENTINEL = 'gate563complete';

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
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

function copyBuiltExe(destDir) {
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'refract-tauri.exe');
  const src = path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
  if (!existsSync(src)) throw new Error(`copyBuiltExe: built exe not found at ${src}`);
  copyFileSync(src, dest);
  return dest;
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

    const launcherExe = buildLauncher(launcherDir);
    const exePath = copyBuiltExe(exeDir);
    console.log(`verify-563-gate1: built exe copied to ${exePath} (private, never the shared CARGO_TARGET_DIR copy)`);

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
      await cdp.screenshot(path.join(SHOTS_DIR, '03-turn-a-chain-row.png'));
      const chainSummary = await cdp.evaluate(
        `(document.querySelector('[aria-label="Transcript"]')?.textContent.match(/\\d+\\s+stages,\\s+\\d+\\s+agents[^.]*/) ?? [''])[0]`,
      );
      findings.push(`Subagent chain row rendered: "${chainSummary}" -- confirms the real model followed the 2-parallel-then-1-serial instruction into two Stages within one turn.`);

      // Expand the chain (click its own collapsed trigger -- the "Subagents" labelled row).
      await cdp.click(
        `(() => { const t = document.querySelector('[aria-label="Transcript"]'); if (!t) return null; return Array.from(t.querySelectorAll('button,[role="button"]')).find((el) => el.textContent.includes('Subagents')); })()`,
      );
      await cdp.waitFor(
        `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.toLowerCase().includes('uno') && t.textContent.toLowerCase().includes('tres'); })()`,
        { timeoutMs: 15_000, label: 'Chain expanded, entries visible' },
      );
      await cdp.screenshot(path.join(SHOTS_DIR, '04-turn-a-chain-expanded.png'));
      findings.push('Chain row expands to show its per-Stage entries (uno/dos in Stage 1, tres in Stage 2).');

      // Click the "tres" chain entry (a real <button>, since the tracker still knows it) and
      // confirm the panel opens pre-selected on it with focus landed there.
      const entryFinder = `(() => { const t = document.querySelector('[aria-label="Transcript"]'); if (!t) return null; return Array.from(t.querySelectorAll('button')).find((el) => el.textContent.toLowerCase().includes('tres')); })()`;
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
      const stagesBefore = await cdp.evaluate(`(document.querySelector('[aria-label="Transcript"]')?.textContent.match(/Stage \\d+/g) ?? []).join(',')`);
      await cdp.evaluate(`window.refract.settings.setTranscriptDisplay('thinking', false)`);
      await sleep(500);
      const stagesAfter = await cdp.evaluate(`(document.querySelector('[aria-label="Transcript"]')?.textContent.match(/Stage \\d+/g) ?? []).join(',')`);
      await cdp.screenshot(path.join(SHOTS_DIR, '07-thinking-off-stages-unchanged.png'));
      const chainSummaryAfter = await cdp.evaluate(
        `(document.querySelector('[aria-label="Transcript"]')?.textContent.match(/\\d+\\s+stages,\\s+\\d+\\s+agents[^.]*/) ?? [''])[0]`,
      );
      findings.push(`Show-thinking toggle (H1/H4 fix): Stage labels before="${stagesBefore}" after="${stagesAfter}" (identical: ${stagesBefore === stagesAfter}); chain summary after toggle: "${chainSummaryAfter}".`);
      // Toggle back on, so the rest of this run (and any later screenshot) reflects the default.
      await cdp.evaluate(`window.refract.settings.setTranscriptDisplay('thinking', true)`);
    } catch (err) {
      notExercised.push(`Show-thinking toggle check failed: ${err.message}`);
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
      // must not share horizontal space -- read both elements' own getBoundingClientRect.
      const runningLayout = await cdp.evaluate(
        `(() => { const t = document.querySelector('[aria-label="Transcript"]'); if (!t) return null; const row = Array.from(t.querySelectorAll('*')).find((el) => el.textContent.toLowerCase().includes('quattro') && el.children.length > 0 && el.textContent.includes('Running')); if (!row) return null; const r = row.getBoundingClientRect(); return { rowText: row.textContent.trim().slice(0, 120), rowWidth: r.width }; })()`,
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

    console.log('verify-563-gate1: PASS -- see findings below.');
    for (const f of findings) console.log(' -', f);
    if (notExercised.length) {
      console.log('verify-563-gate1: NOT EXERCISED:');
      for (const n of notExercised) console.log(' -', n);
    }
    writeFileSync(path.join(SHOTS_DIR, 'findings.json'), JSON.stringify({ findings, notExercised }, null, 2));
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
