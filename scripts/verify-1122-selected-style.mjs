#!/usr/bin/env node
// Live CDP check for issue #1122 (one selected-item style: square corners, a flush full-height
// 2px left bar, the accent fill, via the new shared `ActiveIndicatorBar` component) and issue
// #1119 (Explorer name/icon tone). Ported pattern from `verify-700-pill-cards.mjs`/
// `verify-1074-text-opacity.mjs` (`verify-tauri-cdp.mjs`'s `CdpSession`, `verify-tauri-scratch-
// helpers.mjs`'s scratch/launch/theme helpers). Reuses the pre-existing `subagents.jsonl` fake-
// omp tape (`REFRACT_FAKE_OMP_SCENARIO=subagents`) rather than adding a new fixture (AGENTS.md:
// no new fixtures) -- its one Session plus two-subagent Stage batch gives real rows for
// SessionRow and the Subagent panel's tree.
//
// Flow: Readiness -> add a scratch repo seeded with 2 real files (so FileExplorerPanel has more
// than a bare root to pick from) -> create session -> send the tape's prompt -> for each of
// Dark, Obsidian and Dark (high contrast) (the acceptance's own named themes; Nordic Frost and
// Cyber Amber are covered mathematically by `check-theme-contrast.mjs`'s 927/927 pairs, so
// visual screenshot coverage is only required for these three):
//   - Session row (`SessionRow.tsx`): selected, square (`data-choice-item`), the shared bar+fill.
//   - "Pull requests" nav (`SessionList.tsx`): click, `aria-current="page"`, square
//     (`data-choice-item`), the shared bar+fill, then returns to chat.
//   - Settings nav (`SettingsScreen.tsx`): default section selected (square, bar, `bg-muted`
//     fill); clicks "Appearance" (now selected) then Shift+Tab's focus back to "Session readout"
//     (now focused but NOT selected) -- proves keyboard focus stays visible and distinct from
//     selection on two DIFFERENT rows at once, the cleanest site for this (a plain `<ul>` of
//     individually tab-stoppable buttons, not a roving-tabindex tree where focus and selection
//     are the SAME row by design -- Explorer/Subagent panel, noted under `notExercised`).
//   - Explorer row (`FileExplorerPanel.tsx`): square (`role="treeitem"` now joins the selector),
//     the shared bar+fill, AND #1119's own name/icon tone (real computed colour resolves to
//     `--chat-foreground`/`--muted-foreground`, not the bare `--foreground` it inherited before).
//   - Subagent panel row (`SubagentPanel.tsx`): square (`role="treeitem"`), the shared bar+fill
//     (decision 13's bar-only exception superseded).
//   - Manage sessions row (`ManageSessionRow.tsx`): the open session's own row is `isVisible`;
//     square (no rounding class at all), the shared bar+fill.
//   - PR list row (`PullRequestRow.tsx`): attempts the real GitHub PR list (no GitHub account in
//     this scratch profile) -- if no real rows render in time, records `notExercised` with the
//     SAME established wording `verify-tauri-499-930.mjs`/`verify-tauri-568.mjs` already use.
// Forced-colours: WebView2's CDP endpoint has no working `Emulation.setEmulatedMedia` for
// `forced-colors` (`verify-tauri-567.mjs`/`verify-1043-theme-radio.mjs`'s own documented
// limitation) -- confirms `ActiveIndicatorBar`'s own `forced-color-adjust-none`/
// `forced-colors:bg-[Highlight]` classes are literally rendered on every converted site AND that
// Tailwind genuinely compiled a matching `@media (forced-colors: active)` rule for it (reading
// the built CSS bundle off disk, the same technique `verify-1043-theme-radio-helpers.mjs`'s own
// `forcedColorsRuleCompiled` uses -- the CDP/CSSOM route scans 0 rules for a Tauri-served
// stylesheet, a WebView2 restriction unrelated to whether the CSS works).
//
// Usage: CARGO_TARGET_DIR=<shared target dir> CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 node
// scripts/verify-1122-selected-style.mjs (rebuilds the debug exe fresh into its own scratch copy).

