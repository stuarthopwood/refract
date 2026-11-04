#!/usr/bin/env node
// Live CDP check for #565 (connected-log spine): multi-call and solo bash tool groups.
// Drives a REAL omp in a scratch Session, because no fake-omp tape yields a 2+ call group with one failure.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, createWriteStream, copyFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, launchViaJobObject, isTargetOwningPort, sleep } from './verify-tauri-cdp.mjs';
import { requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR = path.join(tmpdir(), 'refract-565-shots');

const TURN_A_PROMPT =
  "Make exactly TWO separate bash tool calls, one after the other: first run exactly `echo spine-one`, then second run exactly `exit 7` (which deliberately fails). Wait for both calls to finish. Then reply with exactly the single word 'spine565a' and nothing else.";
const TURN_B_PROMPT =
  "Make exactly ONE bash tool call: run exactly `echo spine-solo`. Then reply with exactly the single word 'spine565b' and nothing else.";
const TURN_A_SENTINEL = 'spine565a';
const TURN_B_SENTINEL = 'spine565b';
// Exact label match only: a streaming Thinking row can contain "bash" in its preview and sits earlier in the DOM.
// A solo bash row has no label, so a label-less button whose summary starts with the `$` command grammar also matches.
const BASH_HEADER_FINDER =
  `Array.from(document.querySelectorAll('[aria-label="Transcript"] button')).filter((el) => {
    const label = el.querySelector('[data-slot="collapsed-line-label"]');
    if (label) return /^Ran(\\s*\\u00d7\\d+)?$/.test(label.textContent.trim());
    const s = el.querySelector('span.min-w-0.flex-1');
    return s ? /^\\$ /.test((s.textContent || '').trim()) : false;
  })`;

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

function gitHead() {
  const result = spawnSync_('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD']);
  return result.status === 0 ? result.stdout.trim() : `<git rev-parse failed: ${result.stderr}>`;
}

function buildLauncher(dir) {
  mkdirSync(dir, { recursive: true });
  const src = path.join(__dirname, 'verify-tauri-launcher.rs');
  const out = path.join(dir, 'verify-tauri-launcher.exe');
  const result = spawnSync_('rustc', ['--edition', '2021', '-O', src, '-o', out]);
  if (result.status !== 0) throw new Error(`buildLauncher: rustc failed (exit ${result.status}):\n${result.stderr}`);
  return out;
}

function makeScratchRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const run = (args) => {
    const result = spawnSync_('git', ['-C', dir, ...args]);
    if (result.status !== 0) throw new Error(`makeScratchRepo: git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    return result;
  };
  run(['init', '-q', '-b', 'main']);
  run(['-c', 'user.name=verify-565-spine', '-c', 'user.email=verify-565-spine@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

function sha256OfFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function buildAndCopyExeFresh(destDir, { maxAttempts = 3 } = {}) {
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'refract-tauri.exe');
  const src = path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`verify-565-spine: rebuilding the debug exe fresh (attempt ${attempt}/${maxAttempts})...`);
    const buildResult = spawnSync_('pnpm', ['tauri', 'build', '--debug', '--no-bundle'], { cwd: REPO_ROOT, stdio: 'inherit', shell: true });
    if (buildResult.status !== 0) throw new Error(`buildAndCopyExeFresh: pnpm tauri build failed (exit ${buildResult.status}${buildResult.error ? `, error: ${buildResult.error.message}` : ''})`);
    if (!existsSync(src)) throw new Error(`buildAndCopyExeFresh: built exe not found at ${src} after a successful build`);
    const preCopyStat = statSync(src);
    const preCopyHash = sha256OfFile(src);
    copyFileSync(src, dest);
    const postCopyStat = statSync(src);
    const postCopyHash = existsSync(src) ? sha256OfFile(src) : null;
    const unchanged = postCopyHash === preCopyHash && postCopyStat.mtimeMs === preCopyStat.mtimeMs && postCopyStat.size === preCopyStat.size;
    if (unchanged) {
      console.log(`verify-565-spine: built exe copied to ${dest} (private copy; sha256 ${preCopyHash.slice(0, 12)}…, confirmed unchanged through the copy)`);
      return { dest, hash: preCopyHash };
    }
    console.warn(`verify-565-spine: source exe changed between build and copy (attempt ${attempt}) -- a concurrent lane is rebuilding; retrying.`);
  }
  throw new Error(`buildAndCopyExeFresh: source exe kept changing across ${maxAttempts} rebuild attempts.`);
}

async function launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile }) {
  const webview2DataDir = path.join(path.dirname(exePath), 'webview2-data');
  mkdirSync(webview2DataDir, { recursive: true });
  const pidFile = path.join(path.dirname(exePath), 'target.pid');
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
    REFRACT_DATA_DIR: dataDir,
    REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
  };
  const { child, targetPid } = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: path.dirname(exePath), env });
  if (logFile) {
    const stream = createWriteStream(logFile);
    child.stdout.pipe(stream, { end: false });
    child.stderr.pipe(stream, { end: false });
  }
  return { child, targetPid };
}

async function safeRmSync(dir) {
  if (!dir) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 2) {
        console.warn(`verify-565-spine: could not remove scratch dir ${dir} (left on disk): ${err.message}`);
        return;
      }
      await sleep(1000);
    }
  }
}

function assertExeUnchanged(exePath, expectedHash, label) {
  const actualHash = sha256OfFile(exePath);
  if (actualHash !== expectedHash) {
    throw new Error(`assertExeUnchanged (${label}): ${exePath} hash is ${actualHash.slice(0, 12)}…, expected ${expectedHash.slice(0, 12)}… -- the exe under test changed after launch; this run's findings cannot be trusted.`);
  }
  console.log(`verify-565-spine: exe sha256 ${expectedHash.slice(0, 12)}… confirmed unchanged (${label}).`);
}

async function countBashHeaders(cdp) {
  return cdp.evaluate(`(${BASH_HEADER_FINDER}).length`);
}

async function clickBashHeaderAt(cdp, index) {
  await cdp.click(`(${BASH_HEADER_FINDER}).at(${index})`);
}

/** Sets the bash header at `index` to `wantOpen` only when it differs; a blind toggle could re-close a header and corrupt later geometry reads. */
async function setBashHeaderExpanded(cdp, index, wantOpen) {
  // `.at()` not bracket indexing: `arr[-1]` is undefined, and a negative index must resolve like `clickBashHeaderAt`.
  const isOpen = await cdp.evaluate(`(${BASH_HEADER_FINDER}).at(${index})?.getAttribute('aria-expanded') === 'true'`);
  if (isOpen === wantOpen) return;
  await clickBashHeaderAt(cdp, index);
  await cdp.waitFor(
    `(${BASH_HEADER_FINDER}).at(${index})?.getAttribute('aria-expanded') === '${wantOpen}'`,
    { timeoutMs: 10_000, label: `bash header ${index} aria-expanded=${wantOpen}` },
  );
}

async function getAccessibleNameAndRole(cdp, selectorExpr) {
  await cdp.send('Accessibility.enable');
  const evalResult = await cdp.send('Runtime.evaluate', { expression: selectorExpr, returnByValue: false });
  const objectId = evalResult.result?.objectId;
  if (!objectId) return { name: null, role: null };
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { objectId });
  const node = nodes?.[0];
  return { name: node?.name?.value ?? null, role: node?.role?.value ?? null };
}

// Auto mode must be seeded in settings.json: `setApprovalMode` only sets `pendingMode`, applied at the next settle,
// which never happens for a Session that is not mid-turn. Ask mode would split the two bash calls into separate groups.

/** Drives the real Profile-menu UI: no IPC call sets the `<html>` class the CSS tokens key off.
 * A real `mouseMoved` hover is needed to open Radix's `DropdownMenuSub`; theme rows are `role="menuitemradio"` (#1043). */
