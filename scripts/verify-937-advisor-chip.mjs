#!/usr/bin/env node
// Live CDP check for #937 (composer status line's Advisor chip): separate mouse and keyboard
// toggle cycles, geometry, and themed screenshots. Per-cycle assertions live in
// `verify-937-advisor-chip-helpers.mjs`. The silent attach/resume probe's transcript
// suppression needs an app restart and is recorded in `notExercised`.

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

/** The chip renders before the textarea in the DOM, so only Shift+Tab (CDP modifier 8) reaches
 * it from the textarea; a forward Tab chain never can. */
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
      timeoutMs: 90_000,
      label: 'Session opened, real agent attached, composer enabled'
    });
    findings.push('Session created; REAL omp process attached (ambient signed-in profile, scratch cwd/worktree).');

    // Runs before any visible `/advisor` command: those replies would match the same leak
    // pattern. Waits for the silent probe's bounded attempts (~2s) and reply timeout (~5s).
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    await assertNoProbeLeak(cdp, findings, failures, notExercised, 'Before any visible /advisor command');

    // Polled: an immediate read could see "absent" only because the silent probe has not resolved.
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

    // Mouse-driven cycle.
    await runAdvisorToggleCycle(cdp, { mode: 'mouse', pressShiftTab: pressShiftTabKey, pressEnterKey, shotsDir: SHOTS_DIR, findings, failures });

    // Keyboard-only cycle, with a fresh `/advisor on`.
    await runAdvisorToggleCycle(cdp, { mode: 'keyboard', pressShiftTab: pressShiftTabKey, pressEnterKey, shotsDir: SHOTS_DIR, findings, failures });
    // Geometry: both cycles end with the chip off, so turn it on a third time to measure it.
    await sendAdvisorOnForGeometryPhase(cdp, findings, failures);
    const advisorGeometry = await readAdvisorChipGeometry(cdp);
    const otherGeometry = await readOtherChipGeometry(cdp);
    if (!advisorGeometry) {
      failures.push('Could not measure the Advisor chip\'s own geometry (not present when expected).');
    } else if (advisorGeometry.rowHeight !== 24 || !advisorGeometry.iconSize || advisorGeometry.iconSize.width !== 14 || advisorGeometry.iconSize.height !== 14) {
      failures.push(`Advisor chip geometry does not match the shared ReadoutItem baseline (24px row, 14px icon): ${JSON.stringify(advisorGeometry)}`);
    } else {
      findings.push(`Advisor chip geometry matches the shared ReadoutItem baseline: ${JSON.stringify(advisorGeometry)}`);
    }
    if (!otherGeometry) {
      notExercised.push('No OTHER status-line Readout chip was visible to compare the Advisor chip\'s geometry against (depends on this scratch Session\'s own live readout data, e.g. Context usage, Changes); the Advisor chip\'s own geometry was still measured directly against the fixed baseline above.');
    } else if (otherGeometry.rowHeight !== advisorGeometry?.rowHeight || JSON.stringify(otherGeometry.iconSize) !== JSON.stringify(advisorGeometry?.iconSize)) {
      failures.push(`Advisor chip geometry does not match a neighbouring status-line chip's own geometry: advisor=${JSON.stringify(advisorGeometry)} other=${JSON.stringify(otherGeometry)}`);
    } else {
      findings.push(`Advisor chip geometry matches a neighbouring status-line chip's own measured geometry: ${JSON.stringify(otherGeometry)}`);
    }
    // A fresh profile has `current-time` off, which would make "Advisor is last" vacuously true;
    // turn it on so a real later sibling exists.
    const readoutResult = await cdp.evaluate(`window.refract.settings.setReadoutVisibility('current-time', true).then((r) => r.ok)`);
    // Skip the rest on setup failure so one root cause does not cascade into three failures.
    if (!readoutResult) {
      failures.push('Could not enable the Current time readout chip via settings.setReadoutVisibility -- skipping the order check.');
    } else {
      await cdp.waitFor(
        `!!Array.from(document.querySelectorAll('[data-slot="composer-status-line"] [data-slot="readout-chip"]')).some((el) => (el.getAttribute('aria-label') ?? el.querySelector('.sr-only')?.textContent ?? '').startsWith('Current time'))`,
        { timeoutMs: 5_000, label: 'Current time chip appeared after enabling it for the order check' }
      ).catch((err) => failures.push(err.message));
      const order = await cdp.evaluate(`(() => {
        const chips = Array.from(document.querySelectorAll('[data-slot="composer-status-line"] [data-slot="readout-chip"]'));
        const index = chips.findIndex((el) => (el.querySelector('span[aria-hidden]')?.textContent ?? '').trim() === 'Advisor');
        const lastIsCurrentTime = (chips.at(-1)?.getAttribute('aria-label') ?? chips.at(-1)?.querySelector('.sr-only')?.textContent ?? '').startsWith('Current time');
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


    // Themed screenshots of the chip ON.
    for (const theme of THEMES) {
      await switchTheme(cdp, theme.id, theme.name);
      // `switchTheme` leaves the profile button focused and hovered, so its Radix tooltip stays
      // open and a later `[role="tooltip"]` read finds it instead of the chip's. Click the
      // transcript (never the chip, which would toggle the advisor off) to blur it first.
      await cdp.click(`document.querySelector('[aria-label="Transcript"]')`).catch(() => {});
      await cdp
        .waitFor(`!document.querySelector('[role="tooltip"]')`, {
          timeoutMs: 3_000,
          label: `[${theme.name}] stray profile-menu tooltip closed before the Advisor chip's own hover check`
        })
        .catch((err) => failures.push(err.message));
      const stillOn = await advisorChipPresent(cdp);
      if (!stillOn) {
        failures.push(`Advisor chip disappeared after switching to the ${theme.name} theme (a theme switch must never toggle it).`);
        continue;
      }
      // Full AX name (not `textContent`), visible text and tooltip must carry no cost figure,
      // plus a measured contrast ratio via `contrast-math.mjs`.
      await assertAdvisorChipNameTooltipAndContrast(cdp, theme.name, findings, failures, notExercised);
      const shotName = `advisor-chip-on-${theme.id}.png`;
      await cdp.screenshot(path.join(SHOTS_DIR, shotName));
      findings.push(`Screenshot captured: Advisor chip ON under the ${theme.name} theme (${shotName}).`);
    }

    // Cleanup: leave the Session with the advisor off.
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

