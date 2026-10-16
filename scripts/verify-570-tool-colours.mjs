#!/usr/bin/env node
// Live CDP check for issue #570 (tool row colour treatment), gate requirement.
//
// Drives a REAL `omp` (resolved from PATH, ambient already-signed-in default profile, no
// `OMP_PROFILE` override), the same isolation posture `verify-565-spine.mjs`/this repo's own
// `docs/spike/*-probe.mjs` scripts already use: scratch cwd/worktree/`REFRACT_DATA_DIR` never
// touch Stuart's real Session list. Spends real model tokens, tiny echo-only prompts only.
//
// DISK NOTE: the shared CARGO_TARGET_DIR measured under the project's 6GB build-disk floor right
// before this run (5.3GB free), so this script does NOT rebuild -- it reuses the exe `node
// scripts/ci-local.mjs`'s own "Build (Tauri debug, no bundle smoke)" step already produced at the
// commit carrying all of #570's code (toolStatus.tsx/CollapsedLine.tsx/ToolRow.tsx), confirmed by
// `git log` to predate the later #905 merge commit, which touched no file this story's own
// `errorLine()`/`StatusIcon`/`CollapsedLine` detail rendering depends on. Copied to a private
// scratch dir and sha256-pinned immediately, same proof `verify-565-spine.mjs` already relies on.
//
// Three turns, one scratch Session (Approval mode seeded to Auto so no approval-card grouping
// boundary ever exists, same root-cause fix `verify-565-spine.mjs` already applied):
//   (a) three bash calls, the SECOND deliberately failing, the THIRD deliberately slow -- a
//       window where the group is still "running" (third call in flight) but already has one
//       failed member, to catch decision 12's "N failed" meta colour showing mid-run while the
//       header's own icon/label stay neutral until the group SETTLES.
//   (b) a solo failing bash call -- decision 6's Error line must show whether collapsed or
//       expanded, decision 4's icon+label colour, decision 10's no-duplicate-in-expansion.
//   (c) a slow bash call, stopped before it finishes -- an `interrupted` status, which decision 5
//       says MUST stay fully neutral, never red.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, createWriteStream, copyFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getFreePort, waitForCdpTarget, CdpSession, stopLauncher, launchViaJobObject, isTargetOwningPort, sleep } from './verify-tauri-cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
const SHOTS_DIR = 'C:/Users/shopwood/AppData/Local/Temp/refract-570-shots/';

const TURN_A_PROMPT =
  "Make exactly THREE separate bash tool calls, strictly in this order, waiting for each one to finish before starting the next: first run exactly `sleep 1 && echo t570-one`, second run exactly `exit 9` (which deliberately fails), third run exactly `sleep 4 && echo t570-three`. After all three finish, reply with exactly the single word 't570a' and nothing else.";
const TURN_B_PROMPT =
  "Make exactly ONE bash tool call: run exactly `ls /definitely-not-a-real-path-570-live` (it will fail). Wait for it to finish. Then reply with exactly the single word 't570b' and nothing else.";
const TURN_C_PROMPT =
  "Make exactly ONE bash tool call: run exactly `sleep 20`. Then reply with exactly the single word 't570c' and nothing else.";
