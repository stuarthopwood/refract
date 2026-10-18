#!/usr/bin/env node
// Live CDP check for issue #937 (the composer status line's Advisor readout/chip, follow-up to
// #917/PR #923). Modelled directly on `verify-917-advisor-command.mjs`'s own scratch-launch/CDP
// pattern (same ambient-signed-in-`omp` posture; only Refract's OWN data, `REFRACT_DATA_DIR`, is
// scratch) and on `verify-927-928-quiet-composer.mjs`'s own geometry/theme-switch conventions.
// The actual per-cycle assertions (busy window, notice confirmation, AX-tree removal, focus,
// live-region announcement) live in `verify-937-advisor-chip-helpers.mjs`, split out to stay
// under the #806 600-line soft cap.
//
// WRITTEN, NOT RUN: no build slot has been granted for this sub-task (CONTEXT.md/PLAN.md/
// tasks.md T272-T274 all record this plainly) -- this script has never executed against a real
// built app. `node --check` is the only command that has been run against it. Every claim this
// script makes, once it does run, is grounded in a real CDP read; see the `notExercised` entry
// below for the one thing it still cannot prove even then (the silent attach/resume probe's own
// transcript suppression, which needs a second scratch run across an app restart).
//
// Sequence: launch a scratch instance, create a Session, then for EACH of a mouse-driven and a
// separate keyboard-driven toggle cycle (never the same run for both -- mouse never exercises
// the keyboard route): `/advisor on` -> assert the chip's AX name "Advisor on. Turn off" ->
// measure its geometry against another status-line chip (24px row, 14px icon) -> activate it ->
// assert the busy window, the chip leaving the AX tree, the authoritative "Advisor disabled."
// reply, focus landing on the message textarea, and the "Advisor off" live-region announcement.
// Finally, three themed screenshots of the chip ON (Dark, Obsidian, Dark high contrast).

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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
  launchBuiltExe,
  safeRmSync,
  requireSharedCargoTarget,
  switchTheme,
  getAccessibleNameAndRole
} from './verify-tauri-scratch-helpers.mjs';
import { measuredContrastRatio } from './contrast-math.mjs';
import { pressKey } from './verify-tauri-session-list-helpers.mjs';
import {
  readAdvisorChipGeometry,
  readOtherChipGeometry,
  advisorChipPresent,
  assertNoProbeLeak,
  runAdvisorToggleCycle,
  sendSlashCommand
} from './verify-937-advisor-chip-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR =
  process.env.REFRACT_937_SHOTS_DIR || path.join(tmpdir(), 'refract-937-advisor-chip-shots', new Date().toISOString().replace(/[:.]/g, '-'));

async function pressEnterKey(cdp) {
  await cdp.pressEnter();
}

/** Gate round 2 fix (High, falsified against a DOM read): the status line (and so the Advisor
 * chip) renders BEFORE the message textarea in `MessageInput.tsx`'s own JSX
 * (`ComposerStatusLine` at line ~1327, the textarea itself further down) -- a FORWARD Tab chain
 * starting at the textarea can never reach it; only Shift+Tab (CDP modifier bitmask 8) walks
 * backward into it. */
async function pressShiftTabKey(cdp) {
  await pressKey(cdp, 9, 'Tab', 'Tab', 8);
}

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' }
];

