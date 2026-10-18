#!/usr/bin/env node
// Live CDP check for issue #991 (gate follow-ups from the #941 lane's final gate, PR #979):
// Stage row auto-close dropping keyboard focus, toggle memory lost on remount, and the
// `verify-941-stage-naming-helpers.mjs` selector-scoping fix.
//
// Reuses the recorded-frame fake `omp` harness, the SAME `stages-941.jsonl` fixture and the
// SAME `verify-941-stage-naming-helpers.mjs` STAGE*_TITLE/titleSelector/stageContentSelector/
// stageTriggerSelector exports every `verify-941-*` script already shares (AGENTS.md: no new
// fixtures). The fixture gained one additive `{"__delay__": 1500}` (issue #991, 2026-10-18,
// see its own header note) right after Stage 1's assistant-message echo, so Stage 1 is
// genuinely observable as a running, open, two-member Stage for about 1.5s before it settles --
// nothing else in the tape changed, so every existing `verify-941-*` assertion is unaffected.
//
// ui-architect-v3 ruling (posted on #991, recorded in research.md decision 18): item 4 (a mouse
// user reading a Stage row while it auto-closes on an all-success finish) is fixed by making
// `StageGroupRow` sync its own disclosure upward only (never auto-close), matching the per-turn
// Subagent chain row's existing rule -- this also resolves item 1 (the a11y defect) as a side
// effect: with no more automatic close, there is no more transition left that could silently
// drop a keyboard user's focus to `<body>`. This script's own "focus survives settling" check
// (phase 1) therefore proves the STRONGER, now-actual guarantee directly: a Stage opened while
// running stays open and never disturbs focus once it settles, rather than proving a
// focus-rescue INSIDE a close that no longer happens.
//
// Three things proved, in this order (each needs the state the previous one left, so they run
// once, not per theme -- a theme pass takes a screenshot only, at the very end):
//   1. Keyboard focus placed inside Stage 1's content while it is genuinely still running
//      survives it settling all-success, and the row itself stays open (not collapsed) --
//      `document.activeElement` is still the member row's own trigger, never `document.body`
//      (WCAG 2.4.3). MUST fail on `origin/main`: the old bidirectional sync effect auto-closes
//      Stage 1 the instant it settles, which unmounts its `CollapsibleContent` (Radix) and drops
//      focus to `<body>`.
//   2. `scripts/verify-941-stage-naming-helpers.mjs`'s `titleSelector` is scoped to a real
//      per-position Stage row (`[data-slot="message-scroller-item"]` ancestor), proven directly
//      against the chain row's own duplicate title text (the per-turn Subagent chain row stays
//      open for the whole run here, since Stage 5's own `FailAgent` failure keeps it
//      permanently unsettled) -- not merely "the right element happened to appear first".
//   3. A user's own manual toggle on a Stage row (Stage 6, a solo Stage manually expanded) and
//      on the Subagent chain row (manually collapsed) both survive a real session switch away
//      and back -- a genuine React unmount/remount of every Stage/chain row keyed to Session A's
//      own transcript items, even though `ChatPane`/`Transcript` itself is never unmounted.
//      MUST fail on `origin/main`: `userToggledRef`/`open` live in a plain `useRef`/`useState`
//      pair there, reset to whatever the row's own `isOpenByDefault`/`isUnsettled` recomputes on
//      remount -- Stage 6 (solo) always recomputes `false` (never auto-expands), and the chain
//      row always recomputes `true` (Stage 5's failure keeps `isUnsettled` permanently true), so
//      both would read the OPPOSITE of the user's own choice after switching back.
//
// WRITTEN, NOT RUN end-to-end: no build slot has been granted for this sub-task -- `node --check`
// plus a real `import()` load-check are the only commands that have actually been run against
// this file. Every DOM/class-name selector reused here was already grep-verified by the
// `verify-941-*` scripts that share them; the two new finder expressions (the G923Code member
// trigger, the chain row's own "Subagents" trigger) are built the same, already-proven way.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  safeRmSync,
  requireSharedCargoTarget,
  switchTheme
} from './verify-tauri-scratch-helpers.mjs';
import {
  buildOmpShim,
  launchBuiltExeWithEnv,
  clickScrolled,
  expandByFinder,
  titleSelector,
  stageContentSelector,
  stageTriggerSelector,
  STAGE1_TITLE,
  STAGE6_SOLO_TITLE
} from './verify-941-stage-naming-helpers.mjs';
import { addRepository, createSessionViaQuickCreate, sessionOpenButtonFinder } from './verify-tauri-session-list-helpers.mjs';
import { latestSessionIdAndName } from './verify-tauri-560-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROMPT_MESSAGE = 'Run the full ten-stage batch (issue #991 live check: focus and toggle persistence).';

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' }
];

