#!/usr/bin/env node
// Live CDP check for issue #1039 (Cyber Amber retuned onto Default Dark's own surfaces with a
// vivid orange accent; softer `--foreground`/`--chat-foreground` in both Cyber Amber and Dark).
//
// Reuses the existing, committed `997-notice-severity.jsonl` fixture (AGENTS.md: no new
// fixtures while prototyping) via `REFRACT_FAKE_OMP_SCENARIO=997-notice-severity`: one turn that
// deterministically renders a real `--severity-warning`-coloured NoticeRow, with no dependence
// on a real model ever choosing to emit a warning. The same turn's own echoed user message
// renders through `UserMessageRow.tsx`'s `text-chat-foreground` Markdown, giving a real chat-
// prose element too -- no second fixture needed for #1039's own softer-text assertion.
//
// For each of Cyber Amber and Dark (Default Dark), switches via the real Profile-menu Theme
// submenu (`switchTheme`, the same route `verify-551-presets.mjs` uses for Cyber Amber), then
// reads REAL rendered surfaces (never a hidden probe alone) and asserts each equals the matching
// CSS custom property's own resolved colour (`requireResolvedCssVarColor`, `verify-551-
// helpers.mjs`):
//   - `document.body` (`bg-background text-foreground`, globals.css's own `@layer base`): real
//     background/foreground vs `--background`/`--foreground`.
//   - `SessionList.tsx`'s own root (`bg-sidebar text-sidebar-foreground`): real sidebar
//     background/foreground vs `--sidebar`/`--sidebar-foreground`.
//   - `StatusBar.tsx`'s `<footer>` (`bg-card ... text-muted-foreground`): real card background
//     and real muted text vs `--card`/`--muted-foreground`.
//   - The user message's own `.text-chat-foreground` Markdown root: real chat prose colour vs
//     `--chat-foreground`.
//   - The warning NoticeRow (`noticeFinder`, same two-parent-climb pattern
//     `verify-997-notice-severity.mjs` already established): real colour vs `--severity-warning`.
//   - The real Send button (`bg-send text-send-foreground`): real fill/text vs
//     `--send`/`--send-foreground`.
// `--accent-text` has no real rendered consumer in this fixture's own turn (no Markdown link),
// so it is read via the probe only (`requireResolvedCssVarColor`) and used, alongside the real
// warning colour above, for the accent-vs-warning real OKLab hue-distance assertion (#1039's own
// decision: the new orange accent sits closer to the OLD warning hue than the old accent did, so
// `--severity-warning` was retuned apart from it -- this is the regression this floor exists to
// catch, the same pattern `verify-551-presets.mjs`'s own `CYBER_AMBER_ACCENT_WARNING_HUE_FLOOR`
// established for the prior accent/warning retune).
//
// Screenshots per theme: the chat view (the warning NoticeRow is inline in it, so one shot
// covers both "chat" and "a warning"), the Manage sessions screen (the Session list), and the
// Settings Appearance section.
//
// Usage: CARGO_TARGET_DIR=<shared target dir> CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0 node
// scripts/verify-1039-amber-retune.mjs (requires a prior `pnpm tauri build --debug --no-bundle`,
// the convention every `verify-5xx-*.mjs`/`verify-9xx-*.mjs`/`verify-10xx-*.mjs` script
// documents). NOT run by this prep lane (NO-BUILD; held for the build slot) -- syntax-checked
// only (`node --check`).