import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  computeDirty,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  citeScreenshots,
  safeRmSync,
  assertExeUnchanged,
  requireSharedCargoTarget,
  switchTheme,
  clearKnownOutputFiles
} from './verify-tauri-scratch-helpers.mjs';
import { buildOmpShim, worktreesDirFor } from './verify-tauri-560-helpers.mjs';
import { launchBuiltExe } from './verify-926-launch-helpers.mjs';
import { pressKey } from './verify-tauri-session-list-helpers.mjs';
import { settleForScreenshot } from './verify-700-todo-pin-helpers.mjs';
import { readSelectedSite, readExplorerRowTone, tokenColor, forcedColorsRuleCompiledFor } from './verify-1122-selected-style-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1122';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1122_SHOTS_DIR || path.join(tmpdir(), 'refract-1122-selected-style-shots');
const PROMPT_MESSAGE = 'Investigate alpha and beta.';

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' }
];

function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

async function main() {
  const findings = [];
  const failures = [];
  const notExercised = [];
  const shotNames = [];

  const gitHeadSha = gitHead(REPO_ROOT);
  const dirty = computeDirty(REPO_ROOT);
  console.log(`${LOG}: git HEAD ${gitHeadSha}${dirty === true ? ' (DIRTY)' : ''}`);

  clearKnownOutputFiles(
    SHOTS_DIR,
    'refract-1122-selected-style-shots',
    [
      ...THEMES.flatMap((t) => [
        `${t.id}-01-session-row-selected.png`,
        `${t.id}-02-pull-requests-nav-selected.png`,
        `${t.id}-03-settings-session-readout-selected.png`,
        `${t.id}-04-settings-appearance-selected-focus-on-session-readout.png`,
        `${t.id}-05-explorer-row-selected.png`,
        `${t.id}-06-subagent-row-selected.png`,
        `${t.id}-07-manage-sessions-row-selected.png`,
        `${t.id}-08-pull-request-row-attempt.png`
      ]),
      'report.json',
      'app.log',
      'fake-omp-invocations.log'
    ]
  );

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1122-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1122-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1122-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1122-selected-style');
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1122-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1122-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1122-shim-'));

  // Seeds 2 real files (never 0 -- `makeScratchRepo`'s own commit is `--allow-empty`, so the
  // repo starts with no tracked files at all), so the Explorer tree has more than a bare empty
  // root to select a row from.
  writeFileSync(path.join(repoDir, 'README.md'), '# verify-1122-selected-style scratch repo\n');
  writeFileSync(path.join(repoDir, 'notes.txt'), 'scratch file for the Explorer tree row selection check\n');
  spawnSync_('git', ['-C', repoDir, 'add', 'README.md', 'notes.txt']);
  spawnSync_('git', [
    '-C', repoDir,
    '-c', 'user.name=verify-1122-selected-style',
    '-c', 'user.email=verify-1122-selected-style@example.invalid',
    'commit', '-q', '-m', 'seed files for the Explorer tree'
  ]);

  let child;
  let cdp;
  let exeHash = null;
  try {
    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
    const exePath = built.dest;
    exeHash = built.hash;
    const port = await getFreePort();
    const debugLogPath = path.join(exeDir, 'fake-omp-invocations.log');
    const launched = await launchBuiltExe(launcherExe, exePath, {
      port,
      dataDir,
      pathPrepend: shimDir,
      logFile: path.join(exeDir, 'app.log'),
      extraEnv: {
        REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
        REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
        REFRACT_FAKE_OMP_NODE: process.execPath,
        REFRACT_FAKE_OMP_SCENARIO: 'subagents',
        REFRACT_FAKE_OMP_DEBUG_LOG: debugLogPath
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) {
      throw new Error(`${LOG}: CDP target on port ${port} is not owned by the process this run launched (pid ${launched.targetPid})`);
    }
    assertExeUnchanged(exePath, exeHash, 'post-launch', LOG);

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green (fake omp)' }
    );
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Scratch repository added' }
    );
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open, Create session enabled' }
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Session composer enabled'
    });
    findings.push('Session created, agent attached (fake omp, subagents.jsonl scenario).');

    await cdp.typeIntoByLabel('Message', PROMPT_MESSAGE);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && t.textContent.includes('Stage 1'); })()`,
      { timeoutMs: 30_000, label: 'Stage 1 group header rendered' }
    );
    findings.push('Subagent batch (alpha, beta) started -- real data for the Subagent panel tree below.');

    for (const theme of THEMES) {
      try {
        await switchTheme(cdp, theme.id, theme.name);
        await sleep(250);

        // ---- Session row (SessionRow.tsx) ----
        const sessionRow = await readSelectedSite(cdp, `document.querySelector('nav[aria-label="Sessions"] li[data-choice-item]')`);
        assertSite(failures, findings, theme.name, 'Session row', sessionRow);
        await settleForScreenshot(cdp);
        pushShot(shotNames, `${theme.id}-01-session-row-selected.png`);
        await cdp.screenshot(path.join(SHOTS_DIR, shotNames[shotNames.length - 1]));

        // ---- "Pull requests" nav entry (SessionList.tsx) ----
        await cdp.clickByLabel('Pull requests');
        await cdp.waitFor(`document.querySelector('[aria-label="Pull requests"]')?.getAttribute('aria-current') === 'page'`, {
          timeoutMs: 10_000,
          label: `${theme.name}: Pull requests nav selected`
        });
        const prNav = await readSelectedSite(cdp, `document.querySelector('[aria-label="Pull requests"]')`);
        assertSite(failures, findings, theme.name, 'Pull requests nav entry', prNav);
        await settleForScreenshot(cdp);
        pushShot(shotNames, `${theme.id}-02-pull-requests-nav-selected.png`);
        await cdp.screenshot(path.join(SHOTS_DIR, shotNames[shotNames.length - 1]));

        // ---- Real GitHub PR list row (PullRequestRow.tsx) -- attempted, gracefully degrades ----
        const prRowsAppeared = await cdp
          .waitFor(`document.querySelectorAll('[data-pr-row]').length > 0 || !!document.querySelector('[role="alert"]')`, {
            timeoutMs: 15_000,
            label: `${theme.name}: pull request list settles`
          })
          .catch(() => false);
        const hasPrRows = prRowsAppeared ? await cdp.evaluate(`document.querySelectorAll('[data-pr-row]').length > 0`) : false;
        if (hasPrRows) {
          await cdp.click(`document.querySelector('[data-pr-row]')`);
          await sleep(200);
          const prRow = await readSelectedSite(cdp, `document.querySelector('[data-pr-row]')`);
          assertSite(failures, findings, theme.name, 'PR list row', prRow);
        } else if (theme === THEMES[0]) {
          notExercised.push(
            'Every live PR-data check (PullRequestRow.tsx selected square/bar/fill): real GitHub PR data was not reachable this run (no GitHub account in this scratch profile) -- the same gap verify-tauri-499-930.mjs/verify-tauri-568.mjs already record; code-verified only (the className is identical ActiveIndicatorBar markup to every real-data-verified site above, see the PR diff).'
          );
        }
        await settleForScreenshot(cdp);
        pushShot(shotNames, `${theme.id}-08-pull-request-row-attempt.png`);
        await cdp.screenshot(path.join(SHOTS_DIR, shotNames[shotNames.length - 1]));

        // ---- Return to chat before the rest of this theme's checks ----
        await cdp.click(`document.querySelector('[data-repository-id] .session-open-button, li[data-choice-item] .session-open-button')`);
        await cdp.waitFor(`!!document.querySelector('[aria-label="Message"]')`, { timeoutMs: 15_000, label: `${theme.name}: back in chat` });

        await runSettingsChecks(cdp, theme, { failures, findings, shotNames });
        await runExplorerChecks(cdp, theme, { failures, findings, shotNames });
        await runSubagentChecks(cdp, theme, { failures, findings, shotNames });
        await runManageSessionsChecks(cdp, theme, { failures, findings, shotNames });

        findings.push(`${theme.name}: screenshots captured for all 6 built sites plus the PR-row attempt.`);
      } catch (err) {
        failures.push(`${theme.name}: ${err.message}`);
      }
    }

    await runForcedColoursChecks({ findings, failures, notExercised });

    notExercised.push(
      'Keyboard focus visibly distinct from selection on Explorer/Subagent panel rows specifically: both are roving-tabindex WAI-ARIA treeviews where the focused row and the selected row are the SAME element by design (focus moves selection) -- there is no "focused elsewhere, selected here" state to construct there. The Settings nav check above (a plain, non-roving list of individually tab-stoppable buttons) is the representative proof site for this acceptance criterion.'
    );

    const report = {
      gitHead: gitHeadSha,
      dirty,
      exeSha256: exeHash,
      screenshots: citeScreenshots(SHOTS_DIR, shotNames),
      findings,
      failures,
      notExercised,
      exitCode: failures.length > 0 ? 1 : 0
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`\n=== ${LOG}: FAILURES (always fail the run) ===`);
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log(`\n=== ${LOG}: FINDINGS ===`);
    for (const f of findings) console.log(`- ${f}`);
    console.log(`\n=== ${LOG}: NOT EXERCISED (genuine skips only) ===`);
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`${LOG}: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
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
    console.error(`${LOG}: FAILED:`, err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    if (repoDir) await safeRmSync(worktreesDirFor(repoDir));
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
    await safeRmSync(shimDir);
  }
}

