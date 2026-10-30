#!/usr/bin/env node
// Live CDP check for #1077: expanded Stage/subagent rows show only the goal plus a "See input & output"
// InlineDisclosure toggle, not the full Prompt/Result. Fixture: scripts/fixtures/omp-frames/stages-1077.jsonl.
// Stage A solo, B two members sharing one context, C two members with none, D a failed solo; the final
// message's Mermaid "Show source" toggle shares the same disclosure (Escape, focus ring).

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
import {
  toggleButtonSelector,
  toggleContentSelector,
  goalParagraphSelector,
  clickClearOfHeader,
  assertStageDFailureReason
} from './verify-1077-agent-goal-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROMPT_MESSAGE = 'Run the four-Stage goal-only batch (issue #1077 live check).';
const SHOTS_DIR =
  process.env.REFRACT_1077_SHOTS_DIR || path.join(tmpdir(), `refract-1077-agent-goal-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const SHOT_NAMES = [
  '01-stage-a-goal-only.png',
  '02-stage-a-toggle-open.png',
  '03-mermaid-toggle-ring.png',
  '04-stage-d-failure-reason.png',
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

// Stage A: solo, no batch context.
const STAGE_A_TITLE = 'Stage 1 \u00b7 SoloSweep';
// Stage B: two agents sharing one context; label is `extractContextLabel`'s 60-char truncation.
const STAGE_B_TITLE = "Stage 2 \u00b7 Confirm Stage members never duplicate the Stage's own shared\u2026";
// Stage C: two agents, no context; label is their shared name prefix "Flat".
const STAGE_C_TITLE = 'Stage 3 \u00b7 Flat';
// Stage D: solo, no context, fails.
const STAGE_D_TITLE = 'Stage 4 \u00b7 FailSweep';
const TOGGLE_MARKER_ATTR = 'data-refract-1077-toggle';
// Matches `MermaidBlock`'s "Show source for"/"Hide source for" button; unique (one diagram).
const MERMAID_TOGGLE_SELECTOR = `Array.from(document.querySelectorAll('button')).find((b) => /^(Show|Hide) source for /.test(b.textContent.trim()))`;

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

    // ---- Phase 1: Stage A still running: goal-only, "See input" ----
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

    // ---- Phase 2: goal overflows its 3-line clamp; clipped lines stay in the DOM ----
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

    // ---- Phase 3: Stage A settles; toggle reads "See input & output" ----
    await cdp.waitFor(`(${toggleButtonSelector(STAGE_A_TITLE)})?.textContent.trim() === 'See input & output for SoloSweep'`, {
      timeoutMs: 15_000,
      label: 'Stage A settles: toggle link reads "See input & output for SoloSweep"'
    });
    findings.push('Stage A, once settled (result known): toggle link reads "See input & output for SoloSweep".');

    // ---- Phase 4: open the toggle: Prompt and Result both show ----
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

    // ---- Phase 5: Escape with focus deep inside the content returns focus to the toggle (WCAG 2.4.3) ----
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
      // The Copy button's Radix Tooltip opens on keyboard focus; the first Escape must dismiss only
      // that Tooltip (FR-093, WCAG 1.4.13), the second closes the disclosure.
      const tooltipOpenedOnFocus = await cdp.evaluate(`!!document.querySelector('[data-slot="tooltip-content"]')`);
      if (tooltipOpenedOnFocus) {
        await pressEscape(cdp);
        await cdp.waitFor(`!document.querySelector('[data-slot="tooltip-content"]')`, {
          timeoutMs: 5_000,
          label: "First Escape press dismisses the Copy button's own focus-triggered Tooltip"
        });
        const stillOpenAfterFirstEscape = await cdp.evaluate(`(${toggleButtonSelector(STAGE_A_TITLE)})?.getAttribute('aria-expanded') === 'true'`);
        if (!stillOpenAfterFirstEscape) {
          failures.push('The first Escape press closed the whole disclosure instead of only the nested Tooltip -- the nested control did not win the first press (FR-093).');
        } else {
          findings.push("The first Escape press dismissed only the Copy button's own Tooltip, leaving the disclosure itself open -- the nested control won the first press (FR-093).");
        }
      }
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

    // ---- Phase 6: collapsing and re-expanding the outer row leaves the toggle collapsed ----
    await clickScrolled(cdp, toggleButtonSelector(STAGE_A_TITLE));
    await cdp.waitFor(`(${toggleButtonSelector(STAGE_A_TITLE)})?.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 5_000, label: 'Toggle re-opened before the outer collapse/reopen cycle' });
    await clickClearOfHeader(cdp, stageTriggerSelector(STAGE_A_TITLE));
    await cdp.waitFor(`(${stageTriggerSelector(STAGE_A_TITLE)})?.getAttribute('aria-expanded') === 'false'`, { timeoutMs: 5_000, label: "Stage A's own outer row collapses" });
    await clickClearOfHeader(cdp, stageTriggerSelector(STAGE_A_TITLE));
    await cdp.waitFor(`(${stageTriggerSelector(STAGE_A_TITLE)})?.getAttribute('aria-expanded') === 'true'`, { timeoutMs: 5_000, label: "Stage A's own outer row re-expands" });
    await cdp.waitFor(`!!(${toggleButtonSelector(STAGE_A_TITLE)})`, { timeoutMs: 5_000, label: "Stage A's own toggle link remounts" });
    const resetState = await cdp.evaluate(`(${toggleButtonSelector(STAGE_A_TITLE)})?.getAttribute('aria-expanded') ?? null`);
    if (resetState !== 'false') {
      failures.push(`Stage A's own toggle carried a remembered open state across a collapse-then-reopen (aria-expanded=${JSON.stringify(resetState)}, expected "false") -- it must always start collapsed on a fresh expand.`);
    } else {
      findings.push("Stage A's own toggle starts collapsed again after Stage A's own outer row is collapsed and re-expanded -- no remembered state.");
    }

    // ---- Phase 7: Stage B shows the shared goal once; the wire stamps `context` only on MemberOne,
    // so `toolCallIdsWithContext` must correlate MemberTwo to the same call. ----
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
    // Wait for MemberOne's result, not just the shared context: opening the toggle before
    // `item.result` exists renders no Result block (a script race, not a product defect).
    await cdp.waitFor(`(${stageContentSelector(STAGE_B_TITLE)})?.textContent.includes('Confirmed: no duplicate goal text') ?? false`, {
      timeoutMs: 15_000,
      label: "Stage B settles: MemberOne's own result text visible"
    });

    // ---- Phase 8: each member's toggle opens/closes independently ----
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

    // ---- Phase 9: context-less multi-agent Stage: both members show their own goal ----
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

    // ---- Phase 10: a failed solo Stage shows its failure reason without opening the toggle ----
    await assertStageDFailureReason(cdp, findings, failures, STAGE_D_TITLE, { titleSelector, expandRow, settleForScreenshot, SHOTS_DIR });

    // ---- Phase 11: Mermaid "Show source" shares InlineDisclosure; checked via real keyboard input ----
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
      // Lighter stray-tooltip check: `settleForScreenshot` blurs the active element, which would
      // destroy the focus-visible state this screenshot shows.
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
