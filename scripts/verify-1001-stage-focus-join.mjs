#!/usr/bin/env node
// Live CDP check for #1001 (a11y): focus dropped to `<body>` when a one-agent Stage gained a
// second agent while focus was inside it. `StageGroupRow` swaps a bare `SubagentBody` for a
// `SpineList`, unmounting the focused node, and a removed node cannot be asked whether it held
// focus. The fix tracks focus via `focusin`/`focusout` and, on the 1-to-2 transition, moves it to
// the Stage's own trigger, the one element that survives every member-count change. Pre-wrapping
// the solo body in `SpineList` instead was rejected (permanent visual regression for solo Stages).
//
// Uses `scripts/fixtures/omp-frames/stages-1001.jsonl`: one Stage whose two members arrive as
// separate `task()` calls under the same assistant message id, so it grows in place. The shared
// `stages-941.jsonl` declares every member upfront and never grows.
//
// Proves, in order:
//   1. The Stage renders solo first (no `SpineList`; `JoinsLater` absent).
//   2. A real keyboard Tab places focus in the solo member's Prompt code block, confirmed by a
//      marker attribute (a DOM reference does not survive the re-render).
//   3. `document.activeElement` sampled on every animation frame (in-page, so no CDP jitter)
//      across the whole join is never `document.body`. This is the RED/GREEN discriminator.
//   4. Once `JoinsLater` mounts, focus is on the Stage's own trigger, not merely not-body.
//   5. A per-theme screenshot pass (structural check, not colour-dependent).
//
// Window blur fires `focusout` with `activeElement` unchanged, so the handler ignores that
// signature; a simulated blur is spliced in before the join. A click-away negative proof needs
// its own second 1-to-2 transition and is recorded in `notExercised`.

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

// The Stage keeps one stable header label across the 1-to-2 transition: only `solo-task` carries
// a context, so `computeStageLabel`'s tier-1 rule never changes when `join-task` joins.
const STAGE_TITLE = 'Stage 1 \u00b7 Verify focus survives a mid-flight join (issue #1001).';
const FOCUS_MARKER_ATTR = 'data-refract-1001-focus';

function promptCodeBlockExpr() {
  // First `[role="region"]` in this Stage's expanded content is the solo member's Prompt block;
  // the Result block renders second, so no extra scoping is needed.
  return `(${stageContentSelector(STAGE_TITLE)})?.querySelector('[role="region"]')`;
}

function joinedMemberExpr() {
  // Scoped to this Stage's content: an unscoped `[title="JoinsLater"]` could match another row
  // reusing the agent name.
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

    // Setup: the Stage renders solo and settles before `join-task` starts (~400ms fixture delay).
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

    // Marker attribute (a DOM reference cannot cross CDP): lets the sampler ask whether this exact
    // element is still focused without re-querying, which could match the Result block or nothing.
    await cdp.evaluate(`(${promptCodeBlockExpr()})?.setAttribute(${JSON.stringify(FOCUS_MARKER_ATTR)}, 'target')`);
    // A real keyboard Tab, not `.focus()`: it arms `:focus-visible` for the rest of the run, so
    // later screenshots show whether a keyboard user sees a ring. A bounded loop presses Tab until
    // the marker matches, because `CodeBlockHeader`'s Copy button precedes the region in DOM order.
    let focusedBefore = false;
    let tabsUsed = 0;
    for (let i = 0; i < 10 && !focusedBefore; i++) {
      await pressTab(cdp);
      tabsUsed++;
      focusedBefore = await cdp.evaluate(`document.activeElement?.getAttribute(${JSON.stringify(FOCUS_MARKER_ATTR)}) === 'target'`);
    }
    if (!focusedBefore) {
      failures.push(`Could not place keyboard focus (real Tab, up to ${tabsUsed} presses) on the solo member's own Prompt code block -- the focus-survives-the-join proof could not be set up.`);
    } else {
      findings.push(`Keyboard focus placed (${tabsUsed} real Tab press${tabsUsed === 1 ? '' : 'es'} from the Stage trigger, past its own Copy button) on the solo member's own Prompt code block, inside the one-agent Stage's content.`);
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '01-solo-focus-placed.png'));

    // Simulated window blur (`Emulation.setFocusEmulationEnabled`) before the join. A real blur
    // never reassigns `document.activeElement`, so a temporary test-only listener records whether
    // a `focusout` with `target === activeElement` fired or `document.hasFocus()` went false. If
    // neither signal appears, a `window` `blur` event is tried; if that fails too it is recorded
    // as `notExercised`, since the later redirect only proves the positive path.
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
      // No signal yet: fall back to dispatching a real `window` `blur` event.
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

    // Sample document.activeElement on every animation frame across the whole join, in-page so
    // CDP jitter cannot skew the window. 6.5s covers the fixture's 3000ms pre-join and 1500ms
    // post-join delays with margin for a slow host.
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
        // A missed join is a hard failure: silently passing would hide the gap this script exists to catch.
        failures.push('JoinsLater never mounted within the sampled window -- the join could not be observed as genuinely happening; the before/after focus-redirect proof did not run.');
      } else {
        // The last pre-join frame must show focus still inside the solo content when it was removed.
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
          // Hard `:focus-visible` match, read in Dark before `switchTheme` moves focus away.
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