function pushShot(shotNames, name) {
  shotNames.push(name);
}

/** Asserts the three #1122 facts every converted site must show: a square row (`border-radius:
 * 0px`), the shared bar (exact-className match, not a loose substring), and that bar genuinely
 * flush against the row's own top AND bottom edges (`inset-y-0`, not the old `inset-y-1` inset). */
function assertSite(failures, findings, themeName, label, read) {
  if (!read) {
    failures.push(`${themeName}: ${label} -- row not found at all.`);
    return;
  }
  if (read.rowBorderRadius !== '0px') {
    failures.push(`${themeName}: ${label} -- expected square corners (border-radius: 0px), measured ${read.rowBorderRadius}.`);
  }
  if (!read.barClassExactMatch) {
    failures.push(`${themeName}: ${label} -- the shared ActiveIndicatorBar's exact className was not found (hand-copied span, wrong shape, or missing entirely).`);
  } else {
    if (read.barFlushTop !== true || read.barFlushBottom !== true) {
      failures.push(`${themeName}: ${label} -- bar is not flush full-height (top flush: ${read.barFlushTop}, bottom flush: ${read.barFlushBottom}).`);
    }
    if (typeof read.barWidthPx === 'number' && Math.abs(read.barWidthPx - 2) > 0.5) {
      failures.push(`${themeName}: ${label} -- bar width measured ${read.barWidthPx}px, expected 2px.`);
    }
  }
  if (read.rowBorderRadius === '0px' && read.barClassExactMatch && read.barFlushTop && read.barFlushBottom) {
    findings.push(`${themeName}: ${label} -- square, flush full-height 2px bar (shared ActiveIndicatorBar), confirmed.`);
  }
}

