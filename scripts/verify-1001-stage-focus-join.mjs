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
// First build-slot run (head `3941250`): GENUINELY FAILED -- `document.activeElement` was
// `<body>` in 208 of 390 sampled frames, never redirected (last sample `isTrigger: false`).
// Root cause: the focus-tracking listener was attached via a plain `useRef` + `useEffect(() =>
// {...}, [])`, which runs exactly once at `StageGroupRow`'s own initial mount -- but a solo
// Stage starts collapsed (Radix never renders `CollapsibleContent` while closed), so the ref
// was still `null` at that one run and the listener was never attached once the row was later
// expanded. Fixed with a callback ref (head `28b26e1`, re-fires on every real mount/unmount of
// the node); re-ran clean (0 failures, 0 notExercised, verdict DONE).
//
// Gate round 1 (Main, 2026-10-19): five findings, all fixed in this one round --
//   1. (A11y/UI Medium) A window blur fires `focusout` with `relatedTarget` null while
//      `document.activeElement` stays the SAME element (never reassigned by a blur) --
//      `StageGroupRow`'s own handler now returns early (keeping the flag) when
//      `event.target === document.activeElement`, the window-blur signature.
//   2. (Code/Test/A11y Medium) A click onto a non-focusable spot used to leave the flag stuck
//      true forever (indistinguishable from a real removal using `relatedTarget`/
//      `activeElement` alone) -- now uses the repo's own `ProfileAlertRows.tsx`/
//      `FileExplorerPanel.tsx` rAF-plus-`isConnected` pattern to tell the two apart.
//   3. (Code Medium) A missed join (or a missed pre-join precondition) is now a hard FAILURE,
//      not a silent `notExercised`; the LAST pre-join frame (not merely "any" frame) must
//      confirm focus; `joinedMemberExpr` below is now scoped to this Stage's own content.
//   4. (Test/A11y Medium, Visual) Focus is now placed with a REAL keyboard Tab (not `.focus()`),
//      arming `:focus-visible` for the rest of the run; the Dark-theme screenshot (taken BEFORE
//      any theme switch moves focus onto the theme picker) is backed by a hard
//      `:focus-visible` match, not eyeballing alone -- the later per-theme shots are honestly
//      labelled as non-proofs (`switchTheme` itself steals focus via a mouse click).
//   5. (Test Medium) A simulated window blur (`Emulation.setFocusEmulationEnabled`) is spliced
//      in before the join, re-using the existing assertions rather than a separate check; a
//      dedicated click-away negative proof needs its own second 1-to-2 transition and is
//      recorded in `notExercised` instead.

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
import { addRepository, createSessionViaQuickCreate, pressTab } from './verify-tauri-session-list-helpers.mjs';
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
  // Gate round 1 fix (item 3, Code Medium): scoped to THIS Stage's own content, the same
  // ancestor-scoping convention `promptCodeBlockExpr` above already uses -- an unscoped global
  // `[title="JoinsLater"]` lookup could in principle match an unrelated row elsewhere in the
  // DOM (a different Stage or turn reusing the same agent name).
  return `(${stageContentSelector(STAGE_TITLE)})?.querySelector('[title="JoinsLater"]')`;
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
    // Gate round 1 fix (item 4, Test/A11y Medium, Visual): a REAL keyboard Tab, not a bare
    // `.focus()` call -- `expandRow` above already left focus on the Stage's own trigger via a
    // real mouse click, so Tab from there is the same path a real keyboard user takes into the
    // expanded content. This also arms the browser's own `:focus-visible` "last interaction was
    // keyboard" state for the REST of this run, including the fix's own later PROGRAMMATIC
    // redirect call (`triggerRef.current.focus(...)`) -- a screenshot taken after a bare
    // `.focus()` call here would prove nothing about whether a real keyboard user ever sees a
    // visible ring.
    await pressTab(cdp);
    const focusedBefore = await cdp.evaluate(`document.activeElement?.getAttribute(${JSON.stringify(FOCUS_MARKER_ATTR)}) === 'target'`);
    if (!focusedBefore) {
      failures.push("Could not place keyboard focus (real Tab) on the solo member's own Prompt code block -- the focus-survives-the-join proof could not be set up.");
    } else {
      findings.push("Keyboard focus placed (real Tab from the Stage trigger) on the solo member's own Prompt code block, inside the one-agent Stage's content.");
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '01-solo-focus-placed.png'));

    // Gate round 1 fix (item 5, Test Medium; condition added on Main's own grant, 2026-10-19):
    // a simulated window blur (CDP's `Emulation.setFocusEmulationEnabled`, the standard
    // headless-testing way to exercise this without actually losing real OS focus), spliced in
    // BEFORE the join, re-using the SAME assertions below rather than a separate negative check
    // -- IF it genuinely produces a real signal. `document.activeElement` is never reassigned
    // by a real window blur, so it cannot confirm anything on its own; a TEMPORARY, test-only
    // listener (never product code) on the Prompt code block itself records whether a
    // `focusout` with `event.target === document.activeElement` (the exact signature
    // `SubagentChainRow.tsx`'s own handler checks) actually fired, and whether
    // `document.hasFocus()` went `false`. If `Emulation.setFocusEmulationEnabled` produces
    // neither signal on this WebView2 renderer, a real `window` `blur` event is dispatched as a
    // second, still-cheap attempt before giving up. If NEITHER attempt ever produces either
    // signal, this is recorded honestly as `notExercised` -- never silently claimed as a pass
    // just because the later join still happens to redirect correctly (that proves the
    // POSITIVE path, not that the window-blur code path was ever actually exercised).
    await cdp.evaluate(`(() => {
      window.__r1001Blur = { focusoutSeen: false };
      const target = (${promptCodeBlockExpr()});
      if (target) {
        target.addEventListener('focusout', (event) => {
          if (event.target === document.activeElement) window.__r1001Blur.focusoutSeen = true;
        });
      }
    })()`);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await new Promise((resolve) => setTimeout(resolve, 200));
    let blurDiag = await cdp.evaluate(`({ focusoutSeen: window.__r1001Blur.focusoutSeen, hasFocusNow: document.hasFocus() })`);
    if (!blurDiag.focusoutSeen && blurDiag.hasFocusNow !== false) {
      // First attempt produced no observable signal -- try the real `window` `blur` event
      // dispatch Main's own grant names as the cheap fallback, before concluding this is a gap.
      await cdp.evaluate(`window.dispatchEvent(new Event('blur'))`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      blurDiag = await cdp.evaluate(`({ focusoutSeen: window.__r1001Blur.focusoutSeen, hasFocusNow: document.hasFocus() })`);
    }
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const windowBlurExercised = blurDiag.focusoutSeen || blurDiag.hasFocusNow === false;
    if (windowBlurExercised) {
      findings.push(
        `Simulated a window blur (observed signal: focusout-with-activeElement-unchanged=${blurDiag.focusoutSeen}, document.hasFocus() went false=${blurDiag.hasFocusNow === false}) while focus sat inside the solo member's own content, before the join -- re-uses the sampling assertions below rather than a separate check (gate round 1, item 5).`
      );
    } else {
      notExercised.push(
        'Gate round 1 item 5 (window-blur case): neither Emulation.setFocusEmulationEnabled(false) nor a dispatched window "blur" event produced an observable focusout-with-activeElement-unchanged or a document.hasFocus() === false signal on this WebView2 renderer -- the window-blur code path (SubagentChainRow.tsx\'s own `event.target === document.activeElement` check) was not actually exercised this run; honestly recorded rather than claimed as a pass merely because the later join still redirects correctly (that proves the positive path only).'
      );
    }

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
        // Gate round 1 fix (item 3, Code Medium): a missed join is a hard FAILURE, not a
        // silent skip -- this script exists specifically to exercise the join; silently
        // passing without ever observing it would hide a real gap, not record one honestly.
        failures.push('JoinsLater never mounted within the sampled window -- the join could not be observed as genuinely happening; the before/after focus-redirect proof did not run.');
      } else {
        // Gate round 1 fix (item 3): the LAST pre-join frame specifically, not merely "any"
        // frame -- the precondition this whole proof rests on is that focus was STILL inside
        // the solo content at the moment it was removed, not merely at some earlier point.
        const lastPreJoinSample = preJoinSamples[preJoinSamples.length - 1];
        if (!lastPreJoinSample || !lastPreJoinSample.isTarget) {
          failures.push("The LAST sample before the join did not confirm focus on the solo member's own Prompt code block -- the 'focus was genuinely inside the removed content at the moment of the join' precondition could not be confirmed.");
        } else {
          findings.push("Confirmed via animation-frame sampling (not just the earlier one-shot check) that focus sat on the solo member's own Prompt code block right up to the LAST sampled frame before the join.");
        }
        const lastSample = samples[samples.length - 1];
        if (!lastSample.isTrigger) {
          failures.push(`Once settled after the join, document.activeElement was not the Stage's own trigger (last sample: isBody=${lastSample.isBody}, isNull=${lastSample.isNull}, isTrigger=${lastSample.isTrigger}) -- expected the fix's own stated remedy (focus moved to the Stage trigger), not merely "somewhere other than body".`);
        } else {
          findings.push("Once settled after the join, document.activeElement is the Stage's own trigger -- the fix's own stated remedy confirmed, not merely a weaker 'somewhere other than body' proof.");
          // Gate round 1 fix (item 4, Test/A11y Medium, Visual): a hard `:focus-visible` match,
          // not eyeballing a screenshot alone -- confirms a real keyboard user (the real Tab
          // placement above armed this) would actually SEE the ring, not merely that the DOM
          // won an invisible focus race. Read fresh here (not from the sampled frames), in the
          // Dark theme, BEFORE the per-theme loop below ever runs `switchTheme` (which itself
          // moves focus onto the theme picker's own control via a mouse click).
          const triggerFocusVisible = await cdp.evaluate(`(() => {
            const el = document.activeElement;
            return { tag: el?.tagName ?? null, matches: !!el && typeof el.matches === 'function' && el.matches(':focus-visible') };
          })()`);
          if (!triggerFocusVisible.matches) {
            failures.push(`Once settled after the join, the Stage trigger does not match :focus-visible (tag=${triggerFocusVisible.tag}) -- a real keyboard user (a real Tab placed the original focus) must see a visible ring, not merely win document.activeElement.`);
          } else {
            findings.push('Once settled after the join, the Stage trigger matches :focus-visible -- a real keyboard user would see the focus ring, confirmed before any theme switch could move focus elsewhere.');
          }
        }
      }
      notExercised.push("A dedicated negative proof for gate round 1 item 2 (focus inside, click a non-focusable area to deliberately clear the flag, THEN the join, confirming focus does NOT move to the trigger) needs its own independent second 1-to-2 Stage transition in this fixture -- this one join is already spent proving the positive path -- so it is recorded here rather than silently assumed to pass.");
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '02-joined-focus-on-trigger.png'));

    for (const [themeIndex, theme] of THEMES.entries()) {
      await switchTheme(cdp, theme.id, theme.name);
      const shotName = `1001-stage-focus-join-${theme.id}.png`;
      await cdp.screenshot(path.join(SHOTS_DIR, shotName));
      findings.push(
        themeIndex === 0
          ? `Screenshot captured under the ${theme.name} theme (${shotName}) -- the real keyboard-driven focus-ring proof above already ran in this theme (Dark, the app's default), before this loop's own first \`switchTheme\` call ever moved focus.`
          : `Screenshot captured under the ${theme.name} theme (${shotName}) -- gate round 1 fix (item 4): NOT claimed as a focus proof -- \`switchTheme\` itself moves real DOM focus onto the theme menu's own control via a mouse click, so this shot cannot show the trigger's own ring. The ring's per-theme colour resolution is already covered by \`theme-contrast-pairs.mjs\`/\`check-theme-contrast.mjs\`; the focus-visible proof itself is theme-independent by construction (one CSS rule), already proven once in Dark above.`
      );
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
