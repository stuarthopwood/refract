#!/usr/bin/env node
// Live CDP check for issue #941 part 2 (Subagent panel Stage grouping + green state, and the
// per-turn "Up next" Todo-phase list) -- FR-079's own deferred note from part 1 (PR #979/#979):
// "the Subagent panel's own green state and Stage grouping, and the Up next list's own UI, are
// not yet built here -- only the Rust/TS wire data (context, todoPhases) is in place,
// unconsumed." This proves both now are.
//
// Reuses PART 1's own recorded-frame fake `omp` harness and fixture
// (`scripts/fixtures/omp-frames/stages-941.jsonl`, `REFRACT_FAKE_OMP_SCENARIO=stages-941`) --
// the SAME ten-Stage turn, extended (additively, never touching anything part 1's own
// assertions read) with a `todoPhases` field on the ONE `get_state` response the tape already
// scripts, so the Session attaches with two real pending Todo phases from the very start
// (`readout.rs`'s own `on_sync_from_state` reads `todoPhases` off THAT SAME response every
// other field it already reads comes from, and schedules a readout update -- no second
// `get_state` round trip needed). PATH-prepends the SAME fake-`omp` PATH shim part 1's own
// `launchBuiltExeWithEnv` call does (`buildOmpShim`/`pathPrepend: shimDir`) -- this NEVER spawns
// or waits on a real `omp` process.
//
// Scope boundary (documented, not an oversight): `SubagentSummary` (the panel's own data,
// `src/shared/model.ts`) carries no `context` field and `nameOrTask` is the agent's own NAME
// whenever one was given (every task in this fixture has one) -- the fixture's own real
// `agent://` references all live in each Stage's `context` argument, which the panel never sees,
// so no Stage's own panel header has anything to resolve a "Uses:" line from. This positively
// proves the GROUPING/GREEN-STATE half of FR-079's deferred note; the panel's own "Uses:"
// rendering path is exercised only as a NEGATIVE (no stray/wrong text), its positive case
// recorded honestly in `report.json`'s own `notExercised`.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, resolveCssVarColor } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget, switchTheme } from './verify-tauri-scratch-helpers.mjs';
import { measuredContrastRatio } from './contrast-math.mjs';
import {
  buildOmpShim,
  launchBuiltExeWithEnv,
  clickScrolled,
  clickByLabelScrolled,
  clickByTextScrolled,
  titleSelector,
  STAGE1_TITLE,
  STAGE2_TITLE,
  STAGE3_TITLE,
  STAGE4_TITLE,
  STAGE5_TITLE,
  STAGE6_SOLO_TITLE,
  STAGE7_TITLE,
  STAGE8_PREFIX_TITLE,
  STAGE9_SOLO_NOCTX_TITLE,
  STAGE10_BORDERLINE_TITLE,
  PLAIN_TOOL_TITLE
} from './verify-941-stage-naming-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROMPT_MESSAGE =
  'Run the #923 quality gate, then the #559/#560 fixes, then read the README, then the zeta/omega probes, the label check, the Story559 polish and fail probe, the final solo check, the long-context investigation, the shared-prefix probes, the solo bare-label check, and the borderline-length context check.';

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' }
];

// The panel's own Stage header label (no `context` tier, see file header): `computeStageLabel`'s
// "shared name prefix" fallback over the SAME fixture `task()` names part 1's own
// STAGE*_TITLE constants name, hand-verified against `stageMeta.ts`'s own `sharedNamePrefix`.
const PANEL_STAGE1_TITLE = 'Stage 1 \u00b7 G923'; // G923Code / G923Arch
const PANEL_STAGE2_TITLE = 'Stage 2 \u00b7 Story5'; // Story559 / Story560
const PANEL_STAGE3_TITLE = 'Stage 3'; // Zeta / Omega -- no shared prefix
const PANEL_STAGE4_TITLE = 'Stage 4 \u00b7 Label'; // LabelA / LabelB
const PANEL_STAGE5_TITLE = 'Stage 5'; // Story559 / FailAgent -- no shared prefix
const PANEL_STAGE7_TITLE = 'Stage 7 \u00b7 LongCtx'; // LongCtxA / LongCtxB
const PANEL_STAGE8_TITLE = 'Stage 8 \u00b7 Pfx'; // PfxOne / PfxTwo
const PANEL_STAGE10_TITLE = 'Stage 10 \u00b7 Borderline'; // BorderlineA / BorderlineB

