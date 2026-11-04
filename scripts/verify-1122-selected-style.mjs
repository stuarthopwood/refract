#!/usr/bin/env node
// Live CDP check: one selected-item style (square corners, flush 2px left bar, accent fill) and Explorer name/icon tone,
// across Dark, Obsidian and Dark (high contrast); other themes are covered by `check-theme-contrast.mjs`.
// Forced-colours: CDP cannot emulate `forced-colors` in WebView2, so Tailwind's compiled
// `@media (forced-colors: active)` rule is read from the built CSS on disk (CSSOM scans 0 rules).
//
// Usage: CARGO_TARGET_DIR=<shared target dir> CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 node scripts/verify-1122-selected-style.mjs

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
import {
  readSelectedSite,
  readExplorerRowTone,
  tokenColor,
  forcedColorsRuleCompiledFor,
  movePointerOffAndSettle,
  checkCollapsedGroupHeader,
  ACTIVE_INDICATOR_BAR_CLASS
} from './verify-1122-selected-style-helpers.mjs';
import { hasVisibleShadow } from './contrast-math.mjs';

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
        `${t.id}-08-pull-request-row-attempt.png`,
        `${t.id}-09-group-header-collapsed.png`
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

  // Seeds 2 files: `makeScratchRepo`'s commit is --allow-empty, so the Explorer would have no row to select.
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
    // Without emulated focus, a window lacking OS foreground never satisfies `:focus-visible`.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green (fake omp)' }
    );
    await cdp.openLocalFolderDialog();
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
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

        // Real per-theme token colours, so sites assert against resolved values, not just class names.
        const barBg = await tokenColor(cdp, '--active-indicator', 'background-color');
        const accentBg = await tokenColor(cdp, '--accent', 'background-color');
        const sidebarAccentBg = await tokenColor(cdp, '--sidebar-accent', 'background-color');

        // Session row: `data-choice-item` is on the outer <li>, the accent fill on its inner <div>.
        const sessionRow = await readSelectedSite(
          cdp,
          `document.querySelector('nav[aria-label="Sessions"] li[data-choice-item]')`,
          `document.querySelector('nav[aria-label="Sessions"] li[data-choice-item] div[class*="min-h-11"]')`
        );
        assertSite(failures, findings, theme.name, 'Session row', sessionRow, { barBg, fillBg: sidebarAccentBg, fillTokenName: '--sidebar-accent' });
        await settleForScreenshot(cdp);
        pushShot(shotNames, `${theme.id}-01-session-row-selected.png`);
        await cdp.screenshot(path.join(SHOTS_DIR, shotNames[shotNames.length - 1]));

        // Collapsed group header: bar only, no fill (#735 decision 22).
        const groupHeader = await checkCollapsedGroupHeader(cdp, theme.name, {
          barBg,
          screenshot: async () => {
            await settleForScreenshot(cdp);
            pushShot(shotNames, `${theme.id}-09-group-header-collapsed.png`);
            await cdp.screenshot(path.join(SHOTS_DIR, shotNames[shotNames.length - 1]));
          }
        });
        assertSite(failures, findings, theme.name, 'Collapsed group header', groupHeader, { barBg });
        if (groupHeader && groupHeader.fillBackgroundColor !== 'rgba(0, 0, 0, 0)') {
          failures.push(`${theme.name}: Collapsed group header -- expected no selected fill (bar only, #735 decision 22), measured ${groupHeader.fillBackgroundColor}.`);
        }

        // "Pull requests" nav entry.
        await cdp.clickByLabel('Pull requests');
        await cdp.waitFor(`document.querySelector('[aria-label="Pull requests"]')?.getAttribute('aria-current') === 'page'`, {
          timeoutMs: 10_000,
          label: `${theme.name}: Pull requests nav selected`
        });
        // The resting pointer's `hover:bg-sidebar-accent` paints the selected-fill token: move it
        // off, then wait out the `transition-all` (a mid-transition read measured ~70% alpha).
        await movePointerOffAndSettle(cdp, `document.querySelector('[aria-label="Pull requests"]')`, `${theme.name}: Pull requests nav`);
        const prNav = await readSelectedSite(cdp, `document.querySelector('[aria-label="Pull requests"]')`);
        assertSite(failures, findings, theme.name, 'Pull requests nav entry', prNav, { barBg, fillBg: sidebarAccentBg, fillTokenName: '--sidebar-accent' });
        await settleForScreenshot(cdp);
        pushShot(shotNames, `${theme.id}-02-pull-requests-nav-selected.png`);
        await cdp.screenshot(path.join(SHOTS_DIR, shotNames[shotNames.length - 1]));

        // Real GitHub PR list row: attempted, degrades gracefully.
        const prRowsAppeared = await cdp
          .waitFor(`document.querySelectorAll('[data-pr-row]').length > 0 || !!document.querySelector('[role="alert"]')`, {
            timeoutMs: 15_000,
            label: `${theme.name}: pull request list settles`
          })
          .catch(() => false);
        const hasPrRows = prRowsAppeared ? await cdp.evaluate(`document.querySelectorAll('[data-pr-row]').length > 0`) : false;
        if (hasPrRows) {
          await cdp.click(`document.querySelector('[data-pr-row]')`);
          await cdp.waitFor(`!!document.querySelector('[data-pr-row][aria-current="true"]')`, { timeoutMs: 10_000, label: `${theme.name}: PR row selected` });
          await movePointerOffAndSettle(cdp, `document.querySelector('[data-pr-row][aria-current="true"]')`, `${theme.name}: PR row`);
          const prRow = await readSelectedSite(cdp, `document.querySelector('[data-pr-row][aria-current="true"]')`);
          assertSite(failures, findings, theme.name, 'PR list row', prRow, { barBg, fillBg: accentBg, fillTokenName: '--accent' });
        } else if (theme === THEMES[0]) {
          notExercised.push(
            'Every live PR-data check (PullRequestRow.tsx selected square/bar/fill): real GitHub PR data was not reachable this run (no GitHub account in this scratch profile) -- the same gap verify-tauri-499-930.mjs/verify-tauri-568.mjs already record; code-verified only (the className is identical ActiveIndicatorBar markup to every real-data-verified site above, see the PR diff).'
          );
        }
        await settleForScreenshot(cdp);
        pushShot(shotNames, `${theme.id}-08-pull-request-row-attempt.png`);
        await cdp.screenshot(path.join(SHOTS_DIR, shotNames[shotNames.length - 1]));

        // Return to chat before the rest of this theme's checks.
        await cdp.click(`document.querySelector('[data-repository-id] .session-open-button, li[data-choice-item] .session-open-button')`);
        await cdp.waitFor(`!!document.querySelector('[aria-label="Message"]')`, { timeoutMs: 15_000, label: `${theme.name}: back in chat` });

        await runSettingsChecks(cdp, theme, { failures, findings, notExercised, shotNames, barBg, accentBg });
        await runExplorerChecks(cdp, theme, { failures, findings, shotNames, barBg, accentBg });
        await runSubagentChecks(cdp, theme, { failures, findings, shotNames, barBg, accentBg });
        await runManageSessionsChecks(cdp, theme, { failures, findings, shotNames, barBg, accentBg });

        findings.push(`${theme.name}: screenshots captured for all 7 measured sites plus the PR-row attempt.`);
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

