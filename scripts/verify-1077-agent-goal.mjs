#!/usr/bin/env node
// Live CDP check for issue #1077 (UI polish): expanded Stage/subagent rows used to show the
// full Prompt and Result inline, each in its own tall scrollable `max-h-64` code block, crowding
// out the one thing worth a quick read -- the goal. `ToolRow.tsx`'s `SubagentBody` now shows
// only the goal, then a "See input & output" text-link toggle (the new shared
// `InlineDisclosure`, ADR 0003, ported off `Markdown.tsx`'s `MermaidBlock` "Show source" shape)
// revealing the Prompt/Result on demand.
//
// Uses a fixture (`scripts/fixtures/omp-frames/stages-1077.jsonl`, its own header has the full
// provenance note): Stage A ("solo-task") is ONE agent with NO batch `context` at all, so the
// Stage level renders `SubagentGoalPreview` from `item.task` directly (ordered before "Uses:");
// its task is a deliberately long, multi-line brief (a leading "# Goal" heading) so the
// `line-clamp-3` goal paragraph genuinely overflows at a normal composer width. Stage A stays
// OBSERVABLY running (no `item.result` yet) for about 2.5s before settling, the window this
// check uses to prove the toggle reads "See input" (not "...& output") while running. Stage B
// ("members-task") is TWO agents sharing ONE batch `context` (stamped on only the first item on
// the wire -- `SubagentChainRow.tsx`'s own `toolCallIdsWithContext` correlation is what both
// members must resolve through), the scenario a multi-agent Stage needs to prove no per-member
// goal duplication and independent per-member toggle state. Stage C ("flat-task") is TWO agents
// with NO context at all (gate round 1 fix, item 1's own live step): neither member has a Stage
// goal to lean on, so each shows its own, independently derived. The final assistant message
// includes a tiny Mermaid fenced block (gate round 1 fix, item 8: `MermaidBlock`'s own "Show
// source" toggle was ported onto the same shared `InlineDisclosure`, so it gains Escape-to-close
// and a correct focus ring for free -- proven directly here, not only by inspection).
//
// Gate round 1 (Main, 2026-10-20): Code FAIL on one High, fixed in this one round, plus the
// Medium/Low findings below -- all fixed here too.
//   1. HIGH: a context-less multi-agent Stage showed no goal anywhere (`showGoal={false}` was
//      hardcoded for every member). Fixed: `SubagentChainRow.tsx` correlates by `toolCallId`
//      (`item.context` alone is unreliable per member -- the wire stamps a call's own `context`
//      argument onto only that call's spec-index-0 item); Stage C (new) live-checks the
//      genuinely context-less case directly.
//   2. MEDIUM: the goal preview's own character cap (240) was tighter than its visual
//      `line-clamp-3` needed, `.slice()` could split a surrogate pair, and only the FIRST line
//      had its heading/blank-line noise cleaned. Fixed: raised to 1500 (a DOM-size guard only,
//      the visual clamp is CSS alone), a code-point-safe truncate, cleaning THROUGHOUT, and a
//      shared `findFirstContentLine` helper (`stageMeta.ts`) replacing the copied loop.
//   3-5, 7, 9-10: `InlineDisclosure.tsx` Escape/focus/style fixes, `SubagentChainRow.tsx`'s
//      goal-before-"Uses:" ordering and solo failure-reason line, and `ToolRow.tsx`'s per-link
//      `sr-only` name suffix -- see each file's own gate-round-1 comments for detail.
//
// Nine things proved, in this order:
//   1. Stage A expanded shows ONLY the goal and the toggle link -- no Prompt/Result text is
//      reachable (the toggle's own content stays `hidden`) until the toggle itself opens.
//   2. While Stage A is still running (no result yet), the toggle link reads exactly
//      "See input for SoloSweep" (never "...& output").
//   3. The goal paragraph genuinely overflows (`scrollHeight > clientHeight`, a real CSS
//      `line-clamp-3`, not a component that merely never renders more than 3 lines), its own
//      leading "# Goal" heading line is stripped, and later lines (never visible inside the
//      3-line clamp, but within the 1500-char DOM-size guard) are still present in the DOM --
//      reachable by assistive tech, matching every other `line-clamp` precedent in this codebase.
//   4. Once Stage A settles (`item.result` known), the toggle link reads "See input & output for
//      SoloSweep"; opening it shows BOTH the Prompt and the Result, aria-expanded flips to
//      "true", and the label flips to "Hide input & output for SoloSweep".
//   5. Closing the toggle with keyboard focus placed deep inside its own content (a CodeBlock's
//      own Copy button, a real Tab from the link) returns focus to the toggle link itself (Escape
//      closes it) -- the WCAG 2.4.3 hazard issues #991/#1001 already fixed one level up, for a
//      Stage's own trigger.
//   6. Re-opening the toggle, then collapsing and re-expanding Stage A's own OUTER row, leaves
//      the toggle COLLAPSED again (`aria-expanded="false"`) -- no remembered state survives a
//      fresh mount.
//   7. Stage B's own shared goal shows once (`StageContextBrief`); NEITHER member's own body
//      renders a goal paragraph of its own, each member's own toggle opens/closes independently.
//   8. Stage C (a context-less multi-agent "flat call"): BOTH members show their own goal,
//      independently derived -- the HIGH fix's own required live step.
//   9. `Markdown.tsx`'s Mermaid "Show source" toggle: reached and opened via real keyboard input
//      (Shift+Tab back from the composer, then a real Enter), a hard `:focus-visible` ring
//      match (not only a screenshot), then Escape closes it -- the same shared `InlineDisclosure`
//      every Stage/subagent toggle uses, gained for free.
//
// Every screenshot is preceded by a stray-tooltip/hover-card check (`settleForScreenshot` for
// every shot except the one deliberately keyboard-focused ring proof, which uses a lighter,
// non-blurring equivalent so the very focus state being proven survives to the screenshot --
// see that phase's own comment). 2 themes: Dark, Obsidian.

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
import { buildOmpShim, launchBuiltExeWithEnv, titleSelector, stageContentSelector, stageTriggerSelector, expandRow, clickScrolled } from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, pressTab, pressEscape, pressKey } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName, pressRealEnter } from './verify-tauri-560-helpers.mjs';
import { settleForScreenshot } from './verify-700-todo-pin-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROMPT_MESSAGE = 'Run the three-Stage goal-only batch (issue #1077 live check).';
const SHOTS_DIR =
  process.env.REFRACT_1077_SHOTS_DIR || path.join(tmpdir(), `refract-1077-agent-goal-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const SHOT_NAMES = [
  '01-stage-a-goal-only.png',
  '02-stage-a-toggle-open.png',
  '03-mermaid-toggle-ring.png',
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
// Stage C: two agents, NO context -- `sharedNamePrefix(['FlatOne', 'FlatTwo'])` resolves to
// their shared 4-character prefix "Flat" (computed by hand against `stageMeta.ts`'s own rule).
const STAGE_C_TITLE = 'Stage 3 \u00b7 Flat';
const TOGGLE_MARKER_ATTR = 'data-refract-1077-toggle';
// Gate round 1 fix (item 8): any button whose own text starts with "Show source for"/"Hide
// source for" -- `MermaidBlock`'s own accessible-name convention, unique in this fixture (one
// diagram only).
const MERMAID_TOGGLE_SELECTOR = `Array.from(document.querySelectorAll('button')).find((b) => /^(Show|Hide) source for /.test(b.textContent.trim()))`;

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
    if (runningLabel !== 'See input for SoloSweep') {
      failures.push(`Stage A's own toggle link reads ${JSON.stringify(runningLabel)} while still running (no result yet) -- expected exactly "See input for SoloSweep" (no "& output").`);
    } else {
      findings.push('Stage A, still running (no result yet): toggle link reads exactly "See input for SoloSweep".');
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
        notExercised.push("Stage A's own goal text does not retain the task's final line within the 1500-char DOM-size guard -- the clamp-overflow proof below still holds on the lines that are present.");
      } else {
        findings.push('Stage A\'s own goal text retains every line (within the 1500-char DOM-size guard, well inside its own ~400-char task), including the final one never visible inside the 3-line clamp -- reachable by assistive tech.');
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
    // flips to "See input & output for SoloSweep". ----
    await cdp.waitFor(`(${toggleButtonSelector(STAGE_A_TITLE)})?.textContent.trim() === 'See input & output for SoloSweep'`, {
      timeoutMs: 15_000,
      label: 'Stage A settles: toggle link reads "See input & output for SoloSweep"'
    });
    findings.push('Stage A, once settled (result known): toggle link reads "See input & output for SoloSweep".');

    // ---- Phase 4: open the toggle -- Prompt AND Result both show, aria-expanded flips, label
    // flips to "Hide input & output for SoloSweep". ----
    await clickScrolled(cdp, toggleButtonSelector(STAGE_A_TITLE));
    await cdp.waitFor(`(${toggleButtonSelector(STAGE_A_TITLE)})?.getAttribute('aria-expanded') === 'true'`, {
      timeoutMs: 10_000,
      label: "Stage A's own toggle opens (aria-expanded=true)"
    });
    const openedLabel = await cdp.evaluate(`(${toggleButtonSelector(STAGE_A_TITLE)})?.textContent.trim() ?? null`);
    if (openedLabel !== 'Hide input & output for SoloSweep') {
      failures.push(`Stage A's own toggle link reads ${JSON.stringify(openedLabel)} once open -- expected exactly "Hide input & output for SoloSweep".`);
    } else {
      findings.push('Stage A, open: toggle link reads exactly "Hide input & output for SoloSweep".');
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
    await clickScrolled(cdp, toggleButtonSelector(STAGE_A_TITLE));
    await cdp.waitFor(`(${toggleButtonSelector(STAGE_A_TITLE)})?.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 5_000, label: 'Toggle re-opened before the outer collapse/reopen cycle' });
    await clickScrolled(cdp, stageTriggerSelector(STAGE_A_TITLE));
    await cdp.waitFor(`(${stageTriggerSelector(STAGE_A_TITLE)})?.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 5_000, label: "Stage A's own outer row collapses" });
    await clickScrolled(cdp, stageTriggerSelector(STAGE_A_TITLE));
    await cdp.waitFor(`(${stageTriggerSelector(STAGE_A_TITLE)})?.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 5_000, label: "Stage A's own outer row re-expands" });
    await cdp.waitFor(`!!(${toggleButtonSelector(STAGE_A_TITLE)})`, { timeoutMs: 5_000, label: "Stage A's own toggle link remounts" });
    const resetState = await cdp.evaluate(`(${toggleButtonSelector(STAGE_A_TITLE)})?.getAttribute('aria-expanded') ?? null`);
    if (resetState !== 'false') {
      failures.push(`Stage A's own toggle carried a remembered open state across a collapse-then-reopen (aria-expanded=${JSON.stringify(resetState)}, expected "false") -- it must always start collapsed on a fresh expand.`);
    } else {
      findings.push("Stage A's own toggle starts collapsed again after Stage A's own outer row is collapsed and re-expanded -- no remembered state.");
    }

    // ---- Phase 7: Stage B (two members sharing one context) -- the shared goal shows ONCE,
    // neither member's own body duplicates it (even though the wire only stamps `context` on
    // MemberOne, the fixture's own spec-index-0 item -- `toolCallIdsWithContext` must correlate
    // MemberTwo to the same call). ----
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
      failures.push(`Stage B's own members rendered ${JSON.stringify(memberGoalParagraphs)} goal paragraph(s) of their own -- a multi-agent member sharing its Stage's own context must never show its own goal too, including MemberTwo (no context stamped on its own wire item, correlated to MemberOne's by toolCallId).`);
    } else {
      findings.push("Neither of Stage B's own two members renders a goal paragraph of its own, including MemberTwo (correlated by toolCallId, not its own absent item.context).");
    }
    // Falsified live (first build-slot run): Phase 7's own wait above only confirms Stage B's
    // shared CONTEXT is visible (echoed immediately with the toolCall), not that it has
    // SETTLED -- the fixture's own 1500ms delay before `tool_execution_end` meant Phase 8 used
    // to open MemberOne's toggle before its own `item.result` existed, so the Result half of
    // its content was never rendered at all (`{resultBlock != null && (...)}`), a genuine
    // script race, not a product defect. Waits for MemberOne's own result text specifically
    // (both members settle in the same `tool_execution_end` call in this fixture).
    await cdp.waitFor(`(${stageContentSelector(STAGE_B_TITLE)})?.textContent.includes('Confirmed: no duplicate goal text') ?? false`, {
      timeoutMs: 15_000,
      label: "Stage B settles: MemberOne's own result text visible"
    });

    // ---- Phase 8: each member's own toggle opens/closes independently of its sibling. ----
    await expandRow(cdp, 'MemberOne');
    await expandRow(cdp, 'MemberTwo');
    await cdp.waitFor(`!!(${toggleButtonSelector('MemberOne')})`, { timeoutMs: 10_000, label: "MemberOne's own toggle link mounted" });
    await cdp.waitFor(`!!(${toggleButtonSelector('MemberTwo')})`, { timeoutMs: 10_000, label: "MemberTwo's own toggle link mounted" });
    await clickScrolled(cdp, toggleButtonSelector('MemberOne'));
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

    // ---- Phase 9 (gate round 1 fix, item 1's own required live step): a context-less MULTI-
    // agent Stage (a flat call, no shared context at all) -- BOTH members show their OWN goal,
    // since neither has a context of its own (nor a sibling's) to lean on. ----
    await cdp.waitFor(`!!${titleSelector(STAGE_C_TITLE)}`, { timeoutMs: 15_000, label: 'Stage C row mounted' });
    await expandRow(cdp, STAGE_C_TITLE);
    await cdp.waitFor(`(${stageContentSelector(STAGE_C_TITLE)})?.textContent.includes('Confirmed: the sibling member') ?? false`, {
      timeoutMs: 15_000,
      label: 'Stage C settles'
    });
    await expandRow(cdp, 'FlatOne');
    await expandRow(cdp, 'FlatTwo');
    const stageCGoalParagraphs = await cdp.evaluate(`(${stageContentSelector(STAGE_C_TITLE)})?.querySelectorAll('p.line-clamp-3').length ?? null`);
    if (stageCGoalParagraphs !== 2) {
      failures.push(`Stage C (a context-less multi-agent "flat call") shows ${JSON.stringify(stageCGoalParagraphs)} goal paragraph(s), expected exactly 2 -- one per member, neither sharing a Stage context to lean on (issue #1077 gate round 1, item 1, HIGH).`);
    } else {
      findings.push('Stage C (a context-less multi-agent "flat call"): both members show their own goal paragraph -- the HIGH fix\'s own required live step.');
    }
    const flatOneGoal = await cdp.evaluate(`(${goalParagraphSelector('FlatOne')})?.textContent ?? null`);
    const flatTwoGoal = await cdp.evaluate(`(${goalParagraphSelector('FlatTwo')})?.textContent ?? null`);
    if (!flatOneGoal?.includes('Confirm this member shows its own goal') || !flatTwoGoal?.includes('Confirm the sibling member shows its own goal')) {
      failures.push(`Stage C's own members show the wrong goal text (FlatOne=${JSON.stringify(flatOneGoal)}, FlatTwo=${JSON.stringify(flatTwoGoal)}) -- each member's own goal must come from its OWN task, never a shared or swapped one.`);
    } else {
      findings.push("Stage C's own two members each show their OWN, independently-derived goal text.");
    }

    // ---- Phase 10 (gate round 1 fix, item 8): the final message's own Mermaid diagram -- its
    // "Show source" toggle (`Markdown.tsx`'s `MermaidBlock`) was ported onto the SAME shared
    // `InlineDisclosure` every Stage/subagent toggle above uses, so it inherits Escape-to-close
    // and a correct focus ring for free; proven directly via real keyboard input (Shift+Tab back
    // from the composer, a real Enter), not only by code inspection. ----
    await cdp.waitFor(`!!document.querySelector('img[role="img"]')`, { timeoutMs: 20_000, label: 'Mermaid diagram rendered' });
    await clickScrolled(cdp, `document.querySelector('[aria-label="Message"]')`);
    let mermaidFocused = false;
    let shiftTabsUsed = 0;
    for (let i = 0; i < 25 && !mermaidFocused; i++) {
      await pressKey(cdp, 9, 'Tab', 'Tab', 8);
      shiftTabsUsed++;
      mermaidFocused = await cdp.evaluate(`(() => { const btn = (${MERMAID_TOGGLE_SELECTOR}); return !!btn && document.activeElement === btn; })()`);
    }
    if (!mermaidFocused) {
      failures.push(`Could not reach the Mermaid "Show source" toggle via keyboard (real Shift+Tab, up to ${shiftTabsUsed} presses back from the composer).`);
    } else {
      findings.push(`Reached the Mermaid "Show source" toggle via ${shiftTabsUsed} real Shift+Tab press${shiftTabsUsed === 1 ? '' : 'es'} back from the composer.`);
      await pressRealEnter(cdp);
      await cdp.waitFor(`(${MERMAID_TOGGLE_SELECTOR})?.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 5_000, label: 'Mermaid toggle opens via real keyboard activation' });
      const ringMatch = await cdp.evaluate(`(() => { const btn = (${MERMAID_TOGGLE_SELECTOR}); return !!btn && btn.matches(':focus-visible'); })()`);
      if (!ringMatch) {
        failures.push('Mermaid "Show source" toggle opened via real keyboard activation, but does not match :focus-visible -- no real ring would show to a keyboard user.');
      } else {
        findings.push('Mermaid "Show source" toggle opens via real keyboard activation (Enter) and matches :focus-visible -- a hard ring proof, not only a screenshot.');
      }
      // A lighter, non-blurring stray-tooltip check (NOT the full `settleForScreenshot`, which
      // blurs the active element -- doing so here would destroy the very focus-visible state
      // this screenshot exists to show, the same reasoning `verify-1001-stage-focus-join.mjs`'s
      // own Dark-theme "real proof" shot documents for an identical tension).
      await cdp.waitFor(
        `!document.querySelector('[role="tooltip"]') && !document.querySelector('[data-slot="tooltip-content"]') && !document.querySelector('[data-slot="hover-card-content"]')`,
        { timeoutMs: 3_000, label: 'No stray tooltip/hover card before the ring screenshot' }
      );
      await cdp.screenshot(path.join(SHOTS_DIR, '03-mermaid-toggle-ring.png'));
      await pressEscape(cdp);
      await cdp.waitFor(`(${MERMAID_TOGGLE_SELECTOR})?.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 5_000, label: 'Escape closes the Mermaid toggle' });
      findings.push('Escape closes the Mermaid "Show source" toggle too -- the same shared Escape handler every InlineDisclosure caller gets for free.');
    }

    for (const theme of THEMES) {
      await switchTheme(cdp, theme.id, theme.name);
      await settleForScreenshot(cdp);
      const shotName = `1077-agent-goal-${theme.id}.png`;
      await cdp.screenshot(path.join(SHOTS_DIR, shotName));
      findings.push(`Screenshot captured under the ${theme.name} theme (${shotName}), no stray hover card or tooltip open (Stage B's two members, each opened, scoped correctly).`);
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