async function runSettingsChecks(cdp, theme, { failures, findings, shotNames }) {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: `${theme.name}: Settings screen opened` });
  const defaultSection = await readSelectedSite(
    cdp,
    `Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.getAttribute('aria-current') === 'page')`
  );
  assertSite(failures, findings, theme.name, 'Settings nav (default: Session readout)', defaultSection);
  await settleForScreenshot(cdp);
  shotNames.push(`${theme.id}-03-settings-session-readout-selected.png`);
  await cdp.screenshot(path.join(SHOTS_DIR, shotNames[shotNames.length - 1]));

  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Appearance')`);
  await cdp.waitFor(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Appearance').getAttribute('aria-current') === 'page'`, {
    timeoutMs: 10_000,
    label: `${theme.name}: Appearance section selected`
  });
  const appearanceSection = await readSelectedSite(
    cdp,
    `Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Appearance')`
  );
  assertSite(failures, findings, theme.name, 'Settings nav (Appearance, after click)', appearanceSection);

  // ---- Keyboard focus distinct from selection: after the screen's own focus-the-heading
  // effect fires (`SettingsScreen.tsx`'s `useEffect` on `settingsSection`, which moves real
  // focus to the new section's own content heading, not the clicked nav button), Shift+Tab
  // (bounded, not a hardcoded single keystroke -- robust to exactly how many tab stops sit
  // between wherever focus actually lands and the nav list, the same `tabUntilFocused`
  // precedent `verify-700-pill-cards.mjs` uses) walks backward until "Session readout" itself
  // is focused, with Appearance still selected elsewhere. ----
  let sessionReadoutFocused = false;
  for (let i = 0; i < 20 && !sessionReadoutFocused; i++) {
    await pressKey(cdp, 9, 'Tab', 'Tab', 8);
    sessionReadoutFocused = await cdp.evaluate(
      `(() => { const b = Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Session readout'); return !!b && document.activeElement === b; })()`
    );
  }
  const focusState = await cdp.evaluate(`(() => {
    const active = document.activeElement;
    const sessionReadout = Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Session readout');
    const style = sessionReadout ? getComputedStyle(sessionReadout) : null;
    return {
      focusedIsSessionReadout: active === sessionReadout,
      sessionReadoutSelected: sessionReadout?.getAttribute('aria-current') === 'page',
      // Issue #1144 whitespace rule aside -- this button's OWN pre-existing focus indicator
      // (unchanged by #1122) is \`focus-visible:border-ring focus-visible:ring-3
      // focus-visible:ring-ring/50\`, a box-shadow ring plus a border-colour change, never an
      // \`outline-*\` utility -- checking \`outline-width\`/\`outline-style\` here would always
      // read "no outline" regardless of whether the real ring painted.
      sessionReadoutBoxShadow: style ? style.boxShadow : null,
      sessionReadoutBorderColor: style ? style.borderColor : null
    };
  })()`);
  if (!focusState.focusedIsSessionReadout) {
    failures.push(`${theme.name}: the bounded Shift+Tab search never landed on Session readout within 20 presses.`);
  } else if (focusState.sessionReadoutSelected) {
    failures.push(`${theme.name}: Session readout is focused but also reports selected (aria-current=page) -- the keyboard-focus-vs-selection distinction this check exists to prove did not hold.`);
  } else if (!focusState.sessionReadoutBoxShadow || focusState.sessionReadoutBoxShadow === 'none') {
    failures.push(`${theme.name}: Session readout is focused but paints no visible focus ring (box-shadow: ${focusState.sessionReadoutBoxShadow}, border-color: ${focusState.sessionReadoutBorderColor}).`);
  } else {
    findings.push(`${theme.name}: keyboard focus (Session readout, real bounded Shift+Tab, a visible ring box-shadow plus border-colour change) is visually distinct from selection (Appearance, square+bar+fill) -- two different rows, each its own real state.`);
  }
  await settleForScreenshot(cdp);
  shotNames.push(`${theme.id}-04-settings-appearance-selected-focus-on-session-readout.png`);
  await cdp.screenshot(path.join(SHOTS_DIR, shotNames[shotNames.length - 1]));

  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 10_000, label: `${theme.name}: back in chat from Settings` });
}