/** Asserts the #1122 facts for a converted site: square row, the exact shared bar className, and
 * a bar flush with the row's top and bottom (`inset-y-0`, not the old `inset-y-1`). */
function assertSite(failures, findings, themeName, label, read, expected = {}) {
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
    // The bar's real colour must equal `--active-indicator`: a className match cannot catch a token typo.
    if (expected.barBg && read.barBackgroundColor !== expected.barBg) {
      failures.push(`${themeName}: ${label} -- bar background measures ${read.barBackgroundColor}, expected --active-indicator (${expected.barBg}).`);
    }
  }
  if (expected.fillBg && read.fillBackgroundColor !== expected.fillBg) {
    failures.push(`${themeName}: ${label} -- selected fill measures ${read.fillBackgroundColor}, expected ${expected.fillTokenName ?? 'its accent token'} (${expected.fillBg}).`);
  }
  if (
    read.rowBorderRadius === '0px' &&
    read.barClassExactMatch &&
    read.barFlushTop &&
    read.barFlushBottom &&
    (!expected.barBg || read.barBackgroundColor === expected.barBg) &&
    (!expected.fillBg || read.fillBackgroundColor === expected.fillBg)
  ) {
    findings.push(`${themeName}: ${label} -- square, flush full-height 2px bar (shared ActiveIndicatorBar, real bar/fill colours confirmed), confirmed.`);
  }
}