import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import {
  gitHead,
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
import { hueDistanceDegrees, describeHueLightness, requireResolvedCssVarColor } from './verify-551-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-1039';
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = process.env.REFRACT_1039_SHOTS_DIR || path.join(tmpdir(), 'refract-1039-amber-retune-shots');

const THEMES = [
  { id: 'cyber-amber', name: 'Cyber Amber' },
  { id: 'dark', name: 'Dark' }
];

// #1039's own decision: the new orange accent (real hue ~55.9) sits closer to the OLD warning
// hue (~73.8) than the old accent did (~39.9), so `--severity-warning` moved to hue 88 (real
// ~86.6, ~30.7 degrees from the new accent) -- see globals.css's own `.theme-cyber-amber` header
// comment. Set below the measured value, same conservative-margin convention
// `verify-551-presets.mjs`'s own `CYBER_AMBER_ACCENT_WARNING_HUE_FLOOR` (30) used.
const ACCENT_WARNING_HUE_FLOOR = 25;

function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

// Same two-parent-climb `NoticeRow` finder `verify-997-notice-severity.mjs`/
// `verify-917-advisor-command.mjs`/`verify-938-slash-rest.mjs` all use.
function noticeFinder(levelLabel) {
  return `Array.from(document.querySelectorAll('span.sr-only')).filter((el) => (el.textContent ?? '').trim() === ${JSON.stringify(levelLabel)}).map((el) => el.parentElement?.parentElement).filter(Boolean)`;
}

const SEND_BUTTON_FINDER = `document.querySelector('button[aria-label="Send message"]')`;

/** Reads every REAL, currently-rendered surface this check needs in one round trip (never a
 * hidden probe alone -- see this file's own header comment for which component each class
 * belongs to). */
async function readRealColours(cdp) {
  return cdp.evaluate(`(() => {
    const body = document.body;
    const sidebarRoot = document.querySelector('.bg-sidebar.text-sidebar-foreground');
    const footer = document.querySelector('footer');
    const chatProse = document.querySelector('.text-chat-foreground');
    const warningRows = (${noticeFinder('Warning:')});
    const warningRow = warningRows[warningRows.length - 1];
    const warningSpan = warningRow ? warningRow.querySelector(':scope > span.min-w-0.flex-1') : null;
    const send = ${SEND_BUTTON_FINDER};
    return {
      bodyBackground: body ? getComputedStyle(body).backgroundColor : null,
      bodyForeground: body ? getComputedStyle(body).color : null,
      sidebarBackground: sidebarRoot ? getComputedStyle(sidebarRoot).backgroundColor : null,
      sidebarForeground: sidebarRoot ? getComputedStyle(sidebarRoot).color : null,
      cardBackground: footer ? getComputedStyle(footer).backgroundColor : null,
      mutedForeground: footer ? getComputedStyle(footer).color : null,
      chatForeground: chatProse ? getComputedStyle(chatProse).color : null,
      warningColour: warningSpan ? getComputedStyle(warningSpan).color : null,
      sendBackground: send ? getComputedStyle(send).backgroundColor : null,
      sendForeground: send ? getComputedStyle(send).color : null
    };
  })()`);
}

async function openSettingsAppearance(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings screen opened' });
  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Appearance')`);
  await cdp.waitFor(`!!document.querySelector('[role="radiogroup"]')`, { timeoutMs: 10_000, label: 'Appearance section mounted (theme picker radiogroup)' });
}

async function closeSettingsBackToChat(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 10_000, label: 'Settings closed, back in chat' });
}