async function main() {
  let dataDir, importSourceDir, repoDir, exeDir, launcherDir;
  let child;
  let cdp;
  const findings = [];
  const failures = [];
  const notExercised = [];
  let exeHash = null;
  let gitHeadSha = null;
  let dirty = 'unknown';
  try {
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-937-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-937-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-937-repo-')), 'verify-937-advisor-chip');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-937-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-937-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, approvalMode: 'auto' }));
    const port = await getFreePort();
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

    console.log(`verify-937: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`verify-937: data dir ${dataDir}`);
    console.log(`verify-937: shots dir ${SHOTS_DIR}`);
    console.log(`verify-937: CDP port ${port}`);

    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-937' });
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app.log') });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-937: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green (real omp --version + get_state round trip)' }
    );
    findings.push('Readiness green against the REAL ambient omp install, scratch data dir.');

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
      timeoutMs: 90_000,
      label: 'Session opened, real agent attached, composer enabled'
    });
    findings.push('Session created; REAL omp process attached (ambient signed-in profile, scratch cwd/worktree).');

    // Gate round 2 fix (High, item 12): moved to BEFORE any visible `/advisor` command this
    // script itself sends (the mouse/keyboard cycles below, each of which sends a real,
    // visible `/advisor status` whose OWN reply -- e.g. `Advisor "default" is running.` --
    // would otherwise match the same leak pattern and fail this check for a reason that has
    // nothing to do with the SILENT probe). Waits long enough for `session::advisor`'s own
    // bounded attempts (idle-gated, ~2s) plus its reply timeout (~5s) to have long settled one
    // way or the other before reading the transcript.
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    await assertNoProbeLeak(cdp, findings, failures, notExercised, 'Before any visible /advisor command');

    // Gate round 2 fix (Medium, item 14): polled, not a single immediate read -- the silent
    // probe (if this profile's own omp config defaults the advisor on) needs the SAME ~8s this
    // script already waited above to have had a chance to confirm/seed the chip's own state;
    // an immediate read right after Session creation could read "absent" only because that
    // probe had not yet resolved, not because the profile genuinely defaults the advisor off.
    let absentAtStart = true;
    const absentDeadline = Date.now() + 8_000;
    while (Date.now() < absentDeadline) {
      absentAtStart = !(await advisorChipPresent(cdp));
      if (!absentAtStart) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (absentAtStart) {
      findings.push('Advisor chip absent at Session start (advisor off by default), as FR-078 requires.');
    } else {
      const startStatusReply = await sendSlashCommand(cdp, '/advisor status', /advisor/i).catch((err) => `<no reply: ${err.message}>`);
      if (/\bdisabled\b/i.test(startStatusReply) && !/\benabled\b/i.test(startStatusReply)) {
        failures.push(`Advisor chip was present at Session start, but "/advisor status" reports disabled -- contradicts the chip's own state: ${JSON.stringify(startStatusReply)}`);
      } else {
        findings.push(`Advisor chip present at Session start; this profile's own omp config appears to default the advisor on. "/advisor status": ${JSON.stringify(startStatusReply)}`);
      }
    }

    // ---- Mouse-driven cycle (item 2-4 of the issue's own brief) ----
    await runAdvisorToggleCycle(cdp, { mode: 'mouse', pressShiftTab: pressShiftTabKey, pressEnterKey, shotsDir: SHOTS_DIR, findings, failures });

    // ---- Keyboard-only cycle, a FRESH `/advisor on` (item 5: never the same run as mouse) ----
    await runAdvisorToggleCycle(cdp, { mode: 'keyboard', pressShiftTab: pressShiftTabKey, pressEnterKey, shotsDir: SHOTS_DIR, findings, failures });
    // ---- Geometry comparison (item 3): a third, final `/advisor on` so the chip is present to
    // measure, since both cycles above end with it toggled off ----
    await sendAdvisorOnForGeometryPhase(cdp, findings, failures);
    const advisorGeometry = await readAdvisorChipGeometry(cdp);
    const otherGeometry = await readOtherChipGeometry(cdp);
    if (!advisorGeometry) {
      failures.push('Could not measure the Advisor chip\'s own geometry (not present when expected).');
    } else if (advisorGeometry.rowHeight !== 24 || !advisorGeometry.iconSize || advisorGeometry.iconSize.width !== 14 || advisorGeometry.iconSize.height !== 14) {
      failures.push(`Advisor chip geometry does not match the shared ReadoutChip baseline (24px row, 14px icon): ${JSON.stringify(advisorGeometry)}`);
    } else {
      findings.push(`Advisor chip geometry matches the shared ReadoutChip baseline: ${JSON.stringify(advisorGeometry)}`);
    }
    if (!otherGeometry) {
      notExercised.push('No OTHER status-line Readout chip was visible to compare the Advisor chip\'s geometry against (depends on this scratch Session\'s own live readout data, e.g. Context usage, Changes); the Advisor chip\'s own geometry was still measured directly against the fixed baseline above.');
    } else if (otherGeometry.rowHeight !== advisorGeometry?.rowHeight || JSON.stringify(otherGeometry.iconSize) !== JSON.stringify(advisorGeometry?.iconSize)) {
      failures.push(`Advisor chip geometry does not match a neighbouring status-line chip's own geometry: advisor=${JSON.stringify(advisorGeometry)} other=${JSON.stringify(otherGeometry)}`);
    } else {
      findings.push(`Advisor chip geometry matches a neighbouring status-line chip's own measured geometry: ${JSON.stringify(otherGeometry)}`);
    }
    // Gate round 2 fix (High, item 11), tightened gate round 3 (Medium, item 12): a fresh
    // scratch profile leaves `current-time` off by default (`DEFAULT_SESSION_READOUT`,
    // `shared/model.ts`), so the ORIGINAL "Advisor is last of all readout chips" assertion here
    // was vacuously true of an EMPTY set of later siblings -- it could never catch Advisor
    // actually landing after the `ml-auto` Current time chip, the one sibling the decision
    // text (`ComposerStatusLine.tsx`'s own gate round 1 comment) specifically orders against.
    // Turns `current-time` on for this scratch profile first, so a REAL later sibling exists.
    const readoutResult = await cdp.evaluate(`window.refract.settings.setReadoutVisibility('current-time', true).then((r) => r.ok)`);
    // Gate round 4 fix (Medium, decided): skips the rest of this check entirely on setup
    // failure, rather than falling through into a `waitFor` timeout and an order read that
    // would both fail too -- a single clear cause, not three cascading failures from one root.
    if (!readoutResult) {
      failures.push('Could not enable the Current time readout chip via settings.setReadoutVisibility -- skipping the order check.');
    } else {
      await cdp.waitFor(
        `!!Array.from(document.querySelectorAll('[data-slot="composer-status-line"] [data-slot="readout-chip"] .sr-only')).some((el) => el.textContent?.startsWith('Current time:'))`,
        { timeoutMs: 5_000, label: 'Current time chip appeared after enabling it for the order check' }
      ).catch((err) => failures.push(err.message));
      const order = await cdp.evaluate(`(() => {
        const chips = Array.from(document.querySelectorAll('[data-slot="composer-status-line"] [data-slot="readout-chip"]'));
        const index = chips.findIndex((el) => (el.querySelector('span[aria-hidden]')?.textContent ?? '').trim() === 'Advisor');
        const lastIsCurrentTime = (chips.at(-1)?.querySelector('.sr-only')?.textContent ?? '').startsWith('Current time:');
        return { total: chips.length, index, lastIsCurrentTime };
      })()`);
      if (order.index === -1) {
        failures.push('Could not find the Advisor chip among the status line\'s own readout chips for the order check.');
      } else if (!order.lastIsCurrentTime) {
        failures.push(`Expected the Current time chip last (total ${order.total}) to confirm the order check's own setup -- found something else last.`);
      } else if (order.index !== order.total - 2) {
        failures.push(`Advisor chip is not second-to-last, right before the Current time chip (index ${order.index} of ${order.total} total) -- expected ${order.total - 2}.`);
      } else {
        findings.push(`Advisor chip sits right before the Current time chip (index ${order.index} of ${order.total} total, Current time chip last), as decided.`);
      }
    }


    // ---- Themed screenshots of the chip ON (Dark, Obsidian, Dark high contrast) ----
    for (const theme of THEMES) {
      await switchTheme(cdp, theme.id, theme.name);
      const stillOn = await advisorChipPresent(cdp);
      if (!stillOn) {
        failures.push(`Advisor chip disappeared after switching to the ${theme.name} theme (a theme switch must never toggle it).`);
        continue;
      }
      // Gate round 1 fix (Medium, item 15): full AX name (never `textContent`, per the UI gate
      // checklist's own rule), visible text, tooltip text, and never a digit/`$`/"Spend" in any
      // of them -- plus a real, live-measured contrast ratio against this theme's own resolved
      // background colour, reusing `contrast-math.mjs` exactly like `check-theme-contrast.mjs`.
      await assertAdvisorChipNameTooltipAndContrast(cdp, theme.name, findings, failures);
      const shotName = `advisor-chip-on-${theme.id}.png`;
      await cdp.screenshot(path.join(SHOTS_DIR, shotName));
      findings.push(`Screenshot captured: Advisor chip ON under the ${theme.name} theme (${shotName}).`);
    }

    // ---- Cleanup: leave the Session in a known state (advisor off) ----
    await cdp.click(`Array.from(document.querySelectorAll('[data-slot="readout-chip"]')).find((el) => (el.querySelector('span[aria-hidden]')?.textContent ?? '').trim() === 'Advisor')`).catch(() => {});

    notExercised.push(
      'Verification backlog #650: the silent `/advisor status` attach/resume probe\'s own suppression from the transcript (issue #937\'s own accessibility requirement, `handle_command_output` in `session::advisor`, called from `agent/frame.rs`) was NOT independently proven here -- this run never restarted the app to re-attach to an existing Session, the one path that fires the silent probe (`on_launch`). Proving it needs a second scratch run: stop this Session\'s agent, relaunch the exe against the SAME `dataDir`, and confirm no new notice mounts in the transcript across the resume while the chip\'s own state still seeds correctly from `SessionSnapshot.advisorOn`.'
    );
    notExercised.push(
      'The busy-window "a repeat click/activation is a no-op" assertion is indirect (the accessible name staying at the busy wording) -- this script cannot directly observe whether `window.refract.chat.send` was actually called a second time or silently skipped by the component\'s own `turningOff` guard, short of instrumenting the IPC bridge itself.'
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
    console.log('\n=== verify-937: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-937: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-937: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-937: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
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
    console.error('verify-937: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
  }
}

/** A plain `/advisor on`, for the geometry/screenshot phase only (no toggle-off assertions
 * follow it here -- those are `runAdvisorToggleCycle`'s own job above). */
async function sendAdvisorOnForGeometryPhase(cdp, findings, failures) {
  try {
    await sendSlashCommand(cdp, '/advisor on', /Advisor enabled\./);
    findings.push('Final "/advisor on" (for the geometry/screenshot phase) produced the authoritative enable reply.');
  } catch (err) {
    failures.push(`Final "/advisor on" (geometry/screenshot phase) failed: ${err.message}`);
  }
}

const ADVISOR_CHIP_SELECTOR =
  `Array.from(document.querySelectorAll('[data-slot="readout-chip"]')).find((el) => (el.querySelector('span[aria-hidden]')?.textContent ?? '').trim() === 'Advisor')`;
// No digit, `$`, or the word "Spend" anywhere in the accessible name, the visible text, or the
// tooltip -- issue #937's own "no cost shown" requirement, checked structurally rather than
// against one fixed string, so a future wording change still gets caught if it reintroduces a
// figure.
const NO_COST_LEAK_PATTERN = /\d|\$|Spend/;

/** Gate round 1 fix (Medium, item 15): the FULL accessible name (via CDP
 * `Accessibility.getPartialAXTree`, never `textContent` -- the UI gate checklist's own rule),
 * the visible text, and a REAL hover-revealed tooltip, none of which may ever contain a digit,
 * `$`, or "Spend"; plus a live-measured WCAG contrast ratio of the chip's own resolved text
 * colour against its nearest opaque ancestor background, reusing `contrast-math.mjs` exactly
 * like `check-theme-contrast.mjs` already does for every other status-line pairing. */
async function assertAdvisorChipNameTooltipAndContrast(cdp, themeName, findings, failures) {
  const { name } = await getAccessibleNameAndRole(cdp, ADVISOR_CHIP_SELECTOR);
  if (name !== 'Advisor on. Turn off') {
    failures.push(`[${themeName}] Advisor chip accessible name was ${JSON.stringify(name)}, expected exactly "Advisor on. Turn off".`);
  } else {
    findings.push(`[${themeName}] Advisor chip accessible name is exactly "Advisor on. Turn off".`);
  }
  const visibleText = await cdp.evaluate(`(${ADVISOR_CHIP_SELECTOR})?.querySelector('span[aria-hidden]')?.textContent ?? null`);
  if (visibleText !== 'Advisor') {
    failures.push(`[${themeName}] Advisor chip visible text was ${JSON.stringify(visibleText)}, expected exactly "Advisor".`);
  } else {
    findings.push(`[${themeName}] Advisor chip visible text is exactly "Advisor".`);
  }

  // A real hover (mouseMoved, not a scripted focus/state toggle) over the chip's own centre,
  // matching `switchTheme`'s own established hover-before-interact pattern in this same repo.
  const rect = await cdp.evaluate(`(() => { const el = ${ADVISOR_CHIP_SELECTOR}; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  let tooltipText = null;
  try {
    await cdp.waitFor(`!!document.querySelector('[role="tooltip"]')`, { timeoutMs: 3_000, label: `[${themeName}] Advisor chip tooltip opened on hover` });
    tooltipText = await cdp.evaluate(`document.querySelector('[role="tooltip"]')?.textContent ?? null`);
    // Gate round 2 fix (Low, item 16): confirms OUR OWN deliberate `aria-describedby={undefined}`
    // override still holds -- Radix sets this on the trigger while its tooltip is open by
    // default (a double-announcement risk the UI gate checklist calls out), suppressed here on
    // purpose; a regression that dropped the override would otherwise go unnoticed.
    const describedBy = await cdp.evaluate(`(${ADVISOR_CHIP_SELECTOR})?.getAttribute('aria-describedby') ?? null`);
    if (describedBy !== null) {
      failures.push(`[${themeName}] Advisor chip button carries aria-describedby=${JSON.stringify(describedBy)} while its tooltip is open -- the deliberate override must suppress this (risk of a double announcement).`);
    } else {
      findings.push(`[${themeName}] Advisor chip button carries no aria-describedby while its tooltip is open, as the deliberate override requires.`);
    }
  } catch (err) {
    failures.push(`[${themeName}] ${err.message}`);
  }
  if (tooltipText !== null) {
    if (tooltipText !== 'Advisor on. Turn off') {
      failures.push(`[${themeName}] Advisor chip tooltip text was ${JSON.stringify(tooltipText)}, expected exactly "Advisor on. Turn off".`);
    } else {
      findings.push(`[${themeName}] Advisor chip tooltip text is exactly "Advisor on. Turn off" on hover.`);
    }
  }

  for (const [label, value] of [
    ['accessible name', name],
    ['visible text', visibleText],
    ['tooltip text', tooltipText]
  ]) {
    if (value && NO_COST_LEAK_PATTERN.test(value)) {
      failures.push(`[${themeName}] Advisor chip's ${label} contains a digit, "$", or "Spend" (no cost must ever show): ${JSON.stringify(value)}`);
    }
  }

  // Gate round 2 fix (High, item 13): the hover above leaves `hover:bg-muted`/`hover:text-
  // foreground` active -- measuring contrast WHILE still hovering reads the wrong (hover-state)
  // colours, not what a user normally sees at rest. Moves the mouse away and waits for the
  // tooltip to CLOSE before measuring. The background walk now starts AT the chip itself (not
  // its parent, which silently skipped the chip's own background and would still have missed a
  // hover-state background had the mouse still been over it).
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  try {
    await cdp.waitFor(`!document.querySelector('[role="tooltip"]')`, { timeoutMs: 3_000, label: `[${themeName}] Advisor chip tooltip closed after moving the mouse away` });
  } catch (err) {
    failures.push(`[${themeName}] ${err.message}`);
  }
  const styles = await cdp.evaluate(`(() => {
    const el = ${ADVISOR_CHIP_SELECTOR};
    if (!el) return null;
    const color = getComputedStyle(el).color;
    let bgEl = el;
    let background = null;
    while (bgEl) {
      const bg = getComputedStyle(bgEl).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') { background = bg; break; }
      bgEl = bgEl.parentElement;
    }
    return { color, background };
  })()`);
  if (!styles) {
    failures.push(`[${themeName}] could not read the Advisor chip's own computed style for a contrast measurement.`);
  } else if (!styles.background) {
    // Gate round 2 fix (High, item 13): no opaque background was found walking up from the
    // chip itself -- failing loudly here, never silently substituting an unrelated `<body>`
    // reading as a stand-in for "the real background this text actually sits on".
    failures.push(`[${themeName}] could not resolve an opaque background behind the Advisor chip for a contrast measurement (walked up to <html> and found none): ${JSON.stringify(styles)}`);
  } else {
    const ratio = measuredContrastRatio(styles.color, styles.background);
    if (ratio === null) {
      failures.push(`[${themeName}] could not parse the Advisor chip's own colour/background for a contrast measurement: ${JSON.stringify(styles)}`);
    } else if (ratio < 4.5) {
      failures.push(`[${themeName}] Advisor chip contrast ${ratio.toFixed(2)}:1 is under the required 4.5:1 (${JSON.stringify(styles)}).`);
    } else {
      findings.push(`[${themeName}] Advisor chip contrast ${ratio.toFixed(2)}:1 PASS (>= 4.5:1, ${JSON.stringify(styles)}).`);
    }
  }
}

main().catch((err) => {
  console.error('verify-937: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
