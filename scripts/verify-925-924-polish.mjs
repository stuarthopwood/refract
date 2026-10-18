#!/usr/bin/env node
// Live CDP check for issue #925 (diff-stat colouring: `+N` green, `-N` red, a zero count stays
// muted, wherever a change count shows), issue #924 (the Reasoning gauge needle moves with the
// level), and issue #919 (the Pull requests Changes tab's per-file diff header gains its own
// `+/-` counts, folded into #925's own scope and closed alongside it).
//
// Drives the real Tauri debug build, isolated per the `refract-tauri-live-check-isolation` skill
// (own `REFRACT_DATA_DIR`/`WEBVIEW2_USER_DATA_FOLDER`/`REFRACT_IMPORT_SOURCE_DIR`, never Stuart's
// real `%APPDATA%/refract-tauri`). Two real-data sources, never fixtures or mocks:
//   - A scratch local git repo (`verify-925-924-helpers.mjs`'s `makeScratchRepoWithTrackedFile`)
//     with one tracked, multi-line file: the composer status line's Changes chip and the Session
//     details card's own diff line both start at a real, genuine "0 files changed +0 -0" (muted
//     case, free on first launch, no turn needed) and, once that file is edited on disk and a
//     local "New conversation" click fires the SAME `schedule_readout_update` hook a real turn
//     would (`session/readout.rs`), settle to a real, non-zero `+3 -1` (the green/red case) --
//     no prompt ever sent, no model tokens spent, no `set_thinking_level`-adjacent turn needed.
//   - A shallow, read-only clone of `stuarthopwood/refract` itself (`verify-tauri-568.mjs`'s own
//     established pattern), giving the Pull requests view and its Changes tab real GitHub PR
//     data -- the first row in the (default "Open") list, whichever one that is this run.
//
// Checks made, per theme (Dark, Obsidian, Dark high contrast) unless noted:
//   (1) #925: the composer status line's Changes chip -- `+N`/`-N` spans' own class
//       (`text-diff-added`/`text-diff-removed` when positive, `text-muted-foreground` at zero)
//       and computed `color`, contrast-measured against the real rendered backdrop behind them.
//   (2) #925: the Session details card's identical diff line -- same assertions, a SEPARATE
//       surface (`HoverCardContent`, `bg-popover`), re-fetched fresh on each hover-open.
//   (3) #925/#919: the Pull requests Changes tab's own aggregate line, AND its first file's own
//       per-file diff header (`DiffViewFromPatch`, newly added by this change) -- same
//       assertions, against the Changes tab's own real backdrop and the per-file header's own
//       `bg-muted`, whichever of the two per-file render paths (a real diff, or the
//       too-large-to-show fallback) this run's first PR's first file happens to take.
//   (4) #924: the Reasoning picker's gauge needle, at all 8 selectable levels (Default plus the
//       7 named levels) -- the needle's own rendered angle (read off its `<path>` geometry,
//       `verify-925-924-helpers.mjs`'s `readGaugeNeedleAngle`) compared against the SAME 7-step
//       formula the component itself computes (`needleAngleDeg`), derived from whatever level
//       the real RPC round trip actually settles on, never a hardcoded per-level literal. Then
//       the Session details card's own identical icon, confirmed to match the picker's. Geometry
//       is theme-independent (decorative, no colour), so this runs once, not per theme.
//
// Usage: CARGO_TARGET_DIR=<shared target dir> CARGO_INCREMENTAL=0 node
// scripts/verify-925-924-polish.mjs (requires a prior `pnpm tauri build --debug --no-bundle`).