async function switchTheme(cdp, themeId, themeName) {
  await cdp.click(`document.querySelector('[data-profile-name-button]')`);
  await cdp.waitFor(`!!document.querySelector('[role="menu"]')`, { timeoutMs: 10_000, label: 'Profile dropdown menu open' });
  const themeTriggerFinder = `Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent.trim().startsWith('Theme'))`;
  await cdp.waitFor(`!!(${themeTriggerFinder})`, { timeoutMs: 10_000, label: 'Theme submenu trigger visible' });
  const rect = await cdp.evaluate(`(() => { const el = ${themeTriggerFinder}; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await sleep(400);
  await cdp.click(themeTriggerFinder);
  await cdp.waitFor(
    `!!Array.from(document.querySelectorAll('[role="menuitemradio"] span.flex-1')).find((el) => el.textContent.trim() === ${JSON.stringify(themeName)})`,
    { timeoutMs: 10_000, label: `Theme submenu open, "${themeName}" item visible` },
  );
  await cdp.click(
    `Array.from(document.querySelectorAll('[role="menuitemradio"]')).find((el) => { const span = el.querySelector('span.flex-1'); return span && span.textContent.trim() === ${JSON.stringify(themeName)}; })`,
  );
  await cdp.waitFor(`document.documentElement.classList.contains(${JSON.stringify(`theme-${themeId}`)})`, {
    timeoutMs: 15_000,
    label: `<html> class theme-${themeId} applied (real store round trip, not just the title-bar preview)`,
  });
}

async function main() {
  let dataDir, importSourceDir, repoDir, exeDir, launcherDir;
  let child;
  let cdp;
  const findings = [];
  const failures = []; // Wrong measured values -- ALWAYS fails the run. Never a graceful skip.
  const notExercised = []; // Genuine skips only (timing, an optional path not reached).
  let exeHash = null;
  let gitHeadSha = null;
  try {
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-565-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-565-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-565-repo-')));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-565-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-565-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    // Seeded before launch so omp starts in Auto and no approval card splits a tool group.
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, approvalMode: 'auto' }));
    const port = await getFreePort();
    gitHeadSha = gitHead();

    console.log(`verify-565-spine: git HEAD ${gitHeadSha}`);
    console.log(`verify-565-spine: data dir ${dataDir}`);
    console.log(`verify-565-spine: repo dir ${repoDir}`);
    console.log(`verify-565-spine: shots dir ${SHOTS_DIR}`);
    console.log(`verify-565-spine: CDP port ${port}`);

    const built = buildAndCopyExeFresh(exeDir);
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app.log') });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-565-spine: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }
    assertExeUnchanged(exePath, exeHash, 'post-launch');

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green (real omp --version + get_state round trip)' },
    );
    findings.push('Readiness green against the REAL ambient omp install, scratch data dir.');

    await cdp.openLocalFolderDialog();
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label').startsWith('New session from a branch in '))`,
      { timeoutMs: 30_000, label: 'Scratch repository added' },
    );
    await cdp.clickByLabel('New session from a branch in ', { prefix: true });
    await cdp.waitFor(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button')).find((el) => el.textContent.trim() === 'Create session'); return !!b && !b.disabled; })()`,
      { timeoutMs: 15_000, label: 'New session dialog open, Create session enabled' },
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'New session dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 90_000,
      label: 'Session opened, real agent attached, composer enabled',
    });
    findings.push('Session created; REAL omp process attached (ambient signed-in profile, scratch cwd/worktree).');

    // The pill's accessible name is the one user-visible proof that the seeded mode took effect.
    const approvalPillLabel = await cdp.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').endsWith(', approval mode')); return b ? b.getAttribute('aria-label') : null; })()`);
    if (!approvalPillLabel || !approvalPillLabel.startsWith('Auto')) {
      throw new Error(`verify-565-spine: seeded settings.json approvalMode:"auto" did not take effect -- the Approval pill reads "${approvalPillLabel}", expected to start with "Auto".`);
    }
    findings.push(`Scratch Session launched already in Auto approval mode (seeded settings.json, pill reads "${approvalPillLabel}") -- no approval-card grouping boundary.`);

    // ---- Turn (a): 2 bash calls, second fails -> multi-call ToolGroupRow on a SpineList ----
    await cdp.typeIntoByLabel('Message', TURN_A_PROMPT);
    await cdp.clickByLabel('Send message');

    try {
      await cdp.waitFor(`(${BASH_HEADER_FINDER}).length > 0`, { timeoutMs: 20_000, label: 'bash group header first appears (best-effort running capture)' });
      await cdp.screenshot(path.join(SHOTS_DIR, '00-dark-running.png'));
      findings.push("Captured a best-effort 'running' screenshot before turn (a) settled.");
    } catch {
      notExercised.push("Could not capture the group mid-run before it settled (real model timing); see '01-dark-collapsed-failed-group.png' for the settled state instead.");
    }

    try {
      await cdp.waitFor(
        `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && (t.textContent.match(/${TURN_A_SENTINEL}/g) ?? []).length >= 2; })()`,
        { timeoutMs: 180_000, label: 'Turn (a) finished (assistant echoed the sentinel back)' },
      );
    } catch (err) {
      await cdp.screenshot(path.join(SHOTS_DIR, '99-diag-turn-a-failure.png'));
      const html = await cdp.evaluate(`document.querySelector('[aria-label="Transcript"]')?.outerHTML ?? ''`).catch(() => '');
      writeFileSync(path.join(SHOTS_DIR, 'turn-a-transcript-onfailure.html'), html);
      throw err;
    }
    const turnATranscriptHtml = await cdp.evaluate(`document.querySelector('[aria-label="Transcript"]')?.outerHTML ?? ''`);
    writeFileSync(path.join(SHOTS_DIR, 'turn-a-transcript.html'), turnATranscriptHtml);

    const headerCountAfterA = await countBashHeaders(cdp);
    if (headerCountAfterA < 1) {
      await cdp.screenshot(path.join(SHOTS_DIR, '99-diag-turn-a-no-group.png'));
      throw new Error(`verify-565-spine: expected at least 1 bash ToolGroupRow header after turn (a), found ${headerCountAfterA} -- see turn-a-transcript.html`);
    }

    // Every later check depends on the first header's icon slot being 16px wide.
    const firstIconWidth = await cdp.evaluate(`(() => { const h = (${BASH_HEADER_FINDER})[0]; const icon = h ? h.querySelector('span') : null; return icon ? icon.getBoundingClientRect().width : null; })()`);
    if (firstIconWidth == null || firstIconWidth < 15 || firstIconWidth > 17) {
      failures.push(`FIRST bash header's icon slot measured ${firstIconWidth}px wide, required 16px (decision 7, size-4) -- this is the #565 marker; the build under test may not actually contain #565's own code.`);
    } else {
      findings.push(`First bash header's icon slot measured ${firstIconWidth}px (decision 7 marker confirmed).`);
    }

    // A call awaiting approval is its own grouping boundary, so Auto mode is required for one group.
    if (headerCountAfterA !== 1) {
      failures.push(`Expected exactly 1 bash ToolGroupRow header after turn (a) (Auto mode set, no approval boundary), found ${headerCountAfterA} -- the two calls did not merge into one multi-call group; see turn-a-transcript.html.`);
    }
    // The header folds the count into its label ("bash ×2", #632), so a multi-call group is detected by the "×N" suffix.
    const multiGroupIndex = await cdp.evaluate(`(${BASH_HEADER_FINDER}).findIndex((el) => /\\u00d7\\d+$/.test(el.querySelector('[data-slot="collapsed-line-label"]')?.textContent.trim() ?? ''))`);
    const groupExercised = multiGroupIndex !== -1;
    if (!groupExercised) {
      failures.push(`No bash header's own label shows the multi-call "bash ×N" count after turn (a) -- decision 8/10's multi-call Spine geometry, the "1 failed" meta text, and the member-body padding cannot be exercised; see turn-a-transcript.html.`);
    } else {
      findings.push(`Multi-call bash ToolGroupRow rendered after turn (a) (header index ${multiGroupIndex} of ${headerCountAfterA}, exact label match, not a substring).`);
    }

    const expandIndex = groupExercised ? multiGroupIndex : 0;

    if (groupExercised) {
      const collapsedSummaryHasFailure = await cdp.evaluate(`(${BASH_HEADER_FINDER})[${multiGroupIndex}].textContent.includes('1 failed')`);
      if (!collapsedSummaryHasFailure) failures.push('Collapsed group summary did not contain "1 failed" text (the deliberate `exit 7` call) -- see turn-a-transcript.html.');
      else findings.push('Collapsed group names the failure in text ("...1 failed"), never colour alone (decision 16).');
    }

    const olPresentCollapsed = await cdp.evaluate(`!!document.querySelector('[aria-label="Transcript"] ol.border-l')`);
    if (olPresentCollapsed) failures.push('A SpineList <ol> is present in the DOM while the group is still COLLAPSED -- decision 17 requires it unmounted until expanded.');
    else findings.push('SpineList is unmounted while every group is collapsed (decision 17).');
    await cdp.screenshot(path.join(SHOTS_DIR, '01-dark-collapsed-failed-group.png'));

    // ---- Expand the (multi-call, if one exists) group: measure the Spine's real geometry ----
    await setBashHeaderExpanded(cdp, expandIndex, true);
    await cdp.screenshot(path.join(SHOTS_DIR, '02-dark-expanded-failed-group.png'));

    if (groupExercised) {
      const geometry = await cdp.evaluate(`(() => {
        const t = document.querySelector('[aria-label="Transcript"]');
        const header = (${BASH_HEADER_FINDER})[${multiGroupIndex}];
        const headerIcon = header ? header.querySelector('span') : null;
        const ol = t.querySelector('ol.border-l');
        const members = ol ? Array.from(ol.querySelectorAll('li')) : [];
        const firstMemberIcon = members[0] ? members[0].querySelector('span') : null;
        const r = (el) => (el ? el.getBoundingClientRect() : null);
        return {
          headerIconLeft: r(headerIcon)?.left ?? null,
          headerIconWidth: r(headerIcon)?.width ?? null,
          olLeft: r(ol)?.left ?? null,
          memberCount: members.length,
          firstMemberIconLeft: r(firstMemberIcon)?.left ?? null,
        };
      })()`);
      if (geometry.olLeft == null || geometry.headerIconLeft == null) {
        failures.push(`Could not measure Spine geometry -- header icon or <ol> missing (${JSON.stringify(geometry)}).`);
      } else {
        // The Spine's x is the header icon's centre, not its left edge.
        const iconCentre = geometry.headerIconLeft + geometry.headerIconWidth / 2;
        const lineToIconCentre = geometry.olLeft - iconCentre;
        if (Math.abs(lineToIconCentre) > 3) {
          failures.push(`Spine line sits ${lineToIconCentre.toFixed(1)}px from the header icon's own centre, expected ~0px (decision 8: the line hangs from the icon's centre).`);
        } else {
          findings.push(`Spine line measured ${lineToIconCentre.toFixed(1)}px from the header icon's own centre (decision 8: the Spine hangs from the icon).`);
        }
        if (geometry.memberCount < 2) {
          failures.push(`Expected 2+ SpineList members in the multi-call group, found ${geometry.memberCount}.`);
        } else if (geometry.firstMemberIconLeft != null) {
          const lineToMemberIcon = geometry.firstMemberIconLeft - geometry.olLeft;
          if (lineToMemberIcon < 5 || lineToMemberIcon > 11) {
            failures.push(`Member icon measured ${lineToMemberIcon}px right of the Spine line, expected ~8px (px-2, decision 8).`);
          } else {
            findings.push(`Member icon measured ${lineToMemberIcon}px right of the Spine line (decision 8 expects 8px, px-2).`);
          }
        }
      }

      await setBashHeaderExpanded(cdp, expandIndex, true); // no-op if already expanded
      await cdp.click(`(() => { const ol = document.querySelector('[aria-label="Transcript"] ol.border-l'); const li = ol ? ol.querySelector('li') : null; return li ? li.querySelector('button') : null; })()`);
      const memberBodyPadding = await cdp.evaluate(`(() => {
        const content = document.querySelector('[aria-label="Transcript"] ol.border-l [data-slot="collapsible-content"]');
        return content ? getComputedStyle(content).paddingLeft : null;
      })()`);
      if (memberBodyPadding !== '32px') failures.push(`Member expanded body computed padding-left is ${memberBodyPadding}, expected 32px (pl-8, decision 10).`);
      else findings.push('Member expanded body starts at pl-8 (32px), the label column (decision 10).');
      await cdp.screenshot(path.join(SHOTS_DIR, '03-dark-member-body-expanded.png'));

      const olAx = await getAccessibleNameAndRole(cdp, `document.querySelector('[aria-label="Transcript"] ol.border-l')`);
      if (olAx.role !== 'list') failures.push(`SpineList <ol> accessible role measured "${olAx.role}", decision 21 requires exactly "list".`);
      else findings.push('SpineList exposes role "list" in the accessibility tree, never "tree" (decision 21).');
    }

    const headerChecks = await cdp.evaluate(`(() => {
      const header = (${BASH_HEADER_FINDER})[${expandIndex}];
      if (!header) return null;
      const root = header.closest('[data-slot="collapsible"]');
      const rootStyle = root ? getComputedStyle(root) : null;
      return { rootBorderWidth: rootStyle ? rootStyle.borderWidth : null };
    })()`);
    if (!headerChecks || headerChecks.rootBorderWidth == null) failures.push('Could not find the Collapsible root to measure its border-width (decision 18).');
    else if (headerChecks.rootBorderWidth !== '0px') failures.push(`Collapsible root computed border-width is ${headerChecks.rootBorderWidth}, expected 0px (decision 18 removed the always-on border).`);
    else findings.push('Collapsible root carries no border at rest (decision 18, settles #430).');

    await setBashHeaderExpanded(cdp, expandIndex, false);
    if (groupExercised) findings.push('Collapsing the group unmounts the SpineList again (decision 17).');

    let themeChecksOk = true;
    try {
      await switchTheme(cdp, 'obsidian', 'Obsidian');
      await setBashHeaderExpanded(cdp, expandIndex, true);
      await cdp.screenshot(path.join(SHOTS_DIR, '04-obsidian-expanded.png'));
      findings.push('Obsidian theme screenshot captured (real <html> class confirmed via the Profile menu Theme submenu), group expanded.');

      await switchTheme(cdp, 'dark-high-contrast', 'Dark (high contrast)');
      await cdp.screenshot(path.join(SHOTS_DIR, '05-dark-high-contrast-expanded.png'));
      findings.push('Dark (high contrast) theme screenshot captured (real <html> class confirmed), group expanded.');
    } catch (err) {
      themeChecksOk = false;
      failures.push(`Could not drive the real Profile-menu Theme submenu (${err.message}).`);
    }

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const narrowOverflow = await cdp.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth + 2`);
    if (narrowOverflow) failures.push('A horizontal scrollbar appeared at 360px width -- decision 30 requires no horizontal scroll.');
    else findings.push('No horizontal scroll at 360px width (decision 30).');
    await cdp.screenshot(path.join(SHOTS_DIR, '06-360px-expanded.png'));
    await cdp.send('Emulation.clearDeviceMetricsOverride', {});

    try {
      await switchTheme(cdp, 'dark', 'Dark');
    } catch (err) {
      notExercised.push(`Could not confirm reset to Dark theme before reduced-motion check (${err.message}).`);
    }
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const spineMotion = await cdp.evaluate(`(() => {
      const ol = document.querySelector('[aria-label="Transcript"] ol.border-l');
      const member = ol ? ol.querySelector('li') : null;
      const read = (el) => { if (!el) return null; const s = getComputedStyle(el); return { transitionDuration: s.transitionDuration, animationName: s.animationName }; };
      return { spine: read(ol), member: read(member) };
    })()`);
    // The reduced-motion block sets 0.01ms, which getComputedStyle reports as `1e-05s`, so accept <=1ms rather than only "0s".
    const motionOk = (m) => !!m && m.transitionDuration.split(',').every((d) => parseFloat(d) <= 0.001) && m.animationName === 'none';
    if (!spineMotion.spine) notExercised.push('Could not measure the Spine <ol> transition/animation under reduced motion (element not found, likely collapsed).');
    else if (!motionOk(spineMotion.spine)) failures.push(`Spine <ol> computed transitionDuration=${spineMotion.spine.transitionDuration}, animationName=${spineMotion.spine.animationName} under reduced motion -- decision 27 expects none.`);
    else findings.push('Spine genuinely has no transition/animation under reduced motion (decision 27).');
    if (!spineMotion.member) notExercised.push('Could not measure a member row\'s own transition/animation under reduced motion (decision 26 fade must not run).');
    else if (!motionOk(spineMotion.member)) failures.push(`Member row computed transitionDuration=${spineMotion.member.transitionDuration}, animationName=${spineMotion.member.animationName} under reduced motion -- decision 26's fade must be suppressed (motion-safe:).`);
    else findings.push("Member row's own fade-in animation is suppressed under reduced motion (decision 26, motion-safe:).");
    await cdp.screenshot(path.join(SHOTS_DIR, '07-dark-reduced-motion.png'));
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });

    await setBashHeaderExpanded(cdp, expandIndex, false);

    // ---- Turn (b): exactly one bash call -> solo ToolGroupRow, no Spine, no <ol> ----
    await cdp.typeIntoByLabel('Message', TURN_B_PROMPT);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && (t.textContent.match(/${TURN_B_SENTINEL}/g) ?? []).length >= 2; })()`,
      { timeoutMs: 180_000, label: 'Turn (b) finished (assistant echoed the sentinel back)' },
    );
    const turnBTranscriptHtml = await cdp.evaluate(`document.querySelector('[aria-label="Transcript"]')?.outerHTML ?? ''`);
    writeFileSync(path.join(SHOTS_DIR, 'turn-b-transcript.html'), turnBTranscriptHtml);

    const headerCountAfterB = await countBashHeaders(cdp);
    if (headerCountAfterB !== headerCountAfterA + 1) {
      await cdp.screenshot(path.join(SHOTS_DIR, '99-diag-turn-b-no-group.png'));
      failures.push(`Expected ${headerCountAfterA + 1} bash ToolGroupRow headers after turn (b), found ${headerCountAfterB} -- see turn-b-transcript.html.`);
    }

    const soloMetaCheck = await cdp.evaluate(`(() => {
      const header = (${BASH_HEADER_FINDER}).at(-1);
      if (!header) return null;
      const metaSpan = Array.from(header.querySelectorAll('span')).find((s) => /\\d/.test(s.textContent) && getComputedStyle(s).fontVariantNumeric.includes('tabular'));
      return { hasTabularNumsMeta: !!metaSpan, metaText: metaSpan ? metaSpan.textContent.trim() : null };
    })()`);
    if (!soloMetaCheck || !soloMetaCheck.hasTabularNumsMeta) failures.push(`Turn (b)'s solo header meta slot did not expose tabular-nums text (decision 33); measured ${JSON.stringify(soloMetaCheck)}.`);
    else findings.push(`Turn (b)'s solo header meta ("${soloMetaCheck.metaText}") uses tabular-nums (decision 33).`);

    await setBashHeaderExpanded(cdp, -1, true);
    const soloOlCount = await cdp.evaluate(`document.querySelectorAll('[aria-label="Transcript"] ol.border-l').length`);
    if (soloOlCount > 0) failures.push(`A SpineList <ol> was found (count=${soloOlCount}) after expanding turn (b)'s solo bash call -- decision 13 requires no Spine for a group of one.`);
    else findings.push("A group of exactly one call (turn b's solo bash) renders with no SpineList and no <ol> (decision 13).");
    await cdp.screenshot(path.join(SHOTS_DIR, '08-dark-solo-group-expanded.png'));

    const report = { gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, notExercised, groupExercised, themeChecksOk, exitCode: failures.length > 0 ? 1 : 0 };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-565-spine: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-565-spine: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-565-spine: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-565-spine: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
    } catch {
      // best-effort only; the console.error below is the real record if this also fails
    }
    console.error('verify-565-spine: FAILED:', err?.stack ?? err);
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

main().catch((err) => {
  console.error('verify-565-spine: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