/** A plain `/advisor on` for the geometry/screenshot phase; toggle-off assertions live elsewhere. */
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
// No digit, `$` or "Spend" in the name, text or tooltip (#937 "no cost shown"); checked by
// pattern so a reworded figure is still caught.
const NO_COST_LEAK_PATTERN = /\d|\$|Spend/;

/** Checks the full AX name (via `Accessibility.getPartialAXTree`), visible text and hover tooltip
 * for cost figures, and the chip's text contrast against its nearest opaque ancestor background. */
async function assertAdvisorChipNameTooltipAndContrast(cdp, themeName, findings, failures, notExercised) {
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

  // A real mouseMoved hover over the chip's centre, not a scripted state toggle.
  const rect = await cdp.evaluate(`(() => { const el = ${ADVISOR_CHIP_SELECTOR}; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  let tooltipText = null;
  try {
    await cdp.waitFor(`!!document.querySelector('[role="tooltip"]')`, { timeoutMs: 3_000, label: `[${themeName}] Advisor chip tooltip opened on hover` });
    tooltipText = await cdp.evaluate(`document.querySelector('[role="tooltip"]')?.textContent ?? null`);
    // Confirms our deliberate `aria-describedby={undefined}` override still holds; Radix sets it
    // by default, which risks a double announcement.
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

  // Hover leaves `hover:` styles active, so contrast is measured with the pointer moved away,
  // and the background walk starts at the chip itself.
  // Waiting for the tooltip to close is not asserted: Radix closes on `pointerleave`, which
  // CDP's synthetic `mouseMoved` does not reliably fire on this WebView2 target (harness gap).
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  if (themeName === THEMES[0].name) {
    const elementAtOrigin = await cdp.evaluate(`document.elementFromPoint(0, 0)?.tagName ?? null`);
    const state = await cdp.evaluate(`document.querySelector('[role="tooltip"]')?.getAttribute('data-state') ?? 'absent'`);
    notExercised.push(
      `Advisor chip tooltip closing after the mouse moves away was NOT provable through this harness: the pointer demonstrably left (document.elementFromPoint(0, 0) resolves to a ${elementAtOrigin}, not the chip) and the contrast measurement below is unaffected (Chromium's own :hover tracking updates independently of JS events), but the tooltip's own data-state stays "${state}" (never "closed") regardless -- CDP's synthetic mouseMoved does not reliably produce the real pointerleave DOM event Radix's open-state tracking needs against this Tauri/WebView2 CDP target. A real mouse/touchpad would close it; this script's synthetic input cannot prove that either way.`
    );
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
    // No opaque background found: fail loudly rather than substitute an unrelated `<body>` colour.
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