async function runSettingsChecks(cdp, theme, { failures, findings, notExercised, shotNames, barBg, accentBg }) {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: `${theme.name}: Settings screen opened` });
  const defaultSection = await readSelectedSite(
    cdp,
    `Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.getAttribute('aria-current') === 'page')`
  );
  assertSite(failures, findings, theme.name, 'Settings nav (default: Session readout)', defaultSection, { barBg, fillBg: accentBg, fillTokenName: '--accent' });
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
  assertSite(failures, findings, theme.name, 'Settings nav (Appearance, after click)', appearanceSection, { barBg, fillBg: accentBg, fillTokenName: '--accent' });

  // Keyboard focus distinct from selection: the screen focuses the new section's heading, so
  // Shift+Tab walks back (bounded) until "Session readout" is focused with Appearance selected.
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
    const appearance = Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Appearance');
    const style = sessionReadout ? getComputedStyle(sessionReadout) : null;
    return {
      focusedIsSessionReadout: active === sessionReadout,
      sessionReadoutSelected: sessionReadout?.getAttribute('aria-current') === 'page',
      appearanceSelected: appearance?.getAttribute('aria-current') === 'page',
      appearanceBarPresent: !!appearance && Array.from(appearance.querySelectorAll('span[aria-hidden]')).some((s) => s.className === ${JSON.stringify(ACTIVE_INDICATOR_BAR_CLASS)}),
      // Issue #1144 whitespace rule aside -- this button's OWN pre-existing focus indicator
      // (unchanged by #1122) is \`focus-visible:border-ring focus-visible:ring-3
      // focus-visible:ring-ring/50\`, a box-shadow ring plus a border-colour change, never an
      // \`outline-*\` utility -- checking \`outline-width\`/\`outline-style\` here would always
      // read "no outline" regardless of whether the real ring painted.
      matchesFocusVisible: !!(sessionReadout && sessionReadout.matches(':focus-visible')),
      sessionReadoutBoxShadow: style ? style.boxShadow : null,
      sessionReadoutBorderColor: style ? style.borderColor : null
    };
  })()`);
  // Tailwind v4 `ring-*` always composes a 5-layer box-shadow, even all-transparent, so a bare
  // `!== 'none'` always passes; `hasVisibleShadow` measures each layer's blur/spread and alpha.
  const realRingVisible = hasVisibleShadow(focusState.sessionReadoutBoxShadow);
  if (!focusState.focusedIsSessionReadout) {
    failures.push(`${theme.name}: the bounded Shift+Tab search never landed on Session readout within 20 presses.`);
  } else if (focusState.sessionReadoutSelected) {
    failures.push(`${theme.name}: Session readout is focused but also reports selected (aria-current=page) -- the keyboard-focus-vs-selection distinction this check exists to prove did not hold.`);
  } else if (!focusState.appearanceSelected || !focusState.appearanceBarPresent) {
    failures.push(`${theme.name}: with focus on Session readout, Appearance no longer shows as selected (aria-current=page: ${focusState.appearanceSelected}, exact shared bar present: ${focusState.appearanceBarPresent}) -- focus and selection were not shown on two different rows.`);
  } else if (!focusState.matchesFocusVisible) {
    failures.push(`${theme.name}: Session readout keyboard focus did not match :focus-visible in this scratch WebView2 window even with Emulation.setFocusEmulationEnabled(true) (box-shadow: ${focusState.sessionReadoutBoxShadow}) -- the focus ring could not be measured.`);
  } else if (!realRingVisible) {
    failures.push(`${theme.name}: Session readout matched :focus-visible but its box-shadow measured no real visible layer (${focusState.sessionReadoutBoxShadow}) once Tailwind's always-present zero-geometry layers are discounted.`);
  } else {
    findings.push(`${theme.name}: keyboard focus (Session readout, real bounded Shift+Tab, :focus-visible matched, a REAL visible ring box-shadow measured) is distinct from selection (Appearance, square+bar+fill) -- two different rows, each its own real state.`);
  }
  // No `settleForScreenshot`: its pointer-move/blur would drop the live keyboard focus.
  shotNames.push(`${theme.id}-04-settings-appearance-selected-focus-on-session-readout.png`);
  await cdp.screenshot(path.join(SHOTS_DIR, shotNames[shotNames.length - 1]));

  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 10_000, label: `${theme.name}: back in chat from Settings` });
}