import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, isTargetOwningPort, sleep } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  buildAndCopyExeFresh,
  launchBuiltExe,
  safeRmSync,
  assertExeUnchanged,
  switchTheme,
  requireSharedCargoTarget
} from './verify-tauri-scratch-helpers.mjs';
import { addRepository, createSessionViaQuickCreate } from './verify-tauri-session-list-helpers.mjs';
import {
  makeScratchRepoWithTrackedFile,
  editTrackedFileForDiff,
  needleAngleDeg,
  readGaugeNeedleAngle,
  readDiffStatSpans,
  selectReasoningLevel
} from './verify-925-924-helpers.mjs';
import { measuredContrastRatio } from './contrast-math.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_925_924_SHOTS_DIR || path.join(tmpdir(), 'refract-925-924-polish-shots', new Date().toISOString().replace(/[:.]/g, '-'));
const GITHUB_SCRATCH_CLONE_URL = 'https://github.com/stuarthopwood/refract.git';

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' }
];

// Issue #924: every selectable level, in the Reasoning picker's own menu order (Default first).
const LEVEL_LABELS = ['Default', 'Off', 'Minimal', 'Low', 'Medium', 'High', 'Extra high', 'Max'];

const REASONING_PICKER_FINDER =
  `Array.from(document.querySelectorAll('button')).find((el) => { const l = el.getAttribute('aria-label') || ''; return l.includes(', reasoning') || /^reasoning\\b/i.test(l); })`;
const CHANGES_CHIP_CONTAINER = `Array.from(document.querySelectorAll('[data-slot="readout-chip"]')).find((el) => /changed/.test(el.textContent))`;
const DETAILS_CARD_FINDER = `document.querySelector('[data-slot="hover-card-content"]')`;
const DETAILS_CARD_DIFF_CONTAINER = `Array.from(${DETAILS_CARD_FINDER}?.querySelectorAll('div') ?? []).find((el) => el.className.includes('text-muted-foreground') && /changed|Counting changes|Not available/.test(el.textContent))`;
const DETAILS_CARD_GAUGE_SVG = `${DETAILS_CARD_FINDER}?.querySelector('svg[data-slot="reasoning-gauge"]')`;
const PICKER_GAUGE_SVG = `(${REASONING_PICKER_FINDER})?.querySelector('svg[data-slot="reasoning-gauge"]')`;

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

function makeGithubScratchClone(dir) {
  mkdirSync(path.dirname(dir), { recursive: true });
  const result = spawnSync_('git', ['clone', '--depth', '1', '--quiet', GITHUB_SCRATCH_CLONE_URL, dir], { timeout: 60_000 });
  if (result.status !== 0) {
    console.warn(`verify-925-924: could not clone ${GITHUB_SCRATCH_CLONE_URL} (${result.stderr || result.error})`);
    return null;
  }
  return dir;
}

// Ties the exe under test to the actual commit: `diff-added`/`diff-removed` (globals.css's new
// #925 tokens, consumed via the `text-diff-added`/`text-diff-removed` Tailwind utilities,
// literally present in `sessionDisplay.tsx`'s `DiffStatCounts`) and `reasoning-gauge`
// (`ReasoningGaugeIcon.tsx`'s own `data-slot` -- a genuine static string literal, unlike the
// needle path itself, which is built from a template literal at RUNTIME and so never appears as
// a literal string in the bundled source; the arc path string is lucide's own `gauge` icon data
// verbatim, matched there too whenever `GaugeIcon` ships, so it cannot distinguish this story).
function assertBundleContainsStory925924Markers() {
  const bundleRoot = path.join(REPO_ROOT, 'out', 'tauri-web');
  if (!existsSync(bundleRoot)) {
    throw new Error(`verify-925-924: no built renderer bundle at ${bundleRoot} -- run \`pnpm tauri build --debug --no-bundle\` first.`);
  }
  function* walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(full);
      else if (entry.name.endsWith('.js')) yield full;
    }
  }
  let foundDiffTokens = false;
  let foundGaugeSlot = false;
  for (const file of walk(bundleRoot)) {
    const text = readFileSync(file, 'utf8');
    if (!foundDiffTokens && text.includes('text-diff-added') && text.includes('text-diff-removed')) foundDiffTokens = true;
    if (!foundGaugeSlot && text.includes('reasoning-gauge')) foundGaugeSlot = true;
    if (foundDiffTokens && foundGaugeSlot) break;
  }
  if (!foundDiffTokens) throw new Error('verify-925-924: #925-only marker ("text-diff-added"/"text-diff-removed") not found in the built renderer bundle.');
  if (!foundGaugeSlot) throw new Error('verify-925-924: #924-only marker ("reasoning-gauge", the icon\'s own data-slot) not found in the built renderer bundle.');
}