/** Issue #941 part 2: a multi-member call gets its own Stage header treeitem (`aria-level="1"`,
 * found by its own `title=` span exactly like a chat-pane Stage row), plus real member rows
 * nested one level deeper; a solo call (Stage 6/9) stays a single flat row. */
async function assertPanelGrouping(cdp, findings, failures, themeName) {
  const multi = [
    ['Stage 1', PANEL_STAGE1_TITLE, ['G923Code', 'G923Arch']],
    ['Stage 2', PANEL_STAGE2_TITLE, ['Story559', 'Story560']],
    ['Stage 3 (no shared prefix)', PANEL_STAGE3_TITLE, ['Zeta', 'Omega']],
    ['Stage 4', PANEL_STAGE4_TITLE, ['LabelA', 'LabelB']],
    ['Stage 5 (mixed finished/failed)', PANEL_STAGE5_TITLE, ['Story559', 'FailAgent']],
    ['Stage 7', PANEL_STAGE7_TITLE, ['LongCtxA', 'LongCtxB']],
    ['Stage 8', PANEL_STAGE8_TITLE, ['PfxOne', 'PfxTwo']],
    ['Stage 10', PANEL_STAGE10_TITLE, ['BorderlineA', 'BorderlineB']]
  ];
  for (const [label, headerTitle, members] of multi) {
    const header = await cdp.evaluate(`(() => { const el = ${titleSelector(headerTitle)}; return el ? el.closest('[role="treeitem"]')?.getAttribute('aria-level') : null; })()`);
    if (header !== '1') {
      failures.push(`[${themeName}] ${label}'s own panel header (title="${headerTitle}") was not found as an aria-level="1" treeitem (got: ${JSON.stringify(header)}).`);
    } else {
      findings.push(`[${themeName}] ${label}'s own panel header renders as an aria-level="1" treeitem, titled exactly "${headerTitle}".`);
    }
    for (const memberName of members) {
      const level = await cdp.evaluate(`(() => { const el = ${titleSelector(memberName)}; return el ? el.closest('[role="treeitem"]')?.getAttribute('aria-level') : null; })()`);
      if (level !== '2') {
        failures.push(`[${themeName}] ${label}'s own member "${memberName}" was not found nested at aria-level="2" (got: ${JSON.stringify(level)}).`);
      } else {
        findings.push(`[${themeName}] ${label}'s own member "${memberName}" is nested at aria-level="2", under its Stage header.`);
      }
    }
  }
  for (const [label, soloName] of [
    ['Stage 6 (solo)', 'R8Solo'],
    ['Stage 9 (solo)', 'SoloBare']
  ]) {
    const level = await cdp.evaluate(`(() => { const el = ${titleSelector(soloName)}; return el ? el.closest('[role="treeitem"]')?.getAttribute('aria-level') : null; })()`);
    if (level !== '1') {
      failures.push(`[${themeName}] ${label}'s own single row ("${soloName}") was not found at aria-level="1" (got: ${JSON.stringify(level)}) -- a solo call must stay a flat row, never wrapped in its own Stage header.`);
    } else {
      findings.push(`[${themeName}] ${label}'s own single row ("${soloName}") stays a flat aria-level="1" row, never wrapped in a redundant Stage header.`);
    }
  }
}

/** Issue #941 (FR-079): green applies uniformly in the panel too -- every finished Stage header
 * AND member row; Stage 5 (one failed member) stays NOT green at BOTH its header and its own
 * failed member's row. */
