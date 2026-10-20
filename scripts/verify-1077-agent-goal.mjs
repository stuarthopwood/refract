#!/usr/bin/env node
// Live CDP check for issue #1077 (UI polish): expanded Stage/subagent rows used to show the
// full Prompt and Result inline, each in its own tall scrollable `max-h-64` code block, crowding
// out the one thing worth a quick read -- the goal. `ToolRow.tsx`'s `SubagentBody` now shows
// only the goal, then a "See input & output" text-link toggle (the new shared
// `InlineDisclosure`, ADR 0003, ported off `Markdown.tsx`'s `MermaidBlock` "Show source" shape)
// revealing the Prompt/Result on demand.
//
// Uses a NEW fixture (`scripts/fixtures/omp-frames/stages-1077.jsonl`, its own header has the
// full provenance note): Stage A ("solo-task") is ONE agent with NO batch `context` at all, so
// `StageGroupRow`'s solo branch must fall back to `SubagentBody`'s own goal (`showGoal={!group.
// context}`) -- its task is a deliberately long, multi-line brief (with a leading "# Goal"
// heading) so the `line-clamp-3` goal paragraph genuinely overflows at a normal composer width.
// Stage A stays OBSERVABLY running (no `item.result` yet) for about 2.5s before settling, the
// window this check uses to prove the toggle reads "See input" (not "...& output") while
// running. Stage B ("members-task") is TWO agents sharing ONE batch `context`, the scenario a
// multi-agent Stage needs to prove no per-member goal duplication and independent per-member
// toggle state.
//
// Eight things proved, in this order:
//   1. Stage A expanded shows ONLY the goal and the toggle link -- no Prompt/Result text is
//      reachable (the toggle's own content stays `hidden`) until the toggle itself opens.
//   2. While Stage A is still running (no result yet), the toggle link reads exactly
//      "See input" (never "...& output").
//   3. The goal paragraph genuinely overflows (`scrollHeight > clientHeight`, a real CSS
//      `line-clamp-3`, not a component that merely never renders more than 3 lines), its own
//      leading "# Goal" heading line is stripped, and later lines (never visible inside the
//      3-line clamp) are still present in the DOM -- reachable by assistive tech, matching every
//      other `line-clamp` precedent in this codebase.
//   4. Once Stage A settles (`item.result` known), the toggle link reads "See input & output";
//      opening it shows BOTH the Prompt and the Result, aria-expanded flips to "true", and the
//      label flips to "Hide input & output".
//   5. Closing the toggle with keyboard focus placed deep inside its own content (a CodeBlock's
//      own Copy button, a real Tab from the link) returns focus to the toggle link itself (Escape
//      closes it) -- the WCAG 2.4.3 hazard issues #991/#1001 already fixed one level up, for a
//      Stage's own trigger.
//   6. Re-opening the toggle, then collapsing and re-expanding Stage A's own OUTER row, leaves
//      the toggle COLLAPSED again (`aria-expanded="false"`) -- no remembered state survives a
//      fresh mount.
//   7. Stage B's own shared goal shows once (`StageContextBrief`); NEITHER member's own body
//      renders a goal paragraph of its own (`showGoal={false}` for every multi-agent member).
//   8. Each member's own toggle opens and closes independently of its sibling.
//
// Every screenshot (two structural, two per-theme) is preceded by `settleForScreenshot` (neutral
// pointer position, blurred active element, Escape, wait for no stray tooltip/hover card) --
// fails if one is still open. 2 themes: Dark, Obsidian.
//
// WRITTEN, NOT RUN end-to-end: no build slot has been granted for this sub-task (the lane's own
// build-slot gating rule forbids any cargo/Tauri build until Main grants one) -- hand-built
// directly against the documented wire contract and the product code this check targets, never
// yet replayed against a real built exe.

