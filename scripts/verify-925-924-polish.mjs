#!/usr/bin/env node
// Live CDP check for #925 (diff-stat colouring: `+N` green, `-N` red, zero muted), #924 (the
// Reasoning gauge needle follows the level) and #919 (the Pull requests Changes tab's per-file
// diff header gains `+/-` counts).
//
// Drives the real Tauri debug build with its own `REFRACT_DATA_DIR`/`WEBVIEW2_USER_DATA_FOLDER`/
// `REFRACT_IMPORT_SOURCE_DIR`, never the real `%APPDATA%/refract-tauri`. Real data only: a scratch
// git repo with one tracked file (0 files `+0 -0`, then `+3 -1` after an on-disk edit and a local
// "New conversation" click that fires `schedule_readout_update`; no model tokens), and a shallow
// clone of `stuarthopwood/refract` for real PR data (best effort: scans the first 5 rows for one
// with both additions and deletions, to reach the red branch).
//
// Per theme (Dark, Obsidian, Dark high contrast): the status-line Changes chip, the Session
// details card diff line, and the Changes tab aggregate line and first file header, each checked
// for class, computed `color` and contrast against the real backdrop. The gauge needle (#924) is
// checked once, since geometry is theme-independent, at all 8 levels against the component's own
// 7-step formula, then the details card icon is read once as a same-Session cross-check.
//
// Usage: CARGO_TARGET_DIR=<shared target dir> CARGO_INCREMENTAL=0 node scripts/verify-925-924-polish.mjs
// (needs a prior `pnpm tauri build --debug --no-bundle`).

import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, isTargetOwningPort, sleep, resolveCssVarColor } from './verify-tauri-cdp.mjs';
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
  selectReasoningLevel,
  assertDiffStatSpans,
  resolveDiffTokenColors
} from './verify-925-924-helpers.mjs';

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

// #924: every selectable level, in the Reasoning picker's menu order (Default first).
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

// Ties the exe to this commit via `diff-added`/`diff-removed` and `reasoning-gauge`. The needle
// path is built from a template literal at runtime, so it never appears as a bundle literal, and
// the arc path is lucide's `gauge` data, which cannot distinguish this story.
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

// `needleAngleDeg` can return up to 390deg (never normalised), while the angle read via `atan2`
// lies in (-180, 180]; `Math.abs(a - b)` would fail equal angles a full turn apart (270 vs -90).
// Compare the shortest signed angular distance instead.
function angleDiffDeg(a, b) {
  let diff = (a - b) % 360;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return diff;
}

/** A 2x-scaled crop of the element `finderExpr` resolves to, as visual evidence of the needle at
 * a level. Returns `false` (nothing written) if the element is not found. */