async function connectCdp(port, targetPid) {
  const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
  const cdp = await CdpSession.connect(wsUrl);
  if (!isTargetOwningPort(port, targetPid)) {
    throw new Error(`verify-925-924: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid}) -- refusing to drive it`);
  }
  return cdp;
}

// Issue #924: `needleAngleDeg` (`verify-925-924-helpers.mjs`) can return up to 390deg (the
// formula's own `ARC_START_DEG + sweep`, never normalised to 0-360 in the component source
// either -- CSS/SVG trig is periodic, so the component never needed to), while the REAL needle
// angle read off the rendered `<path>` via `atan2` always lands in (-180, 180]. A naive
// `Math.abs(a - b)` wrongly fails every genuinely-correct case where the two sides differ by a
// full 360deg turn (e.g. 270deg vs -90deg, the SAME angle) -- this compares the shortest signed
// angular distance between the two instead, which is 0 for any such pair.
function angleDiffDeg(a, b) {
  let diff = (a - b) % 360;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return diff;
}

/** Issue #925: asserts one `DiffStatCounts` pair's own class/colour rule against the real
 * numbers parsed out of its own text -- never trusting the app to have applied the rule
 * correctly, deriving the expectation independently from `+N`/`-N` text each time. */
function assertDiffStatSpans(label, spans, findings, failures) {
  if (!spans) {
    failures.push(`${label}: DiffStatCounts spans not found.`);
    return;
  }
  const addedN = parseInt(spans.added.text.replace(/[^\d-]/g, ''), 10);
  const removedN = parseInt(spans.removed.text.replace(/[^\d-]/g, ''), 10);
  for (const [name, entry, n, expectedClass] of [
    ['added', spans.added, addedN, 'text-diff-added'],
    ['removed', spans.removed, removedN, 'text-diff-removed']
  ]) {
    const expectMuted = n === 0;
    const hasExpectedClass = entry.className.includes(expectedClass);
    const hasMutedClass = entry.className.includes('text-muted-foreground');
    if (expectMuted) {
      if (hasMutedClass && !hasExpectedClass) findings.push(`${label}: ${name} "${entry.text}" is zero, stays text-muted-foreground, as #925 decides.`);
      else failures.push(`${label}: ${name} "${entry.text}" is zero but class is "${entry.className}" -- expected text-muted-foreground, never ${expectedClass}.`);
    } else {
      if (hasExpectedClass && !hasMutedClass) findings.push(`${label}: ${name} "${entry.text}" is positive, takes ${expectedClass}, as #925 decides.`);
      else failures.push(`${label}: ${name} "${entry.text}" is positive but class is "${entry.className}" -- expected ${expectedClass}.`);
    }
    const ratio = measuredContrastRatio(entry.color, spans.background);
    if (ratio === null) failures.push(`${label}: could not parse ${name} colour (${entry.color}) or backdrop (${spans.background}) for a measured contrast ratio.`);
    else if (ratio < 4.5) failures.push(`${label}: ${name} measures ${ratio.toFixed(2)}:1 against its own rendered backdrop (${entry.color} on ${spans.background}), below the 4.5:1 WCAG AA text floor.`);
    else findings.push(`${label}: ${name} measures ${ratio.toFixed(2)}:1 against its own rendered backdrop (${entry.color} on ${spans.background}), clears 4.5:1.`);
  }
}