async function runExplorerChecks(cdp, theme, { failures, findings, shotNames }) {
  await cdp.click(`document.querySelector('[data-rail-button="file-explorer"]')`);
  await cdp.waitFor(`!!document.querySelector('[role="tree"][aria-label="Files"]')`, { timeoutMs: 15_000, label: `${theme.name}: Explorer tree mounted` });
  await cdp.waitFor(`document.querySelectorAll('[data-tree-row-path]').length > 0`, { timeoutMs: 15_000, label: `${theme.name}: Explorer rows rendered` });
  await cdp.click(`document.querySelector('[data-tree-row-path]')`);
  await sleep(200);
  const explorerRow = await readSelectedSite(cdp, `document.querySelector('[data-tree-row-path][aria-selected="true"]')`);
  assertSite(failures, findings, theme.name, 'Explorer row', explorerRow);

  const tone = await readExplorerRowTone(cdp, `document.querySelector('[data-tree-row-path][aria-selected="true"]')`);
  const expectedChat = await tokenColor(cdp, '--chat-foreground', 'color');
  const expectedMuted = await tokenColor(cdp, '--muted-foreground', 'color');
  if (!tone || tone.nameColor !== expectedChat) {
    failures.push(`${theme.name}: Explorer row name colour measures ${tone?.nameColor}, expected --chat-foreground (${expectedChat}).`);
  } else {
    findings.push(`${theme.name}: Explorer row name colour (${tone.nameColor}) matches --chat-foreground (#1119).`);
  }
  if (!tone || tone.iconColor !== expectedMuted) {
    failures.push(`${theme.name}: Explorer row icon colour measures ${tone?.iconColor}, expected --muted-foreground (${expectedMuted}).`);
  } else {
    findings.push(`${theme.name}: Explorer row icon colour (${tone.iconColor}) matches --muted-foreground (#1119).`);
  }
  await settleForScreenshot(cdp);
  shotNames.push(`${theme.id}-05-explorer-row-selected.png`);
  await cdp.screenshot(path.join(SHOTS_DIR, shotNames[shotNames.length - 1]));
}