// The chain row's own label is always the literal string "Subagents" (`SubagentChainRow.tsx`),
// never duplicated elsewhere -- unlike a Stage's own title, it needs no `message-scroller-item`
// ancestor scoping (the chain row itself has no such ancestor by design, so `titleSelector`
// would never match it at all).
const CHAIN_TRIGGER = `document.querySelector('[title="Subagents"]')?.closest('[data-slot="collapsible-trigger"]')`;

function g923CodeTriggerExpr() {
  return `(${stageContentSelector(STAGE1_TITLE)})?.querySelector('[title="G923Code"]')?.closest('[data-slot="collapsible-trigger"]')`;
}

async function main() {
  let shimDir, dataDir, importSourceDir, repoDir, exeDir, launcherDir;
  let child;
  let cdp;
  const findings = [];
  const failures = [];
  const notExercised = [];
  let exeHash = null;
  let gitHeadSha = null;
  let dirty = 'unknown';
  let SHOTS_DIR = path.join(tmpdir(), 'refract-991-stage-focus-shots', new Date().toISOString().replace(/[:.]/g, '-'));
  let BUILD_OUTPUT_DIR = null;
  try {
    SHOTS_DIR = process.env.REFRACT_991_SHOTS_DIR || SHOTS_DIR;
    mkdirSync(SHOTS_DIR, { recursive: true });
    BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-991-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-991-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-991-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-991-repo-')), 'verify-991-stage-focus');
    const repoName = path.basename(repoDir);
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-991-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-991-launcher-'));
    const port = await getFreePort();

    console.log(`verify-991: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`verify-991: shots dir ${SHOTS_DIR}`);
    console.log(`verify-991: CDP port ${port}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-991' });
    const exePath = built.dest;
    exeHash = built.hash;
    console.log(`verify-991: built exe copied to ${exePath}`);

    const launched = await launchBuiltExeWithEnv(launcherExe, exePath, {
      port,
      dataDir,
      importSourceDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'stages-941',
        REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log')
      }
    });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-991: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
    );
    await addRepository(cdp, repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    const sessionA = await latestSessionIdAndName(cdp, repoName, []);
    findings.push(`Session "${sessionA.name}" created in the scratch repo, agent attached (fake omp, stages-941.jsonl scenario, additively delayed after Stage 1 for this check).`);

    await cdp.typeIntoByLabel('Message', PROMPT_MESSAGE);
    await cdp.clickByLabel('Send message');

    // ---- Phase 1: focus placed inside a genuinely running Stage 1 survives it settling, and
    // the row itself stays open (issue #991 items 1 and 4) ----
    await cdp.waitFor(
      `(() => { const c = (${stageContentSelector(STAGE1_TITLE)}); return !!c && c.textContent.includes('Running'); })()`,
      { timeoutMs: 15_000, label: 'Stage 1 genuinely running (additive fixture delay window)' }
    );
    const stage1TriggerBefore = await cdp.evaluate(`(${stageTriggerSelector(STAGE1_TITLE)})?.getAttribute('aria-expanded') ?? null`);
    if (stage1TriggerBefore !== 'true') {
      failures.push(`Stage 1 was not auto-open while running (aria-expanded was ${JSON.stringify(stage1TriggerBefore)}, expected "true").`);
    } else {
      findings.push('Stage 1 auto-opened while running, as expected.');
    }
    await cdp.evaluate(`(${g923CodeTriggerExpr()})?.focus()`);
    const focusedBeforeSettle = await cdp.evaluate(`document.activeElement === (${g923CodeTriggerExpr()})`);
    if (!focusedBeforeSettle) {
      failures.push('Could not place keyboard focus on the G923Code member row trigger inside Stage 1 while it was still running.');
    } else {
      findings.push('Keyboard focus placed on the G923Code member row trigger, inside Stage 1\'s content, while Stage 1 was still genuinely running.');
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '01-stage1-running-focus-inside.png'));

    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && !t.textContent.includes('Running'); })()`,
      { timeoutMs: 30_000, label: 'All ten Stages and the plain tool row settled' }
    );
    await cdp.screenshot(path.join(SHOTS_DIR, '02-all-stages-settled.png'));

    const stage1TriggerAfter = await cdp.evaluate(`(${stageTriggerSelector(STAGE1_TITLE)})?.getAttribute('aria-expanded') ?? null`);
    if (stage1TriggerAfter !== 'true') {
      failures.push(`Stage 1 auto-closed once settled all-success (aria-expanded is now ${JSON.stringify(stage1TriggerAfter)}) -- issue #991 item 4 regression: it must stay open (sync upward only).`);
    } else {
      findings.push('Stage 1 stayed open after settling all-success (sync upward only, issue #991 item 4 fix confirmed).');
    }
    const activeAfterSettle = await cdp.evaluate(`(() => {
      const active = document.activeElement;
      const expected = (${g923CodeTriggerExpr()});
      return { isExpected: active === expected, isBody: active === document.body, tag: active?.tagName ?? null };
    })()`);
    if (activeAfterSettle.isBody) {
      failures.push('Keyboard focus fell to <body> once Stage 1 settled -- issue #991 item 1 (WCAG 2.4.3) regression.');
    } else if (!activeAfterSettle.isExpected) {
      failures.push(`Keyboard focus moved away from the G923Code member trigger once Stage 1 settled (now a ${activeAfterSettle.tag ?? 'null'} element), expected it to stay put.`);
    } else {
      findings.push('Keyboard focus stayed on the G923Code member row trigger after Stage 1 settled all-success -- never dropped to <body> (issue #991 item 1, WCAG 2.4.3, fix confirmed).');
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '03-stage1-open-focus-preserved-after-settle.png'));

    // ---- Phase 2: titleSelector's scoping fix, proven directly against the chain row's own
    // live duplicate (issue #991 item 3) ----
    const scoping = await cdp.evaluate(`(() => {
      const matches = Array.from(document.querySelectorAll(${JSON.stringify(`[title="${STAGE1_TITLE}"]`)}));
      const withAncestor = matches.filter((el) => !!el.closest('[data-slot="message-scroller-item"]'));
      const withoutAncestor = matches.filter((el) => !el.closest('[data-slot="message-scroller-item"]'));
      return { total: matches.length, withAncestor: withAncestor.length, withoutAncestor: withoutAncestor.length };
    })()`);
    if (scoping.total !== 2) {
      notExercised.push(`Expected exactly 2 elements carrying Stage 1's own title attribute (the real Stage row plus the open chain row's duplicate "ChainStageLine" span) -- found ${scoping.total}; the selector-scoping proof could not run as designed.`);
    } else if (scoping.withAncestor !== 1 || scoping.withoutAncestor !== 1) {
      failures.push(`Expected exactly one of Stage 1's two duplicate-titled elements to have a "message-scroller-item" ancestor (the real Stage row) and exactly one to lack it (the chain row's own duplicate) -- got withAncestor=${scoping.withAncestor}, withoutAncestor=${scoping.withoutAncestor}.`);
    } else {
      findings.push('Confirmed Stage 1\'s own title text genuinely exists twice in the live DOM while the Subagent chain row is open (the real Stage row, and the chain row\'s own duplicate "ChainStageLine" span) -- exactly one copy has a "message-scroller-item" ancestor.');
    }
    const titleSelectorPicksRealRow = await cdp.evaluate(`(() => {
      const picked = (${titleSelector(STAGE1_TITLE)});
      return !!picked && !!picked.closest('[data-slot="message-scroller-item"]');
    })()`);
    if (!titleSelectorPicksRealRow) {
      failures.push('verify-941-stage-naming-helpers.mjs\'s titleSelector did not resolve to the real, per-position Stage row (the one with a "message-scroller-item" ancestor) -- issue #991 item 3 regression.');
    } else {
      findings.push('verify-941-stage-naming-helpers.mjs\'s titleSelector resolves to the real per-position Stage row, scoped by its "message-scroller-item" ancestor -- not merely the first DOM match (issue #991 item 3 fix confirmed).');
    }

    // ---- Phase 3: a manual toggle on a Stage row and on the chain row both survive a real
    // session switch away and back (issue #991 item 2) ----
    await clickScrolled(cdp, CHAIN_TRIGGER);
    const chainExpandedBeforeSwitch = await cdp.evaluate(`(${CHAIN_TRIGGER})?.getAttribute('aria-expanded') ?? null`);
    if (chainExpandedBeforeSwitch !== 'false') {
      failures.push(`Clicking the Subagent chain row's own trigger did not collapse it (aria-expanded is ${JSON.stringify(chainExpandedBeforeSwitch)}, expected "false") -- the toggle-persistence check could not be set up.`);
    } else {
      findings.push('Manually collapsed the Subagent chain row (it defaults open here: Stage 5\'s own FailAgent failure keeps it permanently unsettled).');
    }
    await expandByFinder(cdp, stageTriggerSelector(STAGE6_SOLO_TITLE));
    const stage6ExpandedBeforeSwitch = await cdp.evaluate(`(${stageTriggerSelector(STAGE6_SOLO_TITLE)})?.getAttribute('aria-expanded') ?? null`);
    if (stage6ExpandedBeforeSwitch !== 'true') {
      failures.push(`Manually expanding the solo Stage 6 row did not set aria-expanded="true" (got ${JSON.stringify(stage6ExpandedBeforeSwitch)}) -- the toggle-persistence check could not be set up.`);
    } else {
      findings.push('Manually expanded the solo Stage 6 row (it never auto-expands on its own: a one-agent Stage\'s own isOpenByDefault is always false).');
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '04-manual-toggles-before-switch.png'));

    await createSessionViaQuickCreate(cdp, repoName);
    findings.push(`Switched away to a second Session (created in the same scratch repo), unmounting "${sessionA.name}"'s own Transcript rows.`);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const sessionAOpenButton = sessionOpenButtonFinder(sessionA.name);
    await cdp.click(sessionAOpenButton);
    await cdp.waitFor(`(${sessionAOpenButton})?.getAttribute('aria-current') === 'true'`, { timeoutMs: 15_000, label: `Switched back to "${sessionA.name}"` });
    await cdp.waitFor(`!!${titleSelector(STAGE1_TITLE)}`, { timeoutMs: 15_000, label: 'Stage 1 row remounted after switching back' });
    findings.push(`Switched back to "${sessionA.name}"; its Transcript rows remounted.`);

    const chainExpandedAfterSwitch = await cdp.evaluate(`(${CHAIN_TRIGGER})?.getAttribute('aria-expanded') ?? null`);
    if (chainExpandedAfterSwitch !== 'false') {
      failures.push(`The Subagent chain row's own manual collapse was forgotten across the session-switch remount (aria-expanded is now ${JSON.stringify(chainExpandedAfterSwitch)}, expected it to stay "false") -- issue #991 item 2 regression.`);
    } else {
      findings.push('The Subagent chain row\'s own manual collapse survived the session-switch remount (stayed "false", not reverted to its own always-unsettled "true" default) -- issue #991 item 2 fix confirmed.');
    }
    const stage6ExpandedAfterSwitch = await cdp.evaluate(`(${stageTriggerSelector(STAGE6_SOLO_TITLE)})?.getAttribute('aria-expanded') ?? null`);
    if (stage6ExpandedAfterSwitch !== 'true') {
      failures.push(`Stage 6's own manual expand was forgotten across the session-switch remount (aria-expanded is now ${JSON.stringify(stage6ExpandedAfterSwitch)}, expected it to stay "true") -- issue #991 item 2 regression.`);
    } else {
      findings.push('Stage 6\'s own manual expand survived the session-switch remount (stayed "true", not reverted to its own always-false solo-Stage default) -- issue #991 item 2 fix confirmed.');
    }
    const stage1ExpandedAfterSwitch = await cdp.evaluate(`(${stageTriggerSelector(STAGE1_TITLE)})?.getAttribute('aria-expanded') ?? null`);
    if (stage1ExpandedAfterSwitch !== 'true') {
      failures.push(`Stage 1 was no longer open after the session-switch remount (aria-expanded is ${JSON.stringify(stage1ExpandedAfterSwitch)}) -- the item 4 "stays open once settled" guarantee must also survive a remount.`);
    } else {
      findings.push('Stage 1 (opened automatically, never manually touched) is still open after the session-switch remount too.');
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '05-manual-toggles-survived-switch.png'));

    for (const theme of THEMES) {
      await switchTheme(cdp, theme.id, theme.name);
      const shotName = `991-stage-focus-${theme.id}.png`;
      await cdp.screenshot(path.join(SHOTS_DIR, shotName));
      findings.push(`Screenshot captured under the ${theme.name} theme (${shotName}) -- no colour-dependent assertion in this check, every proof above is structural (aria-expanded, document.activeElement, DOM ancestry).`);
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
    console.log('\n=== verify-991: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-991: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-991: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-991: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
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
    console.error('verify-991: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    try {
      if (exeDir && existsSync(path.join(exeDir, 'app.log'))) copyFileSync(path.join(exeDir, 'app.log'), path.join(SHOTS_DIR, 'app.log'));
      if (exeDir && existsSync(path.join(exeDir, 'fake-omp-invocations.log'))) copyFileSync(path.join(exeDir, 'fake-omp-invocations.log'), path.join(SHOTS_DIR, 'fake-omp-invocations.log'));
    } catch (err) {
      console.warn('verify-991: could not preserve logs:', err.message);
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
  console.error('verify-991: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