import { mkdtempSync, writeFileSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, getProcessExecutablePath } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  safeRmSync,
  requireSharedCargoTarget,
  switchTheme,
  clearKnownOutputFiles
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, launchBuiltExeWithEnv, titleSelector, stageContentSelector, stageTriggerSelector, expandRow } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, pressTab, pressEscape } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName } from './verify-tauri-560-helpers.mjs';
import { settleForScreenshot } from './verify-700-todo-pin-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROMPT_MESSAGE = 'Run the two-Stage goal-only batch (issue #1077 live check).';
const SHOTS_DIR =
  process.env.REFRACT_1077_SHOTS_DIR || path.join(tmpdir(), `refract-1077-agent-goal-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const SHOT_NAMES = [
  '01-stage-a-goal-only.png',
  '02-stage-a-toggle-open.png',
  '1077-agent-goal-dark.png',
  '1077-agent-goal-obsidian.png',
  'report.json',
  'app.log',
  'fake-omp-invocations.log'
];
const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' }
];

// Stage A: solo, no batch context -- `computeStageLabel` falls back to the one agent's own name.
const STAGE_A_TITLE = 'Stage 1 \u00b7 SoloSweep';
// Stage B: two agents sharing one context -- `extractContextLabel`'s 60-char truncate-with-
// ellipsis rule applied to the fixture's own exact context string (computed once, by hand,
// against `stageMeta.ts`'s own `truncateLabel`, not guessed).
const STAGE_B_TITLE = "Stage 2 \u00b7 Confirm Stage members never duplicate the Stage's own shared\u2026";
const TOGGLE_MARKER_ATTR = 'data-refract-1077-toggle';

function toggleButtonSelector(stageTitle) {
  return `(${stageContentSelector(stageTitle)})?.querySelector('button[aria-expanded][aria-controls]')`;
}

function toggleContentSelector(stageTitle) {
  return `(() => { const btn = (${toggleButtonSelector(stageTitle)}); if (!btn) return null; return document.getElementById(btn.getAttribute('aria-controls')); })()`;
}

function goalParagraphSelector(stageTitle) {
  return `(${stageContentSelector(stageTitle)})?.querySelector('p.line-clamp-3')`;
}

async function main() {
  let shimDir, dataDir, importSourceDir, repoDir, exeDir, launcherDir;
  let child;
  let targetPid;
  let cdp;
  const findings = [];
  const failures = [];
  const notExercised = [];
  let exeHash = null;
  let gitHeadSha = null;
  let dirty = 'unknown';
  let BUILD_OUTPUT_DIR = null;
  try {
    clearKnownOutputFiles(SHOTS_DIR, 'refract-1077-agent-goal-shots', SHOT_NAMES);
    BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1077-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1077-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1077-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-1077-repo-')), 'verify-1077-agent-goal');
    const repoName = path.basename(repoDir);
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1077-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1077-launcher-'));
    const port = await getFreePort();

    console.log(`verify-1077: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`verify-1077: shots dir ${SHOTS_DIR}`);
    console.log(`verify-1077: CDP port ${port}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-1077' });
    const exePath = built.dest;
    exeHash = built.hash;
    console.log(`verify-1077: built exe copied to ${exePath}`);

    const launched = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'stages-1077',
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log')
      }
    });
    child = launched.child;
    targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-1077: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
    );

    const debugLogPath = path.join(exeDir, 'fake-omp-invocations.log');
    if (!existsSync(debugLogPath)) {
      throw new Error(`verify-1077: fake-omp debug log not found at ${debugLogPath} -- the fake omp shim never ran.`);
    }
    findings.push('Fake omp shim confirmed running (debug log present).');

    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    const session = await latestSessionIdAndName(cdp, repoName, []);
    findings.push(`Session "${session.name}" created in the scratch repo, agent attached (fake omp, stages-1077 scenario).`);

    await cdp.typeIntoByLabel('Message', PROMPT_MESSAGE);
    await cdp.clickByLabel('Send message');

    // ---- Phase 1: Stage A mounts and is still running (the fixture's own 2.5s delay before
    // solo-task's own tool_execution_end) -- expand it and confirm goal-only, "See input". ----
    await cdp.waitFor(`!!${titleSelector(STAGE_A_TITLE)}`, { timeoutMs: 15_000, label: 'Stage A row mounted' });
    await expandRow(cdp, STAGE_A_TITLE);
    await cdp.waitFor(`!!(${toggleButtonSelector(STAGE_A_TITLE)})`, { timeoutMs: 10_000, label: "Stage A's own toggle link mounted" });

    const toggleHiddenWhileRunning = await cdp.evaluate(`(${toggleContentSelector(STAGE_A_TITLE)})?.hasAttribute('hidden') ?? null`);
    if (toggleHiddenWhileRunning !== true) {
      failures.push(`Stage A's own Prompt/Result content is not hidden the instant it expands (hasAttribute('hidden') = ${JSON.stringify(toggleHiddenWhileRunning)}) -- it must stay behind the toggle until opened.`);
    } else {
      findings.push("Stage A expanded shows only the goal and the toggle link -- its own Prompt/Result content stays hidden until the toggle opens.");
    }
    const runningLabel = await cdp.evaluate(`(${toggleButtonSelector(STAGE_A_TITLE)})?.textContent.trim() ?? null`);
    if (runningLabel !== 'See input') {
      failures.push(`Stage A's own toggle link reads ${JSON.stringify(runningLabel)} while still running (no result yet) -- expected exactly "See input" (no "& output").`);
    } else {
      findings.push('Stage A, still running (no result yet): toggle link reads exactly "See input".');
    }

    // ---- Phase 2: the goal paragraph genuinely overflows its 3-line clamp, its own leading
    // "# Goal" heading is stripped, and later (visually clipped) lines are still in the DOM. ----
    const goalMeasure = await cdp.evaluate(`(() => {
      const p = (${goalParagraphSelector(STAGE_A_TITLE)});
      if (!p) return null;
      return { text: p.textContent, scrollHeight: p.scrollHeight, clientHeight: p.clientHeight };
    })()`);
    if (!goalMeasure) {
      failures.push('Stage A has no `p.line-clamp-3` goal paragraph at all -- the solo-Stage-with-no-context goal fallback did not render.');
    } else {
      if (goalMeasure.text.trim().startsWith('#')) {
        failures.push(`Stage A's own goal text still starts with a literal Markdown heading marker (${JSON.stringify(goalMeasure.text.slice(0, 20))}) -- the leading "# Goal" line should have been stripped.`);
      } else if (!goalMeasure.text.includes('Sweep the fixture tree for issue #1077')) {
        failures.push(`Stage A's own goal text does not include its own task's first real line (got ${JSON.stringify(goalMeasure.text.slice(0, 80))}).`);
      } else {
        findings.push('Stage A\'s own goal text starts at the real first line, its leading "# Goal" heading marker stripped.');
      }
      if (!goalMeasure.text.includes('Final line, never meant to be readable')) {
        notExercised.push("Stage A's own goal text does not retain the task's final line within the 240-char preview budget -- the clamp-overflow proof below still holds on the lines that are present.");
      } else {
        findings.push('Stage A\'s own goal text retains later lines (never visible inside the 3-line clamp) in the DOM, reachable by assistive tech.');
      }
      if (goalMeasure.scrollHeight <= goalMeasure.clientHeight) {
        failures.push(`Stage A's own goal paragraph does not genuinely overflow its clamp (scrollHeight=${goalMeasure.scrollHeight}, clientHeight=${goalMeasure.clientHeight}) -- the 3-line clamp is not provably constraining real content.`);
      } else {
        findings.push(`Stage A's own goal paragraph genuinely overflows its line-clamp-3 (scrollHeight=${goalMeasure.scrollHeight} > clientHeight=${goalMeasure.clientHeight}).`);
      }
    }
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, '01-stage-a-goal-only.png'));

    // ---- Phase 3: Stage A settles (the fixture's own async-result frame) -- the toggle link
    // flips to "See input & output". ----
    await cdp.waitFor(`(${toggleButtonSelector(STAGE_A_TITLE)})?.textContent.trim() === 'See input & output'`, {
      timeoutMs: 15_000,
      label: 'Stage A settles: toggle link reads "See input & output"'
    });
    findings.push('Stage A, once settled (result known): toggle link reads "See input & output".');

    // ---- Phase 4: open the toggle -- Prompt AND Result both show, aria-expanded flips, label
    // flips to "Hide input & output". ----
    await cdp.click(toggleButtonSelector(STAGE_A_TITLE));
    await cdp.waitFor(`(${toggleButtonSelector(STAGE_A_TITLE)})?.getAttribute('aria-expanded') === 'true'`, {
      timeoutMs: 10_000,
      label: "Stage A's own toggle opens (aria-expanded=true)"
    });
    const openedLabel = await cdp.evaluate(`(${toggleButtonSelector(STAGE_A_TITLE)})?.textContent.trim() ?? null`);
    if (openedLabel !== 'Hide input & output') {
      failures.push(`Stage A's own toggle link reads ${JSON.stringify(openedLabel)} once open -- expected exactly "Hide input & output".`);
    } else {
      findings.push('Stage A, open: toggle link reads exactly "Hide input & output".');
    }
    const openedContent = await cdp.evaluate(`(() => {
      const c = (${toggleContentSelector(STAGE_A_TITLE)});
      return c ? { hidden: c.hasAttribute('hidden'), text: c.textContent } : null;
    })()`);
    if (!openedContent || openedContent.hidden) {
      failures.push('Stage A\'s own Prompt/Result content is still hidden after opening the toggle.');
    } else if (!openedContent.text.includes('Sweep the fixture tree') || !openedContent.text.includes('Swept clean')) {
      failures.push("Stage A's own opened content is missing either the full Prompt (task text) or the Result text.");
    } else {
      findings.push("Stage A's own opened content shows both the full Prompt and the Result, no longer hidden.");
    }
    await settleForScreenshot(cdp);
    await cdp.screenshot(path.join(SHOTS_DIR, '02-stage-a-toggle-open.png'));

    // ---- Phase 5: closing the toggle while focus sits deep inside its own content (a real Tab
    // from the link) returns focus to the toggle link itself (Escape closes it). ----
    await cdp.evaluate(`(${toggleButtonSelector(STAGE_A_TITLE)})?.setAttribute(${JSON.stringify(TOGGLE_MARKER_ATTR)}, 'target')`);
    let focusInsideContent = false;
    let tabsUsed = 0;
    for (let i = 0; i < 10 && !focusInsideContent; i++) {
      await pressTab(cdp);
      tabsUsed++;
      focusInsideContent = await cdp.evaluate(`(() => { const c = (${toggleContentSelector(STAGE_A_TITLE)}); return !!c && c.contains(document.activeElement); })()`);
    }
    if (!focusInsideContent) {
      failures.push(`Could not place keyboard focus (real Tab, up to ${tabsUsed} presses) inside Stage A's own opened content -- the focus-return proof could not be set up.`);
    } else {
      findings.push(`Keyboard focus placed (${tabsUsed} real Tab press${tabsUsed === 1 ? '' : 'es'} from the toggle link) inside Stage A's own opened content (a CodeBlock's own Copy button or region).`);
      await pressEscape(cdp);
      await cdp.waitFor(`(${toggleButtonSelector(STAGE_A_TITLE)})?.getAttribute('aria-expanded') === 'false'`, {
        timeoutMs: 5_000,
        label: 'Escape closes the toggle (aria-expanded=false)'
      });
      const focusAfterEscape = await cdp.evaluate(`document.activeElement?.getAttribute(${JSON.stringify(TOGGLE_MARKER_ATTR)}) === 'target'`);
      if (!focusAfterEscape) {
        failures.push('Closing the toggle (Escape) with focus deep inside its own content did NOT return focus to the toggle link (WCAG 2.4.3).');
      } else {
        findings.push('Closing the toggle (Escape) with focus deep inside its own content returned focus to the toggle link itself.');
      }
    }

    // ---- Phase 6: no remembered state -- re-open, collapse Stage A's own OUTER row (unmounting
    // SubagentBody), re-expand it, and confirm the toggle is COLLAPSED again. ----
    await cdp.click(toggleButtonSelector(STAGE_A_TITLE));
    await cdp.waitFor(`(${toggleButtonSelector(STAGE_A_TITLE)})?.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 5_000, label: 'Toggle re-opened before the outer collapse/reopen cycle' });
    await cdp.click(stageTriggerSelector(STAGE_A_TITLE));
    await cdp.waitFor(`(${stageTriggerSelector(STAGE_A_TITLE)})?.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 5_000, label: "Stage A's own outer row collapses" });
    await cdp.click(stageTriggerSelector(STAGE_A_TITLE));
    await cdp.waitFor(`(${stageTriggerSelector(STAGE_A_TITLE)})?.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 5_000, label: "Stage A's own outer row re-expands" });
    await cdp.waitFor(`!!(${toggleButtonSelector(STAGE_A_TITLE)})`, { timeoutMs: 5_000, label: "Stage A's own toggle link remounts" });
    const resetState = await cdp.evaluate(`(${toggleButtonSelector(STAGE_A_TITLE)})?.getAttribute('aria-expanded') ?? null`);
    if (resetState !== 'false') {
      failures.push(`Stage A's own toggle carried a remembered open state across a collapse-then-reopen (aria-expanded=${JSON.stringify(resetState)}, expected "false") -- it must always start collapsed on a fresh expand.`);
    } else {
      findings.push("Stage A's own toggle starts collapsed again after Stage A's own outer row is collapsed and re-expanded -- no remembered state.");
    }

    // ---- Phase 7: Stage B (two members sharing one context) -- the shared goal shows ONCE,
    // neither member's own body duplicates it. ----
    await cdp.waitFor(`!!${titleSelector(STAGE_B_TITLE)}`, { timeoutMs: 15_000, label: 'Stage B row mounted' });
    await expandRow(cdp, STAGE_B_TITLE);
    await cdp.waitFor(
      `(${stageContentSelector(STAGE_B_TITLE)})?.textContent.includes("Confirm Stage members never duplicate") ?? false`,
      { timeoutMs: 10_000, label: "Stage B's own shared context shows as its goal" }
    );
    const stageBGoalCount = await cdp.evaluate(`(() => {
      const content = (${stageContentSelector(STAGE_B_TITLE)});
      if (!content) return null;
      const matches = Array.from(content.querySelectorAll('*')).filter((el) => el.textContent.includes("Confirm Stage members never duplicate") && el.children.length === 0);
      return matches.length;
    })()`);
    if (stageBGoalCount !== 1) {
      failures.push(`Stage B's own shared goal text appears in ${JSON.stringify(stageBGoalCount)} leaf element(s), expected exactly 1 (no per-member duplicate).`);
    } else {
      findings.push("Stage B's own shared goal text appears exactly once -- no member duplicates it.");
    }
    const memberGoalParagraphs = await cdp.evaluate(`(${stageContentSelector(STAGE_B_TITLE)})?.querySelectorAll('p.line-clamp-3').length ?? null`);
    if (memberGoalParagraphs !== 0) {
      failures.push(`Stage B's own members rendered ${JSON.stringify(memberGoalParagraphs)} goal paragraph(s) of their own -- a multi-agent member must never show its own goal.`);
    } else {
      findings.push("Neither of Stage B's own two members renders a goal paragraph of its own.");
    }

    // ---- Phase 8: each member's own toggle opens/closes independently of its sibling. ----
    await expandRow(cdp, 'MemberOne');
    await expandRow(cdp, 'MemberTwo');
    await cdp.waitFor(`!!(${toggleButtonSelector('MemberOne')})`, { timeoutMs: 10_000, label: "MemberOne's own toggle link mounted" });
    await cdp.waitFor(`!!(${toggleButtonSelector('MemberTwo')})`, { timeoutMs: 10_000, label: "MemberTwo's own toggle link mounted" });
    await cdp.click(toggleButtonSelector('MemberOne'));
    await cdp.waitFor(`(${toggleButtonSelector('MemberOne')})?.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 5_000, label: "MemberOne's own toggle opens" });
    const memberTwoUnaffected = await cdp.evaluate(`(${toggleButtonSelector('MemberTwo')})?.getAttribute('aria-expanded') ?? null`);
    if (memberTwoUnaffected !== 'false') {
      failures.push(`Opening MemberOne's own toggle also changed MemberTwo's (aria-expanded=${JSON.stringify(memberTwoUnaffected)}, expected "false") -- toggles must be independent per member.`);
    } else {
      findings.push("Opening MemberOne's own toggle leaves MemberTwo's own toggle collapsed -- independent per-member state confirmed.");
    }
    const memberOneContent = await cdp.evaluate(`(${toggleContentSelector('MemberOne')})?.textContent ?? ''`);
    if (!memberOneContent.includes('never repeats the Stage') || !memberOneContent.includes('no duplicate goal text')) {
      failures.push("MemberOne's own opened content is missing its own Prompt or Result text.");
    } else {
      findings.push("MemberOne's own opened content shows its own Prompt and Result, scoped to itself only.");
    }

    for (const theme of THEMES) {
      await switchTheme(cdp, theme.id, theme.name);
      await settleForScreenshot(cdp);
      const shotName = `1077-agent-goal-${theme.id}.png`;
      await cdp.screenshot(path.join(SHOTS_DIR, shotName));
      findings.push(`Screenshot captured under the ${theme.name} theme (${shotName}), no stray hover card or tooltip open.`);
    }

    const report = {
      gitHead: gitHeadSha,
      dirty,
      exeSha256: exeHash,
      findings,
      failures,
      notExercised,
      exitCode: failures.length > 0 ? 1 : 0
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-1077: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-1077: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-1077: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-1077: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
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
    console.error('verify-1077: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) {
      await stopLauncher(child).catch(() => {});
      if (targetPid != null) {
        const stillRunningExePath = getProcessExecutablePath(targetPid);
        if (stillRunningExePath) {
          console.warn(`verify-1077: process ${targetPid} still appears to be running after stopLauncher (exe path: ${stillRunningExePath}) -- cleanup may be incomplete.`);
        } else {
          console.log(`verify-1077: confirmed process ${targetPid} exited after stopLauncher.`);
        }
      }
    }
    try {
      if (exeDir && existsSync(path.join(exeDir, 'app.log'))) copyFileSync(path.join(exeDir, 'app.log'), path.join(SHOTS_DIR, 'app.log'));
      if (exeDir && existsSync(path.join(exeDir, 'fake-omp-invocations.log'))) copyFileSync(path.join(exeDir, 'fake-omp-invocations.log'), path.join(SHOTS_DIR, 'fake-omp-invocations.log'));
    } catch (err) {
      console.warn('verify-1077: could not preserve logs:', err.message);
    }
    await safeRmSync(shimDir);
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
  }
}

main().catch((err) => {
  console.error('verify-1077: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