async function screenshotCrop(cdp, finderExpr, outPath, scale = 2) {
  const rect = await cdp.evaluate(`(() => { const el = ${finderExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  if (!rect || rect.width === 0 || rect.height === 0) return false;
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale } });
  writeFileSync(outPath, Buffer.from(data, 'base64'));
  return true;
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
    // Resolved once: the app launches on Dark, so the zero-case assertions need Dark tokens too.
    let currentTokenColors = await resolveDiffTokenColors(cdp);

    // Project 1: the GitHub clone, added first so it is `repositories[0]`; the Pull Requests view
    // defaults to that, and a local-only Project there would leave `pullRequests.list` unresolvable.
    if (githubClone) await addRepository(cdp, githubClone);

    // Project 2: the local scratch repo, for the composer chip, details card and gauge.
    await addRepository(cdp, repoDir);
    const repoName = path.basename(repoDir);
    await createSessionViaQuickCreate(cdp, repoName);
    findings.push('Session created in the local scratch repo; REAL omp process attached (ambient signed-in profile, scratch cwd/worktree). No prompt sent anywhere in this run -- every #925/#924 check is a static DOM/computed-style read, or a local, token-free IPC action (New conversation, set_thinking_level).');

    const SESSION_OPEN_FINDER = `document.querySelector('[data-session-open]')`;

    // Zero case, Dark only: "0 files changed +0 -0" is identical in every theme.
    await cdp.waitFor(`!!(${CHANGES_CHIP_CONTAINER})`, { timeoutMs: 25_000, label: 'Changes chip rendered (zero case)' });
    const zeroChip = await readDiffStatSpans(cdp, CHANGES_CHIP_CONTAINER);
    assertDiffStatSpans('Composer status line Changes chip (zero, before edit)', zeroChip, findings, failures, { tokenColors: currentTokenColors });

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
    assertDiffStatSpans('Session details card diff line (zero, before edit)', zeroCard, findings, failures, { tokenColors: currentTokenColors });
    await cdp.screenshot(path.join(SHOTS_DIR, 'dark-00-details-card-zero.png'));

    // Edit the tracked file in the real worktree, then a local "New conversation" click fires
    // `schedule_readout_update`. Wait for the button to be enabled first: while the Session is
    // attaching it is `aria-disabled` with `pointer-events-none`, so a coordinate click is
    // silently swallowed (no error, just a 20s timeout on the chip below).
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    editTrackedFileForDiff(worktreePath);
    findings.push(`Edited the tracked file inside the real worktree (${worktreePath}): a real addition and deletion against HEAD.`);
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'New conversation'); return !!b && b.getAttribute('aria-disabled') !== 'true'; })()`,
      { timeoutMs: 20_000, label: 'New conversation button enabled (Session finished attaching)' }
    );
    await cdp.clickByText('New conversation');
    await cdp.waitFor(
      `(() => { const el = ${CHANGES_CHIP_CONTAINER}; return !!el && /\\+3 -1/.test(el.textContent); })()`,
      { timeoutMs: 20_000, label: 'Changes chip settles to the real +3 -1 diffStat' }
    );
    findings.push('Changes chip settled to a non-zero diffStat after a local "New conversation" click (no prompt sent, no model tokens spent).');

    // Positive case, per theme.
    for (const theme of THEMES) {
      await switchTheme(cdp, theme.id, theme.name);
      await sleep(200);
      currentTokenColors = await resolveDiffTokenColors(cdp);
      const chip = await readDiffStatSpans(cdp, CHANGES_CHIP_CONTAINER);
      assertDiffStatSpans(`${theme.name}: composer status line Changes chip (non-zero)`, chip, findings, failures, { requireBothPositive: true, tokenColors: currentTokenColors });
      // Logged to report.json so the claim that the Changes chip is never on
      // `--composer-background` (even in Dark high contrast) stays auditable.
      if (theme.id === 'dark-high-contrast') {
        const resolvedBackground = await resolveCssVarColor(cdp, '--background', 'background-color');
        const resolvedComposerBackground = await resolveCssVarColor(cdp, '--composer-background', 'background-color');
        if (chip && chip.background === resolvedBackground) {
          findings.push(`Dark (high contrast): Changes chip's own measured backdrop (${chip.background}) matches --background's own resolved value, confirming it is painted on --background, NOT --composer-background (${resolvedComposerBackground}) -- the status line sits outside the composer's own fill in every theme.`);
        } else {
          failures.push(`Dark (high contrast): Changes chip's own measured backdrop (${chip?.background}) does NOT match --background's own resolved value (${resolvedBackground}) -- the "never painted on --composer-background" claim (globals.css, theme-contrast-pairs.mjs) needs re-checking.`);
        }
      }
      await cdp.screenshot(path.join(SHOTS_DIR, `${theme.id}-01-changes-chip.png`));

      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
      const freshRowRect = await cdp.waitFor(
        `(() => { const el = ${SESSION_OPEN_FINDER}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
        { timeoutMs: 10_000, label: `${theme.name}: session row found` }
      );
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: freshRowRect.x, y: freshRowRect.y });
      await cdp.waitFor(
        `(() => { const el = ${DETAILS_CARD_DIFF_CONTAINER}; return !!el && /\\+3 -1/.test(el.textContent); })()`,
        { timeoutMs: 15_000, label: `${theme.name}: details card diff line settled (+3 -1)` }
      );
      const card = await readDiffStatSpans(cdp, DETAILS_CARD_DIFF_CONTAINER);
      assertDiffStatSpans(`${theme.name}: Session details card diff line (non-zero)`, card, findings, failures, { requireBothPositive: true, tokenColors: currentTokenColors });
      await cdp.screenshot(path.join(SHOTS_DIR, `${theme.id}-02-details-card.png`));
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    }

    // (4) #924: gauge needle at every level, read once (decorative, theme-independent). Switch to
    // Dark first: the loop above leaves the last theme (Dark high contrast) active.
    await switchTheme(cdp, 'dark', 'Dark');
    await sleep(200);
    // If no requested level ever settled to itself, the picker drive itself may be broken, which
    // must hard-fail rather than vanish into individual `notExercised` entries.
    let anyLevelConfirmedAsRequested = false;
    for (const levelLabel of LEVEL_LABELS) {
      const settledLabel = await selectReasoningLevel(cdp, `(${REASONING_PICKER_FINDER})`, levelLabel);
      // Derive the expected level from the settled label text (the same `THINKING_LEVEL_LABEL`
      // map the component reads), not the requested one: `inherit`/Default may resolve to any level.
      const LABEL_TO_LEVEL = { Default: 'inherit', Off: 'off', Minimal: 'minimal', Low: 'low', Medium: 'medium', High: 'high', 'Extra high': 'xhigh', Max: 'max' };
      const settledLevel = settledLabel && Object.prototype.hasOwnProperty.call(LABEL_TO_LEVEL, settledLabel) ? LABEL_TO_LEVEL[settledLabel] : null;
      const expectedAngle = needleAngleDeg(settledLevel === 'inherit' ? null : settledLevel);
      const actualAngle = await readGaugeNeedleAngle(cdp, PICKER_GAUGE_SVG);
      const angleOk = actualAngle !== null && Math.abs(angleDiffDeg(actualAngle, expectedAngle)) <= 0.5;
      // A 2x crop of the needle per named level ("Default" is skipped: it requests `inherit`).
      // Named after the settled level, not the requested one, and `screenshotCrop`'s return is
      // checked so a missing or zero-sized element cannot pass silently.
      if (levelLabel !== 'Default') {
        const cropName = (settledLabel ?? levelLabel).toLowerCase().replace(/\s+/g, '-');
        const cropped = await screenshotCrop(cdp, PICKER_GAUGE_SVG, path.join(SHOTS_DIR, `dark-gauge-2x-${cropName}.png`));
        if (!cropped) failures.push(`Requested "${levelLabel}" (settled "${settledLabel}"): could not capture a needle crop screenshot (element not found or zero-sized).`);
      }
      // When OMP settles on a different level (requesting "Minimal" settled on "Low"), the
      // requested level's needle is never confirmed, so it is recorded as `notExercised`; the
      // settled level's angle is still validated and a wrong or unreadable one is a hard failure.
      if (settledLevel === null) {
        failures.push(`Requested "${levelLabel}": OMP settled on an unrecognised label "${settledLabel}" (not one of the 8 known trigger labels) -- cannot derive an expected angle for it.`);
      } else if (actualAngle === null) {
        failures.push(`Requested "${levelLabel}": picker settled to "${settledLabel}", but the gauge needle's own <path> could not be read.`);
      } else if (!angleOk) {
        failures.push(`Requested "${levelLabel}": picker settled to "${settledLabel}" -- needle angle is ${actualAngle.toFixed(2)}deg, expected ${expectedAngle.toFixed(2)}deg (the 7-step formula's own angle for this settled level, mod 360).`);
      } else if (settledLabel !== levelLabel) {
        notExercised.push(`Requested "${levelLabel}" (Refs #924): OMP settled on "${settledLabel}" instead -- the "${levelLabel}" needle position is not genuinely confirmed this run (the settled "${settledLabel}" needle itself reads correctly: ${actualAngle.toFixed(2)}deg, matching the formula's own ${expectedAngle.toFixed(2)}deg).`);
      } else {
        findings.push(`Requested "${levelLabel}": picker settled to "${settledLabel}", needle angle ${actualAngle.toFixed(2)}deg matches the formula's own ${expectedAngle.toFixed(2)}deg (mod 360).`);
        anyLevelConfirmedAsRequested = true;
      }
    }
    if (!anyLevelConfirmedAsRequested) {
      failures.push('Reasoning picker: no requested level EVER settled to itself exactly across all 8 requests this run -- every single one mismatched or failed outright; the picker drive mechanism itself may be broken, not only OMP\'s own level resolution.');
    }
    await cdp.screenshot(path.join(SHOTS_DIR, 'dark-03-reasoning-picker-max.png'));

    // Confirms the details card's icon matches the settled "Max" level (one Session, one level).
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

    // Real GitHub PR data. `viewStore.repositoryId` stays pinned to the local scratch repo from
    // its Session (it does not reset to `repositories[0]`; a prior run read "no GitHub remote"),
    // so select the clone's repository through the real `aria-label="Repository"` Select.
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
        const AGGREGATE_CONTAINER = `Array.from(document.querySelectorAll('p')).find((el) => /changed/.test(el.textContent))`;
        // Scan the first 5 rows for one with both additions and deletions to exercise the red
        // branch; not guaranteed, so fall back to row 0 and record that red was not reached.
        const rowCount = await cdp.evaluate(`document.querySelectorAll('.divide-y button').length`);
        const scanLimit = Math.min(rowCount, 5);
        for (let i = 0; i < scanLimit; i++) {
          // `h2.line-clamp-2` alone can match stale content: `PullRequestDetail` has no
          // `key={number}`, so it is reconciled in place across a row switch. Read the row's `#N`
          // before clicking and wait for the heading to contain it; `detail` is one atomic state
          // object, so every other field then comes from the same fetch. Match `N` only when not
          // followed by a digit (`#9` must not match `#91`); `[0-9]` avoids `\d` double-escaping.
          const rowText = await cdp.evaluate(`document.querySelectorAll('.divide-y button')[${i}]?.textContent ?? ''`);
          const prNumberMatch = rowText.match(/#(\d+)/);
          const prNumber = prNumberMatch ? prNumberMatch[1] : null;
          await cdp.click(`document.querySelectorAll('.divide-y button')[${i}]`);
          await cdp.waitFor(
            `(() => { const h = document.querySelector('h2.line-clamp-2'); const n = ${JSON.stringify(prNumber)}; return !!h && n !== null && new RegExp('#' + n + '(?![0-9])').test(h.textContent); })()`,
            { timeoutMs: 20_000, label: `PR row ${i} detail title rendered for #${prNumber}` }
          );
          await cdp.click(`Array.from(document.querySelectorAll('button')).find((el) => /^Changes \\(\\d+ files?\\)$/.test(el.textContent.trim()))`);
          await cdp.waitFor(`!!(${AGGREGATE_CONTAINER})`, { timeoutMs: 15_000, label: `PR row ${i} Changes tab aggregate rendered` });
          const probe = await readDiffStatSpans(cdp, AGGREGATE_CONTAINER);
          // The removed span's text is literally "-N" (a glyph, not a sign); strip only non-digits
          // so `probeRemoved` is N's magnitude (keeping the `-` parsed every count as negative).
          const probeAdded = probe ? parseInt(probe.added.text.replace(/\D/g, ''), 10) : 0;
          const probeRemoved = probe ? parseInt(probe.removed.text.replace(/\D/g, ''), 10) : 0;
          if (probeAdded > 0 && probeRemoved > 0) {
            findings.push(`Pull requests: row ${i} (of ${scanLimit} scanned) has both additions and deletions (+${probeAdded} -${probeRemoved}) -- chosen to genuinely exercise the red branch on real PR data.`);
            break;
          }
          if (i === scanLimit - 1) {
            notExercised.push(`Pull requests red-branch exercise: scanned the first ${scanLimit} rows, none had both additions>0 and deletions>0 this run (row ${i} itself: +${probeAdded} -${probeRemoved}) -- proceeding with it anyway; the red branch is not genuinely exercised on the Changes tab/per-file header this run.`);
          }
        }
        // #919: a per-file diff header on either render path: `.diff-view`'s first child
        // (`bg-muted`), or the too-large fallback's `data-slot="diff-fallback-header"`. A stable
        // `data-slot` replaces `.rounded-md.border.border-border`, which also matches the "Only N
        // of M files shown" banner, and `.lastElementChild` there is the body, not the header.
        const PER_FILE_CONTAINER = `document.querySelector('.diff-view')?.firstElementChild ?? document.querySelector('[data-slot="diff-fallback-header"]')`;
        for (const theme of THEMES) {
          await switchTheme(cdp, theme.id, theme.name);
          await sleep(200);
          currentTokenColors = await resolveDiffTokenColors(cdp);
          const aggregate = await readDiffStatSpans(cdp, AGGREGATE_CONTAINER);
          assertDiffStatSpans(`${theme.name}: Pull requests Changes tab aggregate line`, aggregate, findings, failures, { tokenColors: currentTokenColors });
          const perFile = await readDiffStatSpans(cdp, PER_FILE_CONTAINER);
          if (!perFile) {
            notExercised.push(`${theme.name}: per-file diff header (#919) -- neither a .diff-view header nor a too-large fallback block was found for this PR's first file this run.`);
          } else {
            assertDiffStatSpans(`${theme.name}: Pull requests Changes tab per-file diff header (#919)`, perFile, findings, failures, { tokenColors: currentTokenColors });
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
