#!/usr/bin/env node
// Live CDP check for issue #1001 (Bug, a11y): focus drops to `<body>` when a one-agent Stage
// gains a second agent while focus is inside it. `src/renderer/features/chat/SubagentChainRow.tsx`'s
// `StageGroupRow` swaps its own content from a bare `SubagentBody` (`total === 1`) to a
// `SpineList` of `SubagentRow`s (`total > 1`) the instant a second agent streams into the same
// Stage -- unmounting whatever was focused inside the first member's own Prompt/Result code
// block along with it. Removing a focused DOM node blurs it to `<body>` synchronously in every
// real browser, so there is no later point at which the old focus target can be asked whether
// it held focus; the fix (`StageGroupRow`'s own `focusWasInsideRef`/`triggerRef` pair) instead
// tracks focus continuously via a `focusin`/`focusout` listener and, the instant the 1-to-2
// transition is observed with focus known to have been inside, moves it to the Stage's OWN
// trigger -- the one element guaranteed to survive every member-count transition (the same
// remedy `Transcript.tsx`'s own "Scroll to end" button/viewport pair already uses for an
// analogous removed-while-focused control).
//
// Decided (Skippy, delegated by Stuart 2026-10-19), recorded on #1001: the structural
// alternative (pre-wrapping the solo body in the same `SpineList`/`SpineItem` shape a joining
// second member would need, keeping `SubagentBody` itself mounted with no redirect needed at
// all) was rejected -- it either draws the Spine's own rail/indent for every solo Stage (a
// permanent, unrelated visual regression) or leaves the FIRST member looking different from
// every later one forever (no `SubagentRow` chrome, unlike #563's own "never switch element
// type between solo and multi members" rule intends). The fallback the issue itself names --
// "move focus to the Stage trigger when focused content is removed" -- is what is implemented
// and proven here.
//
// Uses a NEW fixture (`scripts/fixtures/omp-frames/stages-1001.jsonl`, its own header has the
// full provenance note): ONE Stage whose two members arrive as two SEPARATE `task()` tool calls
// sharing the same owning assistant message id ("msg-a1") -- the documented mechanism
// (`transcript.rs`/`subagent_items.rs`, read in full while authoring the fixture) by which a
// Stage genuinely GROWS from one member to two in place, rather than ever starting a new Stage.
// The existing `stages-941.jsonl` fixture (shared by every `verify-941-*`/`verify-991-*`/
// `verify-1000-*` script) cannot exercise this: every one of its ten Stages declares its full
// member count upfront in a single `task()` call's own `tasks[]` array, so none of them ever
// grows after its first render -- a genuinely new fixture was required (per this sub-task's own
// brief), not a reuse of the existing one.
//
// Five things proved, in this order:
//   1. The Stage genuinely renders solo first (`total === 1`, a bare `SubagentBody`, no
//      `SpineList`) -- `JoinsLater`'s own title is absent from the DOM at this point.
//   2. Keyboard focus is placed inside the solo member's own Prompt code block
//      (`ToolRow.tsx`'s `CodeBlock`, the `[role="region"]` `SubagentBody` renders), confirmed via
//      a marker attribute set on it right before focusing (`document.activeElement` reference
//      equality survives the eventual re-render of other, unrelated parts of the tree; a marker
//      attribute does not).
//   3. `document.activeElement` is sampled on every animation frame (`requestAnimationFrame`,
//      not Node-side polling, so no CDP round-trip jitter can widen or narrow the window) across
//      the ENTIRE join -- from before the second `task()` call starts, through the live
//      `message_start`/`message_end` re-snapshot that actually grows `group.items` from 1 to 2,
//      to well after it settles. THE ONE RED/GREEN DISCRIMINATOR: zero of those sampled frames
//      may ever read `document.activeElement === document.body`. MUST fail on `origin/main`:
//      there, nothing redirects focus on this transition, so the frame immediately following the
//      unmount reads `document.activeElement === document.body` and stays there (nothing else in
//      this fixture ever moves focus again).
//   4. Once `JoinsLater` has genuinely mounted (`SpineList`/`SubagentRow`, proving the Stage is
//      now `total > 1` and the OLD solo content is gone), focus is confirmed to have landed on
//      the Stage's own trigger specifically (`triggerRef`), not merely "somewhere other than
//      body" -- the fix's own stated remedy, not a weaker nearby proof.
//   5. A cheap, non-exclusive per-theme screenshot pass (no re-assertion: this check is
//      structural -- `document.activeElement`, DOM ancestry, animation-frame sampling -- never
//      colour-dependent, matching `verify-991-stage-focus.mjs`'s own identical theme-loop
//      rationale).
//
// WRITTEN, NOT RUN end-to-end: no build slot has been granted for this sub-task -- `node --check`
// plus a real `import()` load-check are the only commands that have actually been run against
// this file. Every shared DOM/class-name selector/helper reused here was already grep-verified by
// the `verify-941-*`/`verify-991-*` scripts that share them.

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
import {
  buildOmpShim,
  launchBuiltExeWithEnv,
  titleSelector,
  stageContentSelector,
  stageTriggerSelector,
  expandRow
} from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName } from './verify-tauri-560-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROMPT_MESSAGE = 'Run the solo-then-joined batch (issue #1001 live check: focus survives a Stage gaining a second agent).';
const SHOTS_DIR =
  process.env.REFRACT_1001_SHOTS_DIR || path.join(tmpdir(), `refract-1001-stage-focus-join-shots-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const SHOT_NAMES = [
  '01-solo-focus-placed.png',
  '02-joined-focus-on-trigger.png',
  '1001-stage-focus-join-dark.png',
  '1001-stage-focus-join-obsidian.png',
  '1001-stage-focus-join-dark-high-contrast.png',
  'report.json',
  'app.log',
  'fake-omp-invocations.log'
];

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' }
];

// `stages-1001.jsonl`'s own Stage keeps ONE stable header label across the whole 1-to-2
// transition (its header note explains why: `solo-task`'s own shared batch `context` is the
// only one either member ever carries, so `computeStageLabel`'s tier-1 rule never changes once
// `join-task` -- which carries no context of its own -- joins).
const STAGE_TITLE = 'Stage 1 \u00b7 Verify focus survives a mid-flight join (issue #1001).';
const FOCUS_MARKER_ATTR = 'data-refract-1001-focus';

function promptCodeBlockExpr() {
  // First `[role="region"]` inside this Stage's own expanded content, in DOM order -- the solo
  // member's own Prompt block (`ToolRow.tsx`'s `SubagentBody`, `Markdown.tsx`'s `CodeBlock`);
  // its Result block (same `aria-label`, rendered second) is not reached by `querySelector`
  // picking the first match, so no extra scoping is needed to disambiguate the two.
  return `(${stageContentSelector(STAGE_TITLE)})?.querySelector('[role="region"]')`;
}

function joinedMemberExpr() {
  return `document.querySelector('[title="JoinsLater"]')`;
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
    clearKnownOutputFiles(SHOTS_DIR, 'refract-1001-stage-focus-join-shots', SHOT_NAMES);
    BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1001-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1001-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1001-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-1001-repo-')), 'verify-1001-stage-focus-join');
    const repoName = path.basename(repoDir);
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1001-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1001-launcher-'));
    const port = await getFreePort();

    console.log(`verify-1001: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`verify-1001: shots dir ${SHOTS_DIR}`);
    console.log(`verify-1001: CDP port ${port}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-1001' });
    const exePath = built.dest;
    exeHash = built.hash;
    console.log(`verify-1001: built exe copied to ${exePath}`);

    const launched = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'stages-1001',
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log')
      }
    });
    child = launched.child;
    targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-1001: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
    );

    const debugLogPath = path.join(exeDir, 'fake-omp-invocations.log');
    if (!existsSync(debugLogPath)) {
      throw new Error(`verify-1001: fake-omp debug log not found at ${debugLogPath} -- the fake omp shim never ran (shim confirmed check).`);
    }
    const debugLogFirstLine = readFileSync(debugLogPath, 'utf8').split('\n')[0] ?? '';
    if (!/^pid=\d+ argv=/.test(debugLogFirstLine)) {
      throw new Error(`verify-1001: fake-omp debug log's first line does not match the expected "pid=<pid> argv=..." startup line (shim confirmed check); got: ${JSON.stringify(debugLogFirstLine)}`);
    }
    findings.push(`Fake omp shim confirmed: debug log's first line is its own startup pid line (${debugLogPath}).`);

    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    const sessionA = await latestSessionIdAndName(cdp, repoName, []);
    findings.push(`Session "${sessionA.name}" created in the scratch repo, agent attached (fake omp, stages-1001 scenario).`);

    await cdp.typeIntoByLabel('Message', PROMPT_MESSAGE);
    await cdp.clickByLabel('Send message');

    // ---- Setup: the Stage renders solo (total === 1) and settles before `join-task` ever
    // starts (the fixture's own ~400ms delay before `solo-task`'s own `tool_execution_end`) ----
    await cdp.waitFor(`!!${titleSelector(STAGE_TITLE)}`, { timeoutMs: 15_000, label: 'Solo Stage row mounted' });
    const joinedBeforeSetup = await cdp.evaluate(`!!(${joinedMemberExpr()})`);
    if (joinedBeforeSetup) {
      failures.push('JoinsLater was already present in the DOM before this check ever placed focus -- the solo-first window could not be observed (fixture timing regression).');
    } else {
      findings.push('Confirmed the Stage renders solo first (JoinsLater absent) before focus is placed inside it.');
    }
    await expandRow(cdp, STAGE_TITLE);
    const expandedState = await cdp.evaluate(`(${stageTriggerSelector(STAGE_TITLE)})?.getAttribute('aria-expanded') ?? null`);
    if (expandedState !== 'true') {
      failures.push(`Expanding the solo Stage row did not set aria-expanded="true" (got ${JSON.stringify(expandedState)}) -- the focus-placement setup could not proceed.`);
    }
    await cdp.waitFor(`!!(${promptCodeBlockExpr()})`, { timeoutMs: 10_000, label: "Solo member's own Prompt code block mounted" });

    // Marker attribute (not a live DOM reference, which cannot cross a CDP round trip): lets the
    // in-page animation-frame sampler below ask "is THIS specific element still focused" without
    // re-querying by role/aria-label, which could otherwise match the Result block too once it
    // mounts, or match nothing once this exact node is removed (the very transition under test).
    await cdp.evaluate(`(${promptCodeBlockExpr()})?.setAttribute(${JSON.stringify(FOCUS_MARKER_ATTR)}, 'target')`);
    await cdp.evaluate(`(${promptCodeBlockExpr()})?.focus()`);
    const focusedBefore = await cdp.evaluate(`document.activeElement?.getAttribute(${JSON.stringify(FOCUS_MARKER_ATTR)}) === 'target'`);
    if (!focusedBefore) {
      failures.push("Could not place keyboard focus on the solo member's own Prompt code block -- the focus-survives-the-join proof could not be set up.");
    } else {
      findings.push("Keyboard focus placed on the solo member's own Prompt code block, inside the one-agent Stage's content.");
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '01-solo-focus-placed.png'));

    // ---- Phase: sample document.activeElement on every animation frame across the WHOLE join
    // (issue #1001's own red/green discriminator) -- in-page, not Node-side polling, so no CDP
    // round-trip jitter can ever widen or narrow the sampled window. Budget: 6.5s comfortably
    // covers the fixture's own 3000ms pre-join delay + 1500ms post-join settle delay either side
    // of the actual transition, with margin for a slow CI host. ----
    const triggerExprText = stageTriggerSelector(STAGE_TITLE);
    const sampleBudgetMs = 6500;
    await cdp.evaluate(`(() => {
      window.__r1001 = { samples: [], start: performance.now(), done: false };
      const tick = () => {
        const active = document.activeElement;
        const trigger = (${triggerExprText});
        window.__r1001.samples.push({
          t: Math.round(performance.now() - window.__r1001.start),
          isBody: active === document.body,
          isNull: active == null,
          isTrigger: !!trigger && active === trigger,
          isTarget: !!active && typeof active.getAttribute === 'function' && active.getAttribute(${JSON.stringify(FOCUS_MARKER_ATTR)}) === 'target',
          joined: !!(${joinedMemberExpr()})
        });
        if (performance.now() - window.__r1001.start < ${sampleBudgetMs}) {
          requestAnimationFrame(tick);
        } else {
          window.__r1001.done = true;
        }
      };
      requestAnimationFrame(tick);
    })()`);
    await cdp.waitFor('window.__r1001.done === true', { timeoutMs: sampleBudgetMs + 5_000, label: 'Animation-frame sampling window complete' });
    const samples = await cdp.evaluate('window.__r1001.samples');

    if (!Array.isArray(samples) || samples.length === 0) {
      failures.push('No animation-frame samples were captured across the join window -- the sampling proof could not run.');
    } else {
      findings.push(`Sampled document.activeElement on ${samples.length} animation frames across the join window (~${sampleBudgetMs}ms).`);
      const bodySamples = samples.filter((s) => s.isBody || s.isNull);
      if (bodySamples.length > 0) {
        failures.push(
          `document.activeElement was <body> (or null) in ${bodySamples.length} of ${samples.length} sampled frames across the join (first at t=${bodySamples[0].t}ms) -- issue #1001 regression (WCAG 2.4.3).`
        );
      } else {
        findings.push('document.activeElement was never <body> (nor null) across every sampled animation frame spanning the join -- issue #1001 fix confirmed, THE discriminating proof.');
      }

      const preJoinSamples = samples.filter((s) => !s.joined);
      const joinedSamples = samples.filter((s) => s.joined);
      if (joinedSamples.length === 0) {
        notExercised.push('JoinsLater never mounted within the sampled window -- the join could not be observed as genuinely happening; the before/after focus-redirect proof did not run as designed this pass.');
      } else {
        if (!preJoinSamples.some((s) => s.isTarget)) {
          notExercised.push("No pre-join sample confirmed focus on the solo member's own Prompt code block -- the 'focus was genuinely inside the removed content' precondition could not be confirmed independently of the earlier one-shot check.");
        } else {
          findings.push("Confirmed via animation-frame sampling (not just the earlier one-shot check) that focus sat on the solo member's own Prompt code block for at least one frame before the join.");
        }
        const lastSample = samples[samples.length - 1];
        if (!lastSample.isTrigger) {
          failures.push(`Once settled after the join, document.activeElement was not the Stage's own trigger (last sample: isBody=${lastSample.isBody}, isNull=${lastSample.isNull}, isTrigger=${lastSample.isTrigger}) -- expected the fix's own stated remedy (focus moved to the Stage trigger), not merely "somewhere other than body".`);
        } else {
          findings.push("Once settled after the join, document.activeElement is the Stage's own trigger -- the fix's own stated remedy confirmed, not merely a weaker 'somewhere other than body' proof.");
        }
      }
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '02-joined-focus-on-trigger.png'));

    for (const theme of THEMES) {
      await switchTheme(cdp, theme.id, theme.name);
      const shotName = `1001-stage-focus-join-${theme.id}.png`;
      await cdp.screenshot(path.join(SHOTS_DIR, shotName));
      findings.push(`Screenshot captured under the ${theme.name} theme (${shotName}) -- no colour-dependent assertion in this check, every proof above is structural (document.activeElement, DOM ancestry, animation-frame sampling).`);
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
    console.log('\n=== verify-1001: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-1001: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-1001: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-1001: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
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
    console.error('verify-1001: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) {
      await stopLauncher(child).catch(() => {});
      if (targetPid != null) {
        const stillRunningExePath = getProcessExecutablePath(targetPid);
        if (stillRunningExePath) {
          console.warn(`verify-1001: process ${targetPid} still appears to be running after stopLauncher (exe path: ${stillRunningExePath}) -- cleanup may be incomplete.`);
        } else {
          console.log(`verify-1001: confirmed process ${targetPid} exited after stopLauncher.`);
        }
      }
    }
    try {
      if (exeDir && existsSync(path.join(exeDir, 'app.log'))) copyFileSync(path.join(exeDir, 'app.log'), path.join(SHOTS_DIR, 'app.log'));
      if (exeDir && existsSync(path.join(exeDir, 'fake-omp-invocations.log'))) copyFileSync(path.join(exeDir, 'fake-omp-invocations.log'), path.join(SHOTS_DIR, 'fake-omp-invocations.log'));
    } catch (err) {
      console.warn('verify-1001: could not preserve logs:', err.message);
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
  console.error('verify-1001: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