async function main() {
  const findings = [];
  const failures = []; // Wrong measured values, or a target genuinely missing -- ALWAYS fails the run.
  const notExercised = []; // Genuine skips only.
  const shotNames = [];

  const gitHeadSha = gitHead(REPO_ROOT);
  const gitStatusResult = spawnSync_('git', ['-C', REPO_ROOT, 'status', '--porcelain']);
  const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
  const dirty = dirtyLines === null ? 'unknown' : dirtyLines.length > 0;
  console.log(`${LOG}: git HEAD ${gitHeadSha}${dirty === true ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);

  clearKnownOutputFiles(
    SHOTS_DIR,
    'refract-1039-amber-retune-shots',
    [...THEMES.flatMap((t) => [`${t.id}-00-chat-with-warning.png`, `${t.id}-01-manage-sessions.png`, `${t.id}-02-settings-appearance.png`]), 'report.json', 'app.log', 'fake-omp-invocations.log']
  );

  const dataDir = mkdtempSync(path.join(tmpdir(), 'refract-1039-data-'));
  const importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-1039-import-'));
  const repoDirBase = mkdtempSync(path.join(tmpdir(), 'refract-1039-repo-'));
  const repoDir = makeScratchRepo(repoDirBase, 'verify-1039-amber-retune');
  const exeDir = mkdtempSync(path.join(tmpdir(), 'refract-1039-exe-'));
  const launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-1039-launcher-'));
  const shimDir = mkdtempSync(path.join(tmpdir(), 'refract-1039-shim-'));

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
        REFRACT_FAKE_OMP_DEBUG_LOG: debugLogPath,
        REFRACT_FAKE_OMP_SCENARIO: '997-notice-severity'
      }
    });
    child = launched.child;
    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, launched.targetPid)) {
      throw new Error(`${LOG}: CDP target on port ${port} is not owned by the process this run launched (pid ${launched.targetPid})`);
    }
    assertExeUnchanged(exePath, exeHash, 'post-launch', LOG);

    // Shim-confirmed guard (same pattern as verify-997/verify-1000/verify-1001): without this, a
    // silently-wrong fake-omp shim (a stale PATH entry, or the shim crashing before its first
    // debugLog call) could still let the whole run "pass" on UI state alone.
    if (!existsSync(debugLogPath)) {
      throw new Error(`${LOG}: fake-omp debug log not found at ${debugLogPath} -- the fake omp shim never ran (shim confirmed check).`);
    }
    const debugLogFirstLine = readFileSync(debugLogPath, 'utf8').split('\n')[0] ?? '';
    if (!/^pid=\d+ argv=/.test(debugLogFirstLine)) {
      throw new Error(`${LOG}: fake-omp debug log's first line does not match the expected "pid=<pid> argv=..." startup marker; got: ${JSON.stringify(debugLogFirstLine)}`);
    }
    findings.push(`Fake omp shim confirmed: debug log's first line is its own startup pid line (${debugLogPath}).`);

    // Real UI flow (mirrors verify-997-notice-severity.mjs): readiness, Add repository, New
    // session, wait for the composer against the fake omp's scripted tape.
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
    findings.push('Session created; fake-omp process attached (997-notice-severity scenario, reused per AGENTS.md "no new fixtures").');

    // Drives the fixture's own one scripted turn: a short warning notice (and a short error
    // notice, unused here), plus the echoed user message that gives a real `.text-chat-foreground`
    // element to read.
    await cdp.typeIntoByLabel('Message', 'trigger the scripted notices');
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`(${noticeFinder('Warning:')}).length > 0`, { timeoutMs: 30_000, label: 'Warning notice rendered' });
    await sleep(300);

    for (const theme of THEMES) {
      try {
        await switchTheme(cdp, theme.id, theme.name);
        await sleep(250);
        const appliedClass = await cdp.evaluate(`document.documentElement.className`);
        if (!appliedClass.includes(`theme-${theme.id}`)) {
          failures.push(`${theme.name}: <html> class is "${appliedClass}" after switching, expected it to include "theme-${theme.id}".`);
          continue;
        }
        findings.push(`${theme.name}: real <html> class confirmed (${appliedClass}).`);

        const real = await readRealColours(cdp);
        const missing = Object.entries(real).filter(([, v]) => v === null).map(([k]) => k);
        if (missing.length > 0) {
          failures.push(`${theme.name}: these real elements/colours could not be read (selector matched nothing): ${missing.join(', ')}.`);
        }

        // ---- Assert every real rendered colour matches its token's own resolved value. ----
        const assertions = [
          ['document.body background', real.bodyBackground, await requireResolvedCssVarColor(cdp, '--background', 'background-color')],
          ['document.body foreground', real.bodyForeground, await requireResolvedCssVarColor(cdp, '--foreground', 'color')],
          ['SessionList root background (the sidebar)', real.sidebarBackground, await requireResolvedCssVarColor(cdp, '--sidebar', 'background-color')],
          ['SessionList root foreground', real.sidebarForeground, await requireResolvedCssVarColor(cdp, '--sidebar-foreground', 'color')],
          ['StatusBar footer background (a card)', real.cardBackground, await requireResolvedCssVarColor(cdp, '--card', 'background-color')],
          ['StatusBar footer foreground (muted text)', real.mutedForeground, await requireResolvedCssVarColor(cdp, '--muted-foreground', 'color')],
          ['user message prose (chat text)', real.chatForeground, await requireResolvedCssVarColor(cdp, '--chat-foreground', 'color')],
          ['warning NoticeRow', real.warningColour, await requireResolvedCssVarColor(cdp, '--severity-warning', 'color')],
          ['Send button fill', real.sendBackground, await requireResolvedCssVarColor(cdp, '--send', 'background-color')],
          ['Send button text', real.sendForeground, await requireResolvedCssVarColor(cdp, '--send-foreground', 'color')]
        ];
        for (const [label, actual, expected] of assertions) {
          if (actual === null) continue; // already reported in `missing` above
          if (actual !== expected) {
            failures.push(`${theme.name}: ${label} measures ${actual}, expected it to equal its own token (${expected}).`);
          } else {
            findings.push(`${theme.name}: ${label} (${actual}) matches its own token.`);
          }
        }

        // ---- Accent text vs warning: real OKLab hue distance (#1039's own regression floor). ----
        const accentRaw = await requireResolvedCssVarColor(cdp, '--accent-text', 'color');
        const accentHL = describeHueLightness(accentRaw);
        const warningHL = real.warningColour ? describeHueLightness(real.warningColour) : null;
        if (!accentHL || !warningHL) {
          failures.push(`${theme.name}: could not parse --accent-text (${accentRaw}) or the real warning colour (${real.warningColour}) for a real OKLab hue read.`);
        } else {
          const hueDist = hueDistanceDegrees(accentHL.hue, warningHL.hue);
          if (hueDist < ACCENT_WARNING_HUE_FLOOR) {
            failures.push(`${theme.name}: --accent-text (hue ${accentHL.hue.toFixed(1)}) and the real warning colour (hue ${warningHL.hue.toFixed(1)}) are only ${hueDist.toFixed(1)} degrees apart -- below the ${ACCENT_WARNING_HUE_FLOOR}-degree floor, so a warning could read as the accent.`);
          } else {
            findings.push(`${theme.name}: --accent-text (hue ${accentHL.hue.toFixed(1)}) and the real warning colour (hue ${warningHL.hue.toFixed(1)}) are ${hueDist.toFixed(1)} degrees apart (>=${ACCENT_WARNING_HUE_FLOOR}), a real distinct hue.`);
          }
        }
        findings.push(`${theme.name}: --accent-text resolved colour: ${accentRaw} (probe only -- this fixture's one turn renders no Markdown link).`);

        // ---- Screenshots: chat (the warning NoticeRow is inline in it), Manage sessions (the
        // Session list), Settings Appearance. ----
        const chatShot = `${theme.id}-00-chat-with-warning.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, chatShot));
        shotNames.push(chatShot);

        await cdp.click(`document.querySelector('[data-profile-name-button]')`);
        await cdp.waitFor(`!!Array.from(document.querySelectorAll('[role="menu"][data-state="open"]')).find((el) => el.textContent.includes('Manage sessions'))`, {
          timeoutMs: 10_000,
          label: 'Profile dropdown menu open (containing Manage sessions)'
        });
        await cdp.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim() === 'Manage sessions')`);
        await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Manage sessions screen opened' });
        await sleep(200);
        const manageShot = `${theme.id}-01-manage-sessions.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, manageShot));
        shotNames.push(manageShot);
        await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
        await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 10_000, label: 'Manage sessions closed, back in chat' });

        await openSettingsAppearance(cdp);
        await sleep(200);
        const settingsShot = `${theme.id}-02-settings-appearance.png`;
        await cdp.screenshot(path.join(SHOTS_DIR, settingsShot));
        shotNames.push(settingsShot);
        await closeSettingsBackToChat(cdp);

        findings.push(`${theme.name}: screenshots captured (chat+warning, Manage sessions, Settings Appearance).`);
      } catch (err) {
        failures.push(`${theme.name}: ${err.message}`);
      }
    }

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

main().catch((err) => {
  console.error(`${LOG}: unhandled error:`, err?.stack ?? err);
  process.exitCode = 1;
});