async function main() {
  let dataDir, importSourceDir, repoDir, githubCloneParent, githubClone, exeDir, launcherDir;
  let child;
  let cdp;
  const findings = [];
  const failures = [];
  const notExercised = [];
  let exeHash = null;
  let gitHeadSha = null;
  let dirty = 'unknown';
  try {
    mkdirSync(SHOTS_DIR, { recursive: true });
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-925-924-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-925-924-import-'));
    repoDir = makeScratchRepoWithTrackedFile(mkdtempSync(path.join(tmpdir(), 'refract-925-924-repo-')), 'verify-925-924-polish');
    githubCloneParent = mkdtempSync(path.join(tmpdir(), 'refract-925-924-ghrepo-'));
    githubClone = makeGithubScratchClone(path.join(githubCloneParent, 'refract'));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-925-924-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-925-924-launcher-'));

    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync_('git', ['-C', REPO_ROOT, 'status', '--porcelain']);
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

    console.log(`verify-925-924: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`verify-925-924: shots dir ${SHOTS_DIR}`);
    console.log(`verify-925-924: GitHub scratch clone ${githubClone ?? '(FAILED -- see below)'}`);
    if (!githubClone) failures.push('GitHub scratch clone of stuarthopwood/refract failed (offline, or ambient gh/git credentials unreachable) -- cannot prove the Changes tab/#919 per-file header against real PR data without it.');

    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-925-924' });
    assertBundleContainsStory925924Markers();
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    const port = await getFreePort();
    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app.log') });
    child = launched.child;
    cdp = await connectCdp(port, launched.targetPid);
    assertExeUnchanged(exePath, exeHash, 'post-launch', 'verify-925-924');

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green (real omp --version + get_state round trip)' }
    );
    findings.push('Readiness green against the REAL ambient omp install, scratch data dir.');

    // ---- Project 1: the GitHub clone, added FIRST so it is `repositories[0]` --
    // `PullRequestsView.tsx:16`'s own default-scope rule (`viewRepositoryId ?? repositories[0]?.id`)
    // means whichever Project is added first is what the Pull Requests view shows with no repo
    // explicitly selected; a local-only Project with no GitHub remote added first would leave
    // that view scoped to a repository `pullRequests.list` can never resolve PRs for (confirmed
    // root cause of a real run's own "list never settles" failure -- added the local scratch
    // repo first there, by mistake, a script bug, not a product one). ----
    if (githubClone) await addRepository(cdp, githubClone);

    // ---- Project 2: the local scratch repo, for the composer chip / details card / gauge ----
    await addRepository(cdp, repoDir);
    const repoName = path.basename(repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    findings.push('Session created in the local scratch repo; REAL omp process attached (ambient signed-in profile, scratch cwd/worktree). No prompt sent anywhere in this run -- every #925/#924 check is a static DOM/computed-style read, or a local, token-free IPC action (New conversation, set_thinking_level).');

    const SESSION_OPEN_FINDER = `document.querySelector('[data-session-open]')`;

    // ---- (1)/(2) zero case, Dark only (findings, not a per-theme requirement -- a fresh
    // worktree's own "0 files changed +0 -0" is identical in every theme, only the token NAMES
    // differ, already proven identical by `check-theme-contrast.mjs`'s own token-name pairs). ----
    await cdp.waitFor(`!!(${CHANGES_CHIP_CONTAINER})`, { timeoutMs: 25_000, label: 'Changes chip rendered (zero case)' });
    const zeroChip = await readDiffStatSpans(cdp, CHANGES_CHIP_CONTAINER);
    assertDiffStatSpans('Composer status line Changes chip (zero, before edit)', zeroChip, findings, failures);

    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 }); // settle any stray hover first
    const rowRect = await cdp.waitFor(
      `(() => { const el = ${SESSION_OPEN_FINDER}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      { timeoutMs: 10_000, label: 'session row found' }
    );
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowRect.x, y: rowRect.y });
    await cdp.waitFor(`!!(${DETAILS_CARD_FINDER})`, { timeoutMs: 5_000, label: 'details card open (zero case)' });
    await cdp.waitFor(
      `(() => { const el = ${DETAILS_CARD_DIFF_CONTAINER}; return !!el && /changed/.test(el.textContent); })()`,
      { timeoutMs: 15_000, label: 'details card diff line settled (zero case)' }
    );
    const worktreePath = await cdp.evaluate(`${DETAILS_CARD_FINDER}?.querySelector('p')?.textContent.trim() ?? null`);
    if (!worktreePath) throw new Error('verify-925-924: could not read the Session details card\'s own worktree path text.');
    const zeroCard = await readDiffStatSpans(cdp, DETAILS_CARD_DIFF_CONTAINER);
    assertDiffStatSpans('Session details card diff line (zero, before edit)', zeroCard, findings, failures);
    await cdp.screenshot(path.join(SHOTS_DIR, 'dark-00-details-card-zero.png'));

    // ---- edit the tracked file inside the REAL worktree, then a real, local, token-free
    // "New conversation" click fires the same schedule_readout_update a real turn would. ----
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    editTrackedFileForDiff(worktreePath);
    findings.push(`Edited the tracked file inside the real worktree (${worktreePath}): a real addition and deletion against HEAD.`);
    await cdp.clickByText('New conversation');
    await cdp.waitFor(
      `(() => { const el = ${CHANGES_CHIP_CONTAINER}; return !!el && /changed/.test(el.textContent) && !/0 files changed \\+0 -0/.test(el.textContent); })()`,
      { timeoutMs: 20_000, label: 'Changes chip settles to the real non-zero diffStat' }
    );
    findings.push('Changes chip settled to a non-zero diffStat after a local "New conversation" click (no prompt sent, no model tokens spent).');

    // ---- (1)/(2) positive case: per theme ----
    for (const theme of THEMES) {
      await switchTheme(cdp, theme.id, theme.name);
      await sleep(200);
      const chip = await readDiffStatSpans(cdp, CHANGES_CHIP_CONTAINER);
      assertDiffStatSpans(`${theme.name}: composer status line Changes chip (non-zero)`, chip, findings, failures);
      await cdp.screenshot(path.join(SHOTS_DIR, `${theme.id}-01-changes-chip.png`));

      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
      const freshRowRect = await cdp.waitFor(
        `(() => { const el = ${SESSION_OPEN_FINDER}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
        { timeoutMs: 10_000, label: `${theme.name}: session row found` }
      );
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: freshRowRect.x, y: freshRowRect.y });
      await cdp.waitFor(
        `(() => { const el = ${DETAILS_CARD_DIFF_CONTAINER}; return !!el && /changed/.test(el.textContent) && !/0 files changed \\+0 -0/.test(el.textContent); })()`,
        { timeoutMs: 15_000, label: `${theme.name}: details card diff line settled (+3 -1)` }
      );
      const card = await readDiffStatSpans(cdp, DETAILS_CARD_DIFF_CONTAINER);
      assertDiffStatSpans(`${theme.name}: Session details card diff line (non-zero)`, card, findings, failures);
      await cdp.screenshot(path.join(SHOTS_DIR, `${theme.id}-02-details-card.png`));
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    }

    // ---- (4) #924: the Reasoning picker's gauge needle, every selectable level, read once
    // (geometry, decorative, theme-independent -- not re-checked across the loop above). ----
    for (const levelLabel of LEVEL_LABELS) {
      const settledLabel = await selectReasoningLevel(cdp, `(${REASONING_PICKER_FINDER})`, levelLabel);
      // Derive the expected level STRING from the settled label text (the trigger shows the
      // SAME `THINKING_LEVEL_LABEL` map the component itself reads), not from `levelLabel`
      // requested -- an `inherit`/Default request may resolve to any real level, or not confirm.
      const LABEL_TO_LEVEL = { Default: 'inherit', Off: 'off', Minimal: 'minimal', Low: 'low', Medium: 'medium', High: 'high', 'Extra high': 'xhigh', Max: 'max' };
      const settledLevel = settledLabel && Object.prototype.hasOwnProperty.call(LABEL_TO_LEVEL, settledLabel) ? LABEL_TO_LEVEL[settledLabel] : null;
      const expectedAngle = needleAngleDeg(settledLevel === 'inherit' ? null : settledLevel);
      const actualAngle = await readGaugeNeedleAngle(cdp, PICKER_GAUGE_SVG);
      if (actualAngle === null) {
        failures.push(`Requested "${levelLabel}": picker settled to "${settledLabel}", but the gauge needle's own <path> could not be read.`);
      } else if (Math.abs(angleDiffDeg(actualAngle, expectedAngle)) > 0.5) {
        failures.push(`Requested "${levelLabel}": picker settled to "${settledLabel}" -- needle angle is ${actualAngle.toFixed(2)}deg, expected ${expectedAngle.toFixed(2)}deg (the 7-step formula's own angle for this settled level, mod 360).`);
      } else {
        findings.push(`Requested "${levelLabel}": picker settled to "${settledLabel}", needle angle ${actualAngle.toFixed(2)}deg matches the formula's own ${expectedAngle.toFixed(2)}deg (mod 360).`);
      }
    }
    await cdp.screenshot(path.join(SHOTS_DIR, 'dark-03-reasoning-picker-max.png'));

    // Confirms the Session details card's own identical icon reflects the SAME, now-"Max",
    // settled level -- both icons read one Session, never two independent copies of the level.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    const lastRowRect = await cdp.waitFor(
      `(() => { const el = ${SESSION_OPEN_FINDER}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      { timeoutMs: 10_000, label: 'session row found (gauge cross-check)' }
    );
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: lastRowRect.x, y: lastRowRect.y });
    await cdp.waitFor(`!!(${DETAILS_CARD_GAUGE_SVG})`, { timeoutMs: 10_000, label: 'details card gauge icon rendered' });
    const cardAngle = await readGaugeNeedleAngle(cdp, DETAILS_CARD_GAUGE_SVG);
    const maxAngle = needleAngleDeg('max');
    if (cardAngle !== null && Math.abs(angleDiffDeg(cardAngle, maxAngle)) <= 0.5) {
      findings.push(`Session details card's own gauge icon independently reads ${cardAngle.toFixed(2)}deg, matching the picker's "Max" angle (${maxAngle.toFixed(2)}deg mod 360) -- both read the same Session.`);
    } else {
      failures.push(`Session details card's own gauge icon reads ${cardAngle === null ? 'nothing (path not found)' : `${cardAngle.toFixed(2)}deg`}, expected ${maxAngle.toFixed(2)}deg mod 360 ("Max", matching the picker).`);
    }
    await cdp.screenshot(path.join(SHOTS_DIR, 'dark-04-details-card-gauge-max.png'));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });

    // ---- Real GitHub PR data (#925 Changes tab + #919 per-file header). `viewStore.repositoryId`
    // (`view-store.ts`'s `openChat`) was already pinned to the LOCAL scratch repo the moment its
    // Session was created/opened above (research.md decision 7: the Pull Requests repository
    // choice persists across view switches, by design) -- it does NOT reset to `repositories[0]`
    // just because the GitHub clone was added as Project 1. Confirmed live, not guessed: a prior
    // run read the real `[role="alert"]` text "This repository has no GitHub remote." even with
    // the clone added first. So this explicitly selects the clone's own repository via the real
    // `aria-label="Repository"` Select control, the same way a developer would, rather than
    // relying on the view's own default-scope resolution. ----
    if (githubClone) {
      const githubRepoName = path.basename(githubClone);
      await cdp.clickByLabel('Pull requests', { prefix: true });
      await cdp.waitFor(`document.querySelector('h2') && document.querySelector('h2').textContent.trim() === 'Pull requests'`, { timeoutMs: 15_000, label: 'Pull requests view mounted' });
      await cdp.click(`document.querySelector('[aria-label="Repository"]')`);
      await cdp.waitFor(`!!document.querySelector('[role="listbox"], [role="option"]')`, { timeoutMs: 10_000, label: 'Repository select menu open' });
      await cdp.click(
        `Array.from(document.querySelectorAll('[role="option"]')).find((el) => el.textContent.trim() === ${JSON.stringify(githubRepoName)})`
      );
      await cdp.waitFor(
        `document.querySelector('[aria-label="Repository"]')?.getAttribute('title') === ${JSON.stringify(githubRepoName)}`,
        { timeoutMs: 10_000, label: `Repository select shows "${githubRepoName}"` }
      );
      const loaded = await cdp.waitFor(
        `(() => { const err = document.querySelector('[role="alert"]'); const rows = document.querySelectorAll('.divide-y button'); return rows.length > 0 ? 'rows' : (err ? 'error' : null); })()`,
        { timeoutMs: 30_000, label: 'pull request list settles' }
      );
      if (loaded !== 'rows') {
        const diagnostic = await cdp.evaluate(`(() => {
          const err = document.querySelector('[role="alert"]');
          return {
            errorText: err ? err.textContent.trim() : null,
            bodyText: document.body.textContent.replace(/\\s+/g, ' ').trim().slice(0, 500)
          };
        })()`);
        failures.push(
          `Pull request list did not settle to real rows -- ${
            loaded === 'error' ? `error banner read "${diagnostic.errorText}"` : `timed out after 30s, no error banner either; page text: "${diagnostic.bodyText}"`
          } -- cannot prove the Changes tab/#919 per-file header against real PR data.`
        );
        await cdp.screenshot(path.join(SHOTS_DIR, 'dark-06-pr-list-failure.png'));
      } else {
        await cdp.click(`document.querySelector('.divide-y button')`);
        await cdp.waitFor(`!!document.querySelector('h2.line-clamp-2')`, { timeoutMs: 20_000, label: 'PR detail title rendered' });
        await cdp.click(`Array.from(document.querySelectorAll('button')).find((el) => /^Changes \\(\\d+ files?\\)$/.test(el.textContent.trim()))`);
        await cdp.waitFor(
          `!!Array.from(document.querySelectorAll('p')).find((el) => /changed/.test(el.textContent))`,
          { timeoutMs: 15_000, label: 'Changes tab aggregate line rendered' }
        );
        const AGGREGATE_CONTAINER = `Array.from(document.querySelectorAll('p')).find((el) => /changed/.test(el.textContent))`;
        // #919: a per-file diff header, whichever of the two real render paths this run's first
        // PR's first file happens to take -- a real `DiffViewFromPatch` header (`.diff-view`'s
        // own first child, `bg-muted`), or, for a too-large-to-show file, the plain fallback
        // block ChangesTab.tsx already had (also coloured by this same change).
        const PER_FILE_CONTAINER =
          `document.querySelector('.diff-view')?.firstElementChild ?? document.querySelector('.rounded-md.border.border-border')?.lastElementChild`;
        for (const theme of THEMES) {
          await switchTheme(cdp, theme.id, theme.name);
          await sleep(200);
          const aggregate = await readDiffStatSpans(cdp, AGGREGATE_CONTAINER);
          assertDiffStatSpans(`${theme.name}: Pull requests Changes tab aggregate line`, aggregate, findings, failures);
          const perFile = await readDiffStatSpans(cdp, PER_FILE_CONTAINER);
          if (!perFile) {
            notExercised.push(`${theme.name}: per-file diff header (#919) -- neither a .diff-view header nor a too-large fallback block was found for this PR's first file this run.`);
          } else {
            assertDiffStatSpans(`${theme.name}: Pull requests Changes tab per-file diff header (#919)`, perFile, findings, failures);
          }
          await cdp.screenshot(path.join(SHOTS_DIR, `${theme.id}-05-changes-tab.png`));
        }
      }
    } else {
      notExercised.push('Pull requests Changes tab / #919 per-file header: GitHub scratch clone failed this run (see failure above) -- code-verified only.');
    }

    const report = { gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, exitCode: failures.length > 0 ? 1 : 0 };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-925-924: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-925-924: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-925-924: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-925-924: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
    } catch {
      // best-effort only
    }
    console.error('verify-925-924: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    await safeRmSync(repoDir);
    await safeRmSync(githubCloneParent);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
  }
}

main().catch((err) => {
  console.error('verify-925-924: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