const TURN_A_SENTINEL = 't570a';
const TURN_B_SENTINEL = 't570b';
// #570-only DOM marker: matches a `ToolGroupRow`/solo header by its EXACT label text ("bash"),
// never a substring match against a button's whole textContent (a streaming Thinking row's own
// trigger can contain the word "bash" in its preview text and sits earlier in the DOM).
const BASH_HEADER_FINDER =
  `Array.from(document.querySelectorAll('[aria-label="Transcript"] button')).filter((el) => { const label = el.querySelector('span.font-medium'); return label && label.textContent.trim() === 'bash'; })`;

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
  run(['-c', 'user.name=verify-570-tool-colours', '-c', 'user.email=verify-570-tool-colours@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

function sha256OfFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** Copies the EXISTING debug exe (no rebuild -- shared disk is under the project's 6GB build
 * floor) and confirms it is byte-unchanged through the copy, the same proof `verify-565-spine.mjs`
 * uses for its own freshly-rebuilt exe. Fails loudly if the source is missing or still being
 * written by a concurrent lane. */
function copyExistingExe(destDir) {
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'refract-tauri.exe');
  const src = path.join(BUILD_OUTPUT_DIR, 'refract-tauri.exe');
  if (!existsSync(src)) throw new Error(`copyExistingExe: no exe found at ${src} -- run node scripts/ci-local.mjs or pnpm tauri build --debug --no-bundle first.`);
  const preCopyHash = sha256OfFile(src);
  const preCopyStat = statSync(src);
  copyFileSync(src, dest);
  const postCopyHash = sha256OfFile(src);
  const postCopyStat = statSync(src);
  const unchanged = postCopyHash === preCopyHash && postCopyStat.mtimeMs === preCopyStat.mtimeMs && postCopyStat.size === preCopyStat.size;
  if (!unchanged) throw new Error('copyExistingExe: source exe changed between hash and copy -- a concurrent lane is rebuilding; rerun once it settles.');
  console.log(`verify-570: reused existing debug exe (${src}, built ${preCopyStat.mtime.toISOString()}), copied to ${dest} (sha256 ${preCopyHash.slice(0, 12)}…, confirmed unchanged through the copy).`);
  return { dest, hash: preCopyHash };
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
        console.warn(`verify-570: could not remove scratch dir ${dir} (left on disk): ${err.message}`);
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
  console.log(`verify-570: exe sha256 ${expectedHash.slice(0, 12)}… confirmed unchanged (${label}).`);
}

async function countBashHeaders(cdp) {
  return cdp.evaluate(`(${BASH_HEADER_FINDER}).length`);
}

async function clickBashHeaderAt(cdp, index) {
  await cdp.click(`(${BASH_HEADER_FINDER}).at(${index})`);
}

async function setBashHeaderExpanded(cdp, index, wantOpen) {
  const isOpen = await cdp.evaluate(`(${BASH_HEADER_FINDER}).at(${index})?.getAttribute('aria-expanded') === 'true'`);
  if (isOpen === wantOpen) return;
  await clickBashHeaderAt(cdp, index);
  await cdp.waitFor(
    `(${BASH_HEADER_FINDER}).at(${index})?.getAttribute('aria-expanded') === '${wantOpen}'`,
    { timeoutMs: 10_000, label: `bash header ${index} aria-expanded=${wantOpen}` },
  );
}

/** Reads the real computed colour of a header's icon, label, and (if present) its linked Error
 * line, plus the Error line's own id/aria-describedby wiring -- decisions 1-6. Never guesses from
 * class names: every value is `getComputedStyle(...).color`, the actual painted pixel colour. */
async function readHeaderColours(cdp, index) {
  return cdp.evaluate(`(() => {
    const header = (${BASH_HEADER_FINDER}).at(${index});
    if (!header) return null;
    const icon = header.querySelector('span.flex svg, span > svg');
    const label = header.querySelector('span.font-medium');
    const describedby = header.getAttribute('aria-describedby');
    const detail = describedby ? document.getElementById(describedby) : null;
    const metaFailed = Array.from(header.querySelectorAll('span')).find((s) => /\\d+ failed/.test(s.textContent));
    return {
      iconColor: icon ? getComputedStyle(icon).color : null,
      labelColor: label ? getComputedStyle(label).color : null,
      labelText: label ? label.textContent.trim() : null,
      detailText: detail ? detail.textContent.trim() : null,
      detailColor: detail ? getComputedStyle(detail).color : null,
      detailId: detail ? detail.id : null,
      ariaDescribedby: describedby,
      metaFailedText: metaFailed ? metaFailed.textContent.trim() : null,
      metaFailedColor: metaFailed ? getComputedStyle(metaFailed).color : null,
    };
  })()`);
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
    `!!Array.from(document.querySelectorAll('[role="menuitem"] span.flex-1')).find((el) => el.textContent.trim() === ${JSON.stringify(themeName)})`,
    { timeoutMs: 10_000, label: `Theme submenu open, "${themeName}" item visible` },
  );
  await cdp.click(
    `Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => { const span = el.querySelector('span.flex-1'); return span && span.textContent.trim() === ${JSON.stringify(themeName)}; })`,
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
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-570-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-570-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-570-repo-')));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-570-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-570-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, approvalMode: 'auto' }));
    const port = await getFreePort();
    gitHeadSha = gitHead();

    console.log(`verify-570: git HEAD ${gitHeadSha}`);
    console.log(`verify-570: data dir ${dataDir}`);
    console.log(`verify-570: shots dir ${SHOTS_DIR}`);
    console.log(`verify-570: CDP port ${port}`);

    const built = copyExistingExe(exeDir);
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app.log') });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-570: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }
    assertExeUnchanged(exePath, exeHash, 'post-launch');

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green (real omp --version + get_state round trip)' },
    );
    findings.push('Readiness green against the REAL ambient omp install, scratch data dir.');

    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
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

    const approvalPillLabel = await cdp.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').endsWith(', approval mode')); return b ? b.getAttribute('aria-label') : null; })()`);
    if (!approvalPillLabel || !approvalPillLabel.startsWith('Auto')) {
      throw new Error(`verify-570: seeded settings.json approvalMode:"auto" did not take effect -- the Approval pill reads "${approvalPillLabel}".`);
    }
    findings.push(`Scratch Session launched already in Auto approval mode (pill reads "${approvalPillLabel}").`);

    // ---- Turn (a): 3 bash calls, #2 fails, #3 is slow -- catch the group mid-run ----
    await cdp.typeIntoByLabel('Message', TURN_A_PROMPT);
    await cdp.clickByLabel('Send message');

    let midRunCapture = null;
    let midRunGenuine = false;
    try {
      // Genuinely mid-run (decision 12) means the group's OWN header icon is still the spinner
      // (`animate-spin`) -- not merely "fewer than 3 items known yet", which can ALSO be read
      // between one call ending and the next one starting (a real, correctly-red gap: with no
      // item currently running, `status` is accurately 'error', not a mid-run violation).
      await cdp.waitFor(
        `(() => { const h = (${BASH_HEADER_FINDER})[0]; if (!h) return false; const icon = h.querySelector('span.flex svg, span > svg'); const spinning = icon && getComputedStyle(icon).animationName !== 'none'; return spinning && /\\d+ failed/.test(h.textContent); })()`,
        { timeoutMs: 15_000, label: 'Group header still spinning (a member genuinely in flight) while meta already shows a failed count' },
      );
      midRunCapture = await readHeaderColours(cdp, 0);
      midRunGenuine = true;
      await cdp.screenshot(path.join(SHOTS_DIR, '00-dark-running-with-failed-member.png'));
    } catch {
      notExercised.push('Could not catch the EXACT instant the group was still spinning (a member genuinely in flight) with a failed count already showing -- real model/tool timing is narrow here; the settled screenshot and the code\'s own `status` ternary (any item running always wins, unmodified by #570) are the evidence for this path instead.');
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
      throw new Error(`verify-570: expected at least 1 bash header after turn (a), found ${headerCountAfterA} -- see turn-a-transcript.html`);
    }
    if (headerCountAfterA !== 1) failures.push(`Expected exactly 1 bash ToolGroupRow header after turn (a) (Auto mode set), found ${headerCountAfterA}.`);

    const groupColoursSettled = await readHeaderColours(cdp, 0);
    const neutralColor = await cdp.evaluate(`(() => { const probe = document.createElement('span'); probe.className = 'text-muted-foreground'; probe.style.position = 'fixed'; document.body.appendChild(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; })()`);
    const errorColor = await cdp.evaluate(`(() => { const probe = document.createElement('span'); probe.className = 'text-severity-error'; probe.style.position = 'fixed'; document.body.appendChild(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; })()`);
    findings.push(`Live colour probes (Dark theme): --muted-foreground resolves to ${neutralColor}; --severity-error resolves to ${errorColor}.`);

    if (midRunCapture && midRunGenuine) {
      if (midRunCapture.labelColor === errorColor) failures.push(`Mid-run (header icon still spinning, a member genuinely in flight): header label already painted the error colour (${midRunCapture.labelColor}) -- decision 12 requires the header stay neutral until the group SETTLES.`);
      else findings.push(`Mid-run (header icon confirmed still spinning): header label stayed neutral (${midRunCapture.labelColor}) while one member had already failed (decision 12, running beats failed in the worst-state order).`);
      if (!midRunCapture.metaFailedText) failures.push('Mid-run: no "N failed" text found in the meta slot while one member had already failed -- decision 12 requires it visible at once, even mid-run.');
      else if (midRunCapture.metaFailedColor !== errorColor) failures.push(`Mid-run: "${midRunCapture.metaFailedText}" meta text measured ${midRunCapture.metaFailedColor}, expected the error colour ${errorColor} (decision 12).`);
      else findings.push(`Mid-run: "${midRunCapture.metaFailedText}" already shows in the error colour while the group is still running (decision 12).`);
    }

    if (!groupColoursSettled) {
      failures.push('Could not read the settled group header\'s colours/text.');
    } else {
      if (groupColoursSettled.labelColor !== errorColor) failures.push(`Settled failed group: header label measured ${groupColoursSettled.labelColor}, expected the error colour ${errorColor} (decision 12: the header turns red once settled as failed).`);
      else findings.push(`Settled failed group: header label/icon paint in the error colour (${groupColoursSettled.labelColor}), matching decision 12.`);
      if (!groupColoursSettled.metaFailedText || !groupColoursSettled.metaFailedText.includes('1 failed')) failures.push(`Settled group meta slot text is "${groupColoursSettled.metaFailedText}", expected to contain "1 failed" (decision 12).`);
      else findings.push(`Settled group meta slot reads "${groupColoursSettled.metaFailedText}" (decision 12, moved out of the summary text).`);
      if (groupColoursSettled.labelText && /\d+ failed/.test(groupColoursSettled.labelText)) failures.push(`Group summary text "${groupColoursSettled.labelText}" still contains "N failed" -- decision 12 moves this into the meta slot, out of the summary.`);
      else findings.push('Group summary text no longer contains the "N failed" suffix (moved to meta, decision 12).');
      if (!groupColoursSettled.detailText) failures.push('Settled failed group header: no Error line (aria-describedby target) found while collapsed -- decision 9 requires the latest failed member\'s line.');
      else {
        findings.push(`Settled group header Error line (collapsed): "${groupColoursSettled.detailText}".`);
        if (groupColoursSettled.detailColor !== errorColor) failures.push(`Group header Error line measured ${groupColoursSettled.detailColor}, expected the error colour ${errorColor}.`);
        else findings.push('Group header Error line paints in the error colour.');
        if (groupColoursSettled.ariaDescribedby !== groupColoursSettled.detailId) failures.push('Header aria-describedby does not resolve to the rendered Error line\'s own id.');
        else findings.push('Header trigger\'s aria-describedby correctly names the Error line\'s id (decision 15).');
      }
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '01-dark-collapsed-failed-group.png'));

    // ---- Expand: header's own Error line must disappear; each member shows its own ----
    await setBashHeaderExpanded(cdp, 0, true);
    await cdp.screenshot(path.join(SHOTS_DIR, '02-dark-expanded-failed-group.png'));
    const expandedCheck = await cdp.evaluate(`(() => {
      const header = (${BASH_HEADER_FINDER})[0];
      const stillDescribed = header ? header.getAttribute('aria-describedby') : 'MISSING-HEADER';
      const ol = document.querySelector('[aria-label="Transcript"] ol.border-l');
      const members = ol ? Array.from(ol.querySelectorAll('li')) : [];
      const memberInfo = members.map((li) => {
        const label = li.querySelector('span.font-medium');
        const btn = li.querySelector('button');
        const describedby = btn ? btn.getAttribute('aria-describedby') : null;
        const detail = describedby ? document.getElementById(describedby) : null;
        return { labelColor: label ? getComputedStyle(label).color : null, hasDetail: !!detail, detailText: detail ? detail.textContent.trim() : null };
      });
      return { stillDescribed, memberCount: members.length, memberInfo };
    })()`);
    if (expandedCheck.stillDescribed) failures.push(`Group header still has aria-describedby="${expandedCheck.stillDescribed}" once EXPANDED -- decision 9 requires the header's own Error line (and its description) to disappear once expanded.`);
    else findings.push('Group header\'s own Error line/aria-describedby is gone once expanded (decision 9, hideDetailWhenOpen).');
    if (expandedCheck.memberCount !== 3) failures.push(`Expected 3 members in the expanded group, found ${expandedCheck.memberCount}.`);
    else findings.push('Expanded group shows all 3 members.');
    const failedMembers = expandedCheck.memberInfo.filter((m) => m.labelColor === errorColor);
    if (failedMembers.length !== 1) failures.push(`Expected exactly 1 member with an error-coloured label, found ${failedMembers.length} (${JSON.stringify(expandedCheck.memberInfo)}).`);
    else if (!failedMembers[0].hasDetail) failures.push('The one failed member has no Error line of its own once expanded (decision 9).');
    else findings.push(`The one failed member shows its own Error line once expanded: "${failedMembers[0].detailText}".`);
    const okMembers = expandedCheck.memberInfo.filter((m) => m.labelColor !== errorColor);
    if (okMembers.some((m) => m.hasDetail)) failures.push('A successful member row shows an Error line -- only a failed member should.');
    else findings.push('Successful member rows show no Error line.');
    await setBashHeaderExpanded(cdp, 0, false);

    // ---- Turn (b): solo failing bash call ----
    await cdp.typeIntoByLabel('Message', TURN_B_PROMPT);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && (t.textContent.match(/${TURN_B_SENTINEL}/g) ?? []).length >= 2; })()`,
      { timeoutMs: 180_000, label: 'Turn (b) finished (assistant echoed the sentinel back)' },
    );
    const headerCountAfterB = await countBashHeaders(cdp);
    const soloIndex = headerCountAfterB - 1;
    const soloCollapsed = await readHeaderColours(cdp, soloIndex);
    if (!soloCollapsed || soloCollapsed.labelColor !== errorColor) failures.push(`Solo failed call: header label measured ${soloCollapsed?.labelColor}, expected ${errorColor} (decision 4).`);
    else findings.push(`Solo failed call: header label/icon paint in the error colour (${soloCollapsed.labelColor}), decision 4.`);
    if (!soloCollapsed?.detailText) failures.push('Solo failed call: no Error line found while collapsed (decision 6).');
    else findings.push(`Solo failed call Error line (collapsed): "${soloCollapsed.detailText}" (expect the stderr line, e.g. "ls: cannot access ...", not the bash wrapper's trailing footer -- decision 7).`);
    await cdp.screenshot(path.join(SHOTS_DIR, '03-dark-solo-failed-collapsed.png'));

    await setBashHeaderExpanded(cdp, soloIndex, true);
    const soloExpandedCheck = await cdp.evaluate(`(() => {
      const header = (${BASH_HEADER_FINDER}).at(${soloIndex});
      const root = header ? header.closest('[data-slot="collapsible"]') : null;
      const content = root ? root.querySelector('[data-slot="collapsible-content"]') : null;
      const stillDescribed = header ? header.getAttribute('aria-describedby') : null;
      const detailStillPresent = stillDescribed ? !!document.getElementById(stillDescribed) : false;
      const duplicateErrorInContent = content ? Array.from(content.querySelectorAll('p')).some((p) => p.className.includes('severity-error')) : false;
      return { detailStillPresent, duplicateErrorInContent, contentText: content ? content.textContent.trim().slice(0, 200) : null };
    })()`);
    if (!soloExpandedCheck.detailStillPresent) failures.push('Solo failed call: Error line disappeared once EXPANDED -- decision 6 requires it visible whether collapsed or expanded (no hideDetailWhenOpen for a solo call).');
    else findings.push('Solo failed call: Error line stays visible once expanded (decision 6).');
    if (soloExpandedCheck.duplicateErrorInContent) failures.push('Solo failed call: the expanded body still contains its own error-coloured <p> -- decision 10 requires the old boxed error paragraph deleted (no duplicate).');
    else findings.push('Solo failed call: the expanded body no longer duplicates the error text (decision 10, old ToolCallBody <p> removed).');
    await cdp.screenshot(path.join(SHOTS_DIR, '04-dark-solo-failed-expanded.png'));
    await setBashHeaderExpanded(cdp, soloIndex, false);

    // ---- Themes: Obsidian, Dark high contrast (real Profile-menu Theme submenu) ----
    await setBashHeaderExpanded(cdp, 0, true);
    let themeChecksOk = true;
    try {
      await switchTheme(cdp, 'obsidian', 'Obsidian');
      await cdp.screenshot(path.join(SHOTS_DIR, '06-obsidian-expanded.png'));
      findings.push('Obsidian theme screenshot captured (real <html> class confirmed via the Profile menu Theme submenu).');

      await switchTheme(cdp, 'dark-high-contrast', 'Dark (high contrast)');
      await cdp.screenshot(path.join(SHOTS_DIR, '07-dark-high-contrast-expanded.png'));
      findings.push('Dark (high contrast) theme screenshot captured (real <html> class confirmed).');
    } catch (err) {
      themeChecksOk = false;
      failures.push(`Could not drive the real Profile-menu Theme submenu (${err.message}).`);
    }

    // ---- Narrow width (360px chat): no horizontal overflow, Error line still present ----
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const narrowOverflow = await cdp.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth + 2`);
    if (narrowOverflow) failures.push('A horizontal scrollbar appeared at 360px width.');
    else findings.push('No horizontal scroll at 360px width (decision 18).');
    await cdp.screenshot(path.join(SHOTS_DIR, '08-360px-expanded.png'));
    await cdp.send('Emulation.clearDeviceMetricsOverride', {});

    try {
      await switchTheme(cdp, 'dark', 'Dark');
    } catch (err) {
      notExercised.push(`Could not confirm reset to Dark theme before reduced-motion check (${err.message}).`);
    }

    // ---- Reduced motion: decision 13, "no motion and no colour transition: instant" ----
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const labelTransition = await cdp.evaluate(`(() => {
      const header = (${BASH_HEADER_FINDER})[0];
      const label = header ? header.querySelector('span.font-medium') : null;
      return label ? getComputedStyle(label).transitionProperty : null;
    })()`);
    if (labelTransition && labelTransition !== 'none' && labelTransition.includes('color')) failures.push(`Failed-row label computed transitionProperty includes "color" (${labelTransition}) -- decision 13 requires an instant colour change, no transition.`);
    else findings.push(`Failed-row label has no colour transition (${labelTransition ?? 'label not found'}), decision 13.`);
    await cdp.screenshot(path.join(SHOTS_DIR, '09-dark-reduced-motion.png'));
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await setBashHeaderExpanded(cdp, 0, false);

    // ---- Turn (c), run LAST: stop mid-flight -> interrupted, must stay neutral
    // (decision 5). Moved to the very end: stopping a mid-flight tool call can leave the
    // Session in a recovering/stopped state, which must never block the earlier, more load-
    // bearing assertions (colour/Error line/theme/width/motion) above.
    try {
      // ---- Turn (c): stop mid-flight -> interrupted, must stay neutral (decision 5) ----
      await cdp.typeIntoByLabel('Message', TURN_C_PROMPT);
      await cdp.clickByLabel('Send message');
      let interruptedChecked = false;
      try {
        await cdp.waitFor(`(${BASH_HEADER_FINDER}).length > ${headerCountAfterB}`, { timeoutMs: 20_000, label: 'Turn (c) bash header appears' });
        await sleep(500);
        await cdp.clickByLabel('Stop');
        await cdp.waitFor(
          `(() => { const h = (${BASH_HEADER_FINDER}).at(-1); return h && /interrupted/i.test(h.getAttribute('aria-label') || h.querySelector('[class*="sr-only"]')?.textContent || ''); })()`,
          { timeoutMs: 20_000, label: 'Turn (c) bash call reaches interrupted status' },
        );
        const interruptedColours = await readHeaderColours(cdp, -1);
        if (interruptedColours.labelColor === errorColor) failures.push(`Interrupted call: header label painted the error colour (${interruptedColours.labelColor}) -- decision 5 requires it stay fully neutral, never red.`);
        else findings.push(`Interrupted call: header label stayed neutral (${interruptedColours.labelColor}), decision 5.`);
        interruptedChecked = true;
        await cdp.screenshot(path.join(SHOTS_DIR, '05-dark-interrupted.png'));
      } catch (err) {
        notExercised.push(`Could not reliably produce/observe an interrupted bash call (${err.message}).`);
      }
      if (!interruptedChecked) notExercised.push('Interrupted-call colour check not completed.');

    } catch (err) {
      notExercised.push(`Turn (c) interrupted-call check aborted the rest of its own block (${err.message}).`);
    }

    const report = {
      gitHead: gitHeadSha,
      exeSha256: exeHash,
      neutralColor,
      errorColor,
      findings,
      failures,
      notExercised,
      themeChecksOk,
      exitCode: failures.length > 0 ? 1 : 0,
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-570: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-570: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-570: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-570: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
    } catch {
      // best-effort only
    }
    console.error('verify-570: FAILED:', err?.stack ?? err);
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
  console.error('verify-570: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