async function assertPanelGreen(cdp, findings, failures, themeName) {
  const expectedColor = await resolveCssVarColor(cdp, '--severity-success', 'color');
  const measure = (titleText) =>
    cdp.evaluate(`(() => {
      const el = ${titleSelector(titleText)};
      if (!el) return null;
      const bg = (() => { let node = el; while (node) { const bgc = getComputedStyle(node).backgroundColor; if (bgc && bgc !== 'rgba(0, 0, 0, 0)' && bgc !== 'transparent') return bgc; node = node.parentElement; } return getComputedStyle(document.body).backgroundColor; })();
      return { color: getComputedStyle(el).color, bg };
    })()`);
  const greenRows = [
    ['Stage 1 header', PANEL_STAGE1_TITLE],
    ['G923Code member', 'G923Code'],
    ['G923Arch member', 'G923Arch'],
    ['Stage 6 (solo)', 'R8Solo'],
    ['Stage 9 (solo)', 'SoloBare']
  ];
  for (const [label, titleText] of greenRows) {
    const styles = await measure(titleText);
    if (!styles) {
      failures.push(`[${themeName}] Could not measure ${label}'s own computed colour (row not found, title="${titleText}").`);
      continue;
    }
    if (styles.color !== expectedColor) {
      failures.push(`[${themeName}] ${label}'s own panel row colour is ${styles.color}, expected the theme's --severity-success (${expectedColor}).`);
      continue;
    }
    const ratio = measuredContrastRatio(styles.color, styles.bg);
    if (ratio === null || ratio < 4.5) {
      failures.push(`[${themeName}] ${label}'s own panel row measures ${ratio === null ? 'an unparseable' : ratio.toFixed(2)}:1 against its own backdrop, below 4.5:1.`);
    } else {
      findings.push(`[${themeName}] ${label}'s own panel row resolves to --severity-success (${expectedColor}), measuring ${ratio.toFixed(2)}:1, clears 4.5:1.`);
    }
  }
  for (const [label, titleText] of [
    ['Stage 5 header (one failed member)', PANEL_STAGE5_TITLE],
    ["Stage 5's own FailAgent member", 'FailAgent']
  ]) {
    const styles = await measure(titleText);
    if (!styles) {
      failures.push(`[${themeName}] Could not measure ${label}'s own computed colour.`);
    } else if (styles.color === expectedColor) {
      failures.push(`[${themeName}] REGRESSION: ${label} is green (${styles.color}) in the panel -- a Stage/member with any failure must never be green.`);
    } else {
      findings.push(`[${themeName}] ${label} stays NOT green in the panel, as issue #941 requires.`);
    }
  }
}

/** Negative check (see file header's documented scope boundary): no panel Stage header shows a
 * stray/malformed "Uses:" line -- `SubagentSummary` carries no `context`, so a positive "Uses:"
 * case is not reachable from this fixture without a riskier, unrelated fixture edit. */
async function assertPanelNoStrayUsesLine(cdp, findings, failures, themeName) {
  const text = await cdp.evaluate(`document.querySelector('[role="tree"][aria-label="Subagents"]')?.textContent ?? ''`);
  if (text.includes('Uses:')) {
    failures.push(`[${themeName}] The panel's own tree unexpectedly contains a "Uses:" line (none of this fixture's own task names carry an agent:// reference -- SubagentSummary has no context field for one to come from): ${JSON.stringify(text.slice(text.indexOf('Uses:') - 20, text.indexOf('Uses:') + 60))}`);
  } else {
    findings.push(`[${themeName}] The panel's own tree shows no stray "Uses:" text, consistent with SubagentSummary carrying no context for this fixture's own dependency references to resolve against.`);
  }
}

/** Issue #941 (FR-079's "Up next"): the agent's own pending Todo phases, below the last Stage,
 * in the CHAT pane (not the panel) -- `stages-941.jsonl`'s own `get_state` response now carries
 * two, both still pending. */