async function runExplorerChecks(cdp, theme, { failures, findings, shotNames, barBg, accentBg }) {
  await cdp.click(`document.querySelector('[data-rail-button="file-explorer"]')`);
  await cdp.waitFor(`!!document.querySelector('[role="tree"][aria-label="Files"]')`, { timeoutMs: 15_000, label: `${theme.name}: Explorer tree mounted` });
  await cdp.waitFor(`document.querySelectorAll('[data-tree-row-path]').length > 0`, { timeoutMs: 15_000, label: `${theme.name}: Explorer rows rendered` });
  await cdp.click(`document.querySelector('[data-tree-row-path]')`);
  await cdp.waitFor(`!!document.querySelector('[data-tree-row-path][aria-selected="true"]')`, { timeoutMs: 10_000, label: `${theme.name}: Explorer row selected` });
  await movePointerOffAndSettle(cdp, `document.querySelector('[data-tree-row-path][aria-selected="true"]')`, `${theme.name}: Explorer row`);
  const explorerRow = await readSelectedSite(cdp, `document.querySelector('[data-tree-row-path][aria-selected="true"]')`);
  assertSite(failures, findings, theme.name, 'Explorer row', explorerRow, { barBg, fillBg: accentBg, fillTokenName: '--accent' });

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

async function runSubagentChecks(cdp, theme, { failures, findings, shotNames, barBg, accentBg }) {
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
  const selectedSubagent = `document.querySelector('[role="tree"][aria-label="Subagents"] [role="treeitem"][aria-selected="true"]')`;
  await cdp.waitFor(`!!${selectedSubagent}`, { timeoutMs: 10_000, label: `${theme.name}: Subagent row selected` });
  await movePointerOffAndSettle(cdp, selectedSubagent, `${theme.name}: Subagent panel row`);
  const subagentRow = await readSelectedSite(cdp, selectedSubagent);
  assertSite(failures, findings, theme.name, 'Subagent panel row', subagentRow, { barBg, fillBg: accentBg, fillTokenName: '--accent' });
  await settleForScreenshot(cdp);
  shotNames.push(`${theme.id}-06-subagent-row-selected.png`);
  await cdp.screenshot(path.join(SHOTS_DIR, shotNames[shotNames.length - 1]));
}

async function runManageSessionsChecks(cdp, theme, { failures, findings, shotNames, barBg, accentBg }) {
  await cdp.click(`document.querySelector('[data-profile-name-button]')`);
  await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menu"][data-state="open"]')).find((el) => el.textContent.includes('Manage sessions'))`, {
    timeoutMs: 10_000,
    label: `${theme.name}: Profile dropdown menu open`
  });
  await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Manage sessions')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: `${theme.name}: Manage sessions screen opened` });
  // The open session's row, found by its sr-only "Shown in chat" marker (only while `isVisible`).
  const visibleRow = `Array.from(document.querySelectorAll('li .sr-only')).find((s) => s.textContent.trim() === 'Shown in chat')?.closest('li')`;
  await cdp.waitFor(`!!${visibleRow}`, { timeoutMs: 15_000, label: `${theme.name}: the open session's own row is visible-selected` });
  const manageRow = await readSelectedSite(cdp, visibleRow);
  assertSite(failures, findings, theme.name, 'Manage sessions row', manageRow, { barBg, fillBg: accentBg, fillTokenName: '--accent' });
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
