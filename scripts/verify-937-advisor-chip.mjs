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
  switchTheme
} from './verify-tauri-scratch-helpers.mjs';
import { pressTab } from './verify-tauri-session-list-helpers.mjs';
import {
  readAdvisorChipGeometry,
  readOtherChipGeometry,
  advisorChipPresent,
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

    const absentAtStart = !(await advisorChipPresent(cdp));
    if (absentAtStart) findings.push('Advisor chip absent at Session start (advisor off by default), as FR-076 requires.');
    else failures.push('Advisor chip was ALREADY present at Session start, with no `/advisor on` yet sent -- a real failure.');

    // ---- Mouse-driven cycle (item 2-4 of the issue's own brief) ----
    await runAdvisorToggleCycle(cdp, { mode: 'mouse', pressTab, pressEnterKey, shotsDir: SHOTS_DIR, findings, failures });

    // ---- Keyboard-only cycle, a FRESH `/advisor on` (item 5: never the same run as mouse) ----
    await runAdvisorToggleCycle(cdp, { mode: 'keyboard', pressTab, pressEnterKey, shotsDir: SHOTS_DIR, findings, failures });

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

    // ---- Themed screenshots of the chip ON (Dark, Obsidian, Dark high contrast) ----
    for (const theme of THEMES) {
      await switchTheme(cdp, theme.id, theme.name);
      const stillOn = await advisorChipPresent(cdp);
      if (!stillOn) {
        failures.push(`Advisor chip disappeared after switching to the ${theme.name} theme (a theme switch must never toggle it).`);
        continue;
      }
      const shotName = `advisor-chip-on-${theme.id}.png`;
      await cdp.screenshot(path.join(SHOTS_DIR, shotName));
      findings.push(`Screenshot captured: Advisor chip ON under the ${theme.name} theme (${shotName}).`);
    }

    // ---- Cleanup: leave the Session in a known state (advisor off) ----
    await cdp.click(`Array.from(document.querySelectorAll('[data-slot="readout-chip"]')).find((el) => (el.querySelector('span[aria-hidden]')?.textContent ?? '').trim() === 'Advisor')`).catch(() => {});

    notExercised.push(
      'The silent `/advisor status` attach/resume probe\'s own suppression from the transcript (issue #937\'s own accessibility requirement, `consume_if_silent_probe` in `agent/frame.rs`) was NOT independently proven here -- this run never restarted the app to re-attach to an existing Session, the one path that fires the silent probe (`on_launch`). Proving it needs a second scratch run: stop this Session\'s agent, relaunch the exe against the SAME `dataDir`, and confirm no new notice mounts in the transcript across the resume while the chip\'s own state still seeds correctly from `SessionSnapshot.advisorOn`.'
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

main().catch((err) => {
  console.error('verify-937: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