async function assertUpNextList(cdp, findings, failures, themeName) {
  const text = await cdp.evaluate(`document.querySelector('[aria-label="Transcript"]')?.textContent ?? ''`);
  if (!text.includes('Up next')) {
    failures.push(`[${themeName}] The transcript does not show an "Up next" heading despite the fixture's own get_state carrying two pending Todo phases.`);
    return;
  }
  findings.push(`[${themeName}] The transcript shows the "Up next" heading below the last Stage.`);
  for (const [name, count] of [
    ['Ship #941 part 2 follow-ups', 2],
    ['Write the verify-941-part2 live-check', 1]
  ]) {
    if (!text.includes(`${name} \u00b7 ${count} tasks`)) {
      failures.push(`[${themeName}] "Up next" does not show the exact "${name} \u00b7 ${count} tasks" entry (got transcript text containing: ${JSON.stringify(text.slice(text.indexOf('Up next'), text.indexOf('Up next') + 200))}).`);
    } else {
      findings.push(`[${themeName}] "Up next" shows the exact "${name} \u00b7 ${count} tasks" entry.`);
    }
  }
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
  let SHOTS_DIR = path.join(tmpdir(), 'refract-941-part2-shots', new Date().toISOString().replace(/[:.]/g, '-'));
  let BUILD_OUTPUT_DIR = null;
  try {
    SHOTS_DIR = process.env.REFRACT_941_PART2_SHOTS_DIR || SHOTS_DIR;
    mkdirSync(SHOTS_DIR, { recursive: true });
    BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

    shimDir = mkdtempSync(path.join(tmpdir(), 'refract-941p2-shim-'));
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-941p2-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-941p2-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-941p2-repo-')), 'verify-941-part2');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-941p2-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-941p2-launcher-'));
    const port = await getFreePort();

    console.log(`verify-941-part2: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`verify-941-part2: shots dir ${SHOTS_DIR}`);
    console.log(`verify-941-part2: CDP port ${port}`);

    buildOmpShim(shimDir);
    const launcherExe = buildLauncher(launcherDir);
    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-941-part2' });
    const exePath = built.dest;
    exeHash = built.hash;
    console.log(`verify-941-part2: built exe copied to ${exePath}`);

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
      throw new Error(`verify-941-part2: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
    );
    findings.push('Readiness screen green (fake omp, stages-941 scenario).');

    await clickScrolled(cdp, `document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await clickScrolled(cdp, `document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await clickByTextScrolled(cdp, 'Add repository', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Scratch repository added' }
    );
    await clickByLabelScrolled(cdp, 'New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open, Create session enabled' }
    );
    await clickByTextScrolled(cdp, 'Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 60_000,
      label: 'Session opened, composer enabled'
    });
    findings.push('Session created, agent attached (fake omp, stages-941.jsonl scenario, todoPhases extension).');

    await cdp.typeIntoByLabel('Message', PROMPT_MESSAGE);
    await clickByLabelScrolled(cdp, 'Send message');

    for (const titleText of [
      STAGE1_TITLE,
      STAGE2_TITLE,
      STAGE3_TITLE,
      STAGE4_TITLE,
      STAGE5_TITLE,
      STAGE6_SOLO_TITLE,
      STAGE7_TITLE,
      STAGE8_PREFIX_TITLE,
      STAGE9_SOLO_NOCTX_TITLE,
      STAGE10_BORDERLINE_TITLE,
      PLAIN_TOOL_TITLE
    ]) {
      await cdp.waitFor(`!!${titleSelector(titleText)}`, { timeoutMs: 30_000, label: `"${titleText}" row rendered` });
    }
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && !t.textContent.includes('Running'); })()`,
      { timeoutMs: 30_000, label: 'All ten Stages and the plain tool row settled' }
    );
    findings.push('All ten Stages settled (part 1 scaffold, reused unchanged).');

    await clickByLabelScrolled(cdp, 'Show subagents panel');
    await cdp.waitFor(`!!document.querySelector('[role="tree"][aria-label="Subagents"]')`, { timeoutMs: 15_000, label: 'Subagents panel opened' });
    findings.push('Subagents panel opened from the chain row\u2019s own "Show subagents panel" button.');

    for (const [themeIndex, theme] of THEMES.entries()) {
      await switchTheme(cdp, theme.id, theme.name);
      await assertPanelGrouping(cdp, findings, failures, theme.name);
      await assertPanelGreen(cdp, findings, failures, theme.name);
      await assertPanelNoStrayUsesLine(cdp, findings, failures, theme.name);
      await assertUpNextList(cdp, findings, failures, theme.name);

      const shotName = `part2-${theme.id}.png`;
      await cdp.screenshot(path.join(SHOTS_DIR, shotName));
      findings.push(`Screenshot captured: Panel grouping/green + Up next under the ${theme.name} theme (${shotName}).`);
    }

    notExercised.push(
      'The panel\u2019s own positive "Uses:" rendering (a Stage header actually naming a resolved dependency) is not reachable from this fixture: SubagentSummary carries no context field, and every task() call here names its own agent (nameOrTask is always the short name, never task text) -- extending the fixture to cover this would need a NEW, unnamed task whose own task text carries an agent:// reference, judged not worth the risk of perturbing part 1\u2019s own already-passing assertions for a part-2-only code path that is otherwise provably correct (same algorithm as groupSubagentStages.ts\u2019s own applyDependencies, reused verbatim against the panel\u2019s own field names).'
    );

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
    console.log('\n=== verify-941-part2: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-941-part2: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-941-part2: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-941-part2: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
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
    console.error('verify-941-part2: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    try {
      if (exeDir && existsSync(path.join(exeDir, 'app.log'))) copyFileSync(path.join(exeDir, 'app.log'), path.join(SHOTS_DIR, 'app.log'));
      if (exeDir && existsSync(path.join(exeDir, 'fake-omp-invocations.log'))) copyFileSync(path.join(exeDir, 'fake-omp-invocations.log'), path.join(SHOTS_DIR, 'fake-omp-invocations.log'));
    } catch (err) {
      console.warn('verify-941-part2: could not preserve logs:', err.message);
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
  console.error('verify-941-part2: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