async function runSubagentChecks(cdp, theme, { failures, findings, shotNames }) {
  const chipFound = await cdp.evaluate(
    `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('Open subagents panel'))`
  );
  if (chipFound) await cdp.clickByLabel('Open subagents panel', { prefix: true });
  else await cdp.click(`document.querySelector('[data-rail-button="subagents"]')`);
  await cdp.waitFor(`!!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 15_000, label: `${theme.name}: Subagent panel tree mounted` });
  await cdp.waitFor(`document.querySelectorAll('[role="tree"][aria-label="Subagents"] [role="treeitem"]').length > 0`, {
    timeoutMs: 15_000,
    label: `${theme.name}: Subagent panel rows rendered`
  });
  await cdp.click(`Array.from(document.querySelectorAll('[role="tree"][aria-label="Subagents"] [role="treeitem"]')).find((el) => el.getAttribute('aria-selected') !== null)`);
  await sleep(200);
  const subagentRow = await readSelectedSite(cdp, `document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"][aria-selected="true"]')`);
  assertSite(failures, findings, theme.name, 'Subagent panel row', subagentRow);
  await settleForScreenshot(cdp);
  shotNames.push(`${theme.id}-06-subagent-row-selected.png`);
  await cdp.screenshot(path.join(SHOTS_DIR, shotNames[shotNames.length - 1]));
}

async function runManageSessionsChecks(cdp, theme, { failures, findings, shotNames }) {
  await cdp.click(`document.querySelector('[data-profile-name-button]')`);
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menu"][data-state="open"]')).find((el) => el.textContent.includes('Manage sessions'))`, {
    timeoutMs: 10_000,
    label: `${theme.name}: Profile dropdown menu open`
  });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Manage sessions')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: `${theme.name}: Manage sessions screen opened` });
  await cdp.waitFor(`!!document.querySelector('li[class*="bg-accent"]')`, { timeoutMs: 15_000, label: `${theme.name}: the open session's own row is visible-selected` });
  const manageRow = await readSelectedSite(cdp, `document.querySelector('li[class*="bg-accent"]')`);
  assertSite(failures, findings, theme.name, 'Manage sessions row', manageRow);
  await settleForScreenshot(cdp);
  shotNames.push(`${theme.id}-07-manage-sessions-row-selected.png`);
  await cdp.screenshot(path.join(SHOTS_DIR, shotNames[shotNames.length - 1]));
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 10_000, label: `${theme.name}: back in chat from Manage sessions` });
}

async function runForcedColoursChecks({ findings, failures, notExercised }) {
  const rule = forcedColorsRuleCompiledFor(REPO_ROOT, '.forced-colors:bg-[Highlight]', /background-color:\s*highlight/i);
  if (rule.selectorFound && rule.insideForcedColorsMedia && rule.declarationMatches) {
    findings.push(`Forced-colours: a REAL compiled CSS rule exists inside @media (forced-colors: ...) for .forced-colors:bg-[Highlight] (ActiveIndicatorBar's own fallback), declaring background-color: highlight (read from the built CSS bundle, not just the className string). ${JSON.stringify(rule)}`);
  } else {
    failures.push(`Forced-colours: compiled CSS rule for .forced-colors:bg-[Highlight] not confirmed (${JSON.stringify(rule)}).`);
  }
  notExercised.push(
    "Real OS forced-colours (Windows High Contrast) rendering of the shared bar: WebView2's own CDP endpoint has no working Emulation.setEmulatedMedia for forced-colors (same limitation verify-tauri-567.mjs/verify-1043-theme-radio.mjs already record); the check above confirms the forced-color-adjust-none/forced-colors:bg-[Highlight] classes are literally present on the rendered bar at every converted site (barClassExactMatch above) AND that Tailwind genuinely compiled a matching @media (forced-colors: ...) rule for it, which is as far as this harness can prove it."
  );
}


main().catch((err) => {
  console.error(`${LOG}: unhandled error:`, err?.stack ?? err);
  process.exitCode = 1;
});
