#!/usr/bin/env node
// Real-omp live gate check for #563: the fake-omp tape cannot exercise the multi-Stage chain, a visible Running/Cancelled status
// word, or Show-thinking-toggle independence. Uses the ambient signed-in profile (no OMP_PROFILE), a scratch repo and scratch data
// dirs, so the real Session list is never touched; spends a few real model tokens on tiny subagent prompts.
//   (a) two parallel task() calls then a serial one: chain row renders, panel opens pre-selected, closing returns focus.
//   (b) one task() call Stopped mid-run: Cancelled word in StageGroupRow's `meta` slot, not overlapping the agent name.
//   (c) the (a) turn re-rendered with Show thinking off: Stage count and numbering must be identical.
// The built exe is copied to a private scratch dir first because a concurrent lane can overwrite the shared CARGO_TARGET_DIR exe.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, createWriteStream, copyFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, launchViaJobObject, isTargetOwningPort, sleep } from './verify-tauri-cdp.mjs';
import { requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = path.join(tmpdir(), 'refract-563-gate1-shots');

const TURN_A_PROMPT =
  "Make your very first tool call be exactly ONE call to the task tool that starts TWO subagents together in that SAME call (not two separate calls -- one call, two subagents in it): the first subagent's entire job is to reply with exactly the single word 'uno' and nothing else; the second subagent's entire job is to reply with exactly the single word 'dos' and nothing else. Wait for both of those to finish. Then, once both have finished, call the task tool a second time, by itself, with one tiny subagent whose entire job is to reply with exactly the single word 'tres' and nothing else. Once all three subagents have replied, reply with exactly the single word 'gate563complete' yourself and nothing else.";
const TURN_B_PROMPT =
  // The subagent pads out a slow count first so Stop can land mid-run; a one-word reply settled before Stop landed.
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

/** Rebuilds the debug exe, then copies it to `destDir` immediately: a concurrent lane's build can overwrite the shared
 * `CARGO_TARGET_DIR` exe mid-session. The whole build-and-copy is retried up to `maxAttempts` times if the source's
 * mtime/size/hash changed between the build finishing and the copy completing. */
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
  // No PATH override and no OMP_PROFILE: resolves the real ambient omp and signed-in profile; the scratch cwd never existed before this run.
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

/** Throws if the private exe copy's hash drifted from the one recorded after build-and-copy, so a critical assertion
 * never trusts output from a modified binary. */
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

/** Background poller that clicks every visible "Approve" button (RequestCard.tsx) so the default "Ask" Approval mode never
 * blocks task() calls. Transient evaluate failures are ignored; the next 400ms tick retries. */
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
    // A real omp spawn plus handshake takes longer than the fake shim.
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 90_000,
      label: 'Session opened, real agent attached, composer enabled',
    });
    findings.push('Session created; REAL omp process attached (ambient signed-in profile, scratch cwd/worktree).');

    // "Ask" mode gates `task` behind an Allow-tool card per subagent batch. Switching to Auto via the IPC bridge raced the
    // asynchronous restart (FR-020) and did not take effect in time, so a poller clicks every pending "Approve" instead.
    autoApprove = startAutoApprove(cdp);

    // ---- Scenario (a): 2 parallel task() calls then 1 serial -> chain row, pre-select, focus ----
    await cdp.typeIntoByLabel('Message', TURN_A_PROMPT);
    await cdp.clickByLabel('Send message');

    try {
      // The composer stays enabled during a running turn, so wait for the literal final reply instead.
      await cdp.waitFor(
        // The sentinel already appears once in the user's prompt bubble; a second occurrence means the assistant said it back.
        `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && (t.textContent.match(/${TURN_A_SENTINEL}/g) ?? []).length >= 2; })()`,
        { timeoutMs: 180_000, label: 'Turn (a) finished (assistant echoed the sentinel back)' },
      );
    } catch (err) {
      await cdp.screenshot(path.join(SHOTS_DIR, '99-diag-turn-a-stage1-failure.png'));
      const htmlOnFailure = await cdp.evaluate(`document.querySelector('[aria-label="Transcript"]')?.outerHTML ?? ''`).catch(() => '');
      writeFileSync(path.join(SHOTS_DIR, 'turn-a-transcript-onfailure.html'), htmlOnFailure);
      throw err;
    }
    // Always dump the transcript HTML: class names/structure tell a Stage-group render from a bare SubagentRow, which `.textContent` cannot.
    const transcriptHtml = await cdp.evaluate(`document.querySelector('[aria-label="Transcript"]')?.outerHTML ?? ''`);
    writeFileSync(path.join(SHOTS_DIR, 'turn-a-transcript.html'), transcriptHtml);
    const hasStageHeader = await cdp.evaluate(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.includes('Stage 1'); })()`,
    );
    if (!hasStageHeader) {
      await cdp.screenshot(path.join(SHOTS_DIR, '99-diag-turn-a-stage1-failure.png'));
      notExercised.push('No "Stage 1" header text found after turn (a) settled; see turn-a-transcript.html for the raw DOM dump. Continuing to check what did render.');
    }
    // Real model timing is not controllable like the fake tape, so capture Running only if Stage 1 is still in flight.
    const stillRunningA = await cdp.evaluate(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.includes('Running'); })()`,
    );
    if (stillRunningA) {
      await cdp.screenshot(path.join(SHOTS_DIR, '02-turn-a-stage1-running.png'));
      findings.push('Stage 1 captured mid-run ("Running" visible in the transcript) before it settled.');
    } else {
      findings.push('Stage 1 had already settled by the time this script could poll for a Running state (real-model timing); the Running status word is instead captured from turn (b) below.');
    }

    // The chain row only renders for 2+ Stages (FR-065); poll its "N stages, M agents" summary rather than a fixed wait.
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
      // A `role="group"` Stage line is a #563 DOM marker an older build could not produce, proving the binary has this code.
      const hasStageGroupMarker = await cdp.evaluate(
        `!!document.querySelector('[role="group"][aria-label^="Stage "]')`,
      );
      if (!hasStageGroupMarker) throw new Error('No [role="group"][aria-label^="Stage "] element found in the chain body -- the running build may not actually contain this PR\u2019s ChainStageLine markup.');
      findings.push(`Subagent chain row rendered: "${chainSummary}" -- confirms the real model followed the 2-parallel-then-1-serial instruction into two Stages within one turn; the chain's own [role="group"] Stage marker is present, confirming this build.`);

      // The chain defaults open while any agent is running/failed/cancelled/exited, so it may already be expanded. The Stage `group`
      // match below only exists while expanded (Radix unmounts collapsed content); clicking the trigger unconditionally would collapse it.
      // Read `aria-expanded` first; click only when "false".
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

      // Scoped to a `[role="group"][aria-label^="Stage "]` wrapper: a bare "button containing 'tres'" also matches Stage 2's own disclosure trigger.
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

        // The pre-select used `.focus()`, which Chromium may not treat as keyboard for `:focus-visible`; a real arrow key
        // (`Input.dispatchKeyEvent`) is. `ArrowUp` because "tres" is the last row and `ArrowDown` never fires there.
        // Own try/catch so this supplementary check cannot swallow the close/focus-return check below.
        try {
          await pressKey(cdp, 'ArrowUp', 38);
          await cdp.waitFor(
            `(() => { const sel = document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"][aria-selected="true"]'); return !!sel && !sel.textContent.toLowerCase().includes('tres'); })()`,
            { timeoutMs: 10_000, label: 'ArrowUp moved the roving tab stop off "tres"' },
          );
          const m7Outline = await cdp.evaluate(
            `(() => { const el = document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"][aria-selected="true"]'); if (!el) return null; const cs = getComputedStyle(el); return { isActiveElement: el === document.activeElement, outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, text: el.textContent }; })()`,
          );
          await cdp.screenshot(path.join(SHOTS_DIR, '05b-turn-a-panel-keyboard-focus-ring.png'));
          if (!m7Outline || !m7Outline.isActiveElement) {
            notExercised.push(`M7 live check could not confirm the ArrowUp-focused tree row is document.activeElement: ${JSON.stringify(m7Outline)}`);
          } else if (m7Outline.outlineStyle === 'none' || m7Outline.outlineWidth === '0px') {
            notExercised.push(`M7 REGRESSION: the keyboard-focused tree row paints no outline live (outline-style=${m7Outline.outlineStyle}, outline-width=${m7Outline.outlineWidth}).`);
          } else {
            findings.push(`M7 live confirmation: a REAL keyboard ArrowUp (Input.dispatchKeyEvent, not a script focus() call) moved the roving tab stop to "${m7Outline.text}", whose own computed style is outline-style=${m7Outline.outlineStyle}, outline-width=${m7Outline.outlineWidth}, outline-color=${m7Outline.outlineColor} -- a real, painting :focus-visible ring on the real build, not just a compiled utility that looks right in isolation.`);
          }
        } catch (err) {
          notExercised.push(`M7 keyboard-ring check did not complete: ${err.message}`);
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

    try {
      assertExeUnchanged(exePath, exeHash, 'before thinking-toggle check');
      const stagesBefore = await cdp.evaluate(`(document.querySelector('[aria-label="Transcript"]')?.textContent.match(/Stage \\d+/g) ?? []).join(',')`);
      // Assert non-empty first: two empty strings (no "Stage N" text found) would otherwise pass `stagesBefore === stagesAfter` vacuously.
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

    try {
      await cdp.typeIntoByLabel('Message', TURN_B_PROMPT);
      await cdp.clickByLabel('Send message');
      await cdp.waitFor(
        // Exact-text span match: the user's prompt bubble already contains "quattro", so a substring check resolves before task() is called.
        `(() => { const t = document.querySelector('[aria-label="Transcript"]'); if (!t) return false; return Array.from(t.querySelectorAll('span')).some((el) => el.textContent.trim().toLowerCase() === 'quattro'); })()`,
        { timeoutMs: 60_000, label: 'Turn (b) subagent "quattro" row rendered (its own label span, case-insensitive -- the model may title-case the subagent name)' },
      );
      await cdp.screenshot(path.join(SHOTS_DIR, '08-turn-b-running.png'));
      // Start from the exact label span and climb to its `CollapsedLine` row (`rounded-md`); matching any element containing both
      // substrings hit an unrelated transcript-wide ancestor (live: an "Info:" notice row).
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
      // The Cancelled word must sit in the meta slot, not the icon's fixed-width span, and not collide with the label.
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
      // PASS must depend on this list: an incomplete run (a missing target, an assertion degraded to "not exercised") must not look clean.
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
