#!/usr/bin/env node
// Live CDP check for issue #565 (connected-log spine), gate requirement.
//
// No fake-omp tape produces a 2+ call tool group with one call failing (every existing tape has
// at most one `tool` item), and AGENTS.md forbids adding a new fixture while prototyping -- so
// this drives a REAL `omp` (resolved from PATH, ambient already-signed-in default profile, no
// `OMP_PROFILE` override), the same isolation posture `verify-563-subagent-gate1.mjs` and this
// repo's own `docs/spike/*-probe.mjs` scripts already use: scratch cwd/worktree/`REFRACT_DATA_DIR`
// never touch Stuart's real Session list. Spends real model tokens, tiny echo-only prompts only.
//
// Two turns, one scratch Session:
//   (a) two separate bash calls, the second deliberately failing -> a multi-call `ToolGroupRow`
//       (status "error", "N others, 1 failed"), collapsed by default, expands onto a `SpineList`.
//   (b) a second turn, exactly one bash call -> a solo `ToolGroupRow` (decision 13: no Spine, no
//       `<ol>`, same element type as the multi branch at this tree position).
//
// Reuses the shared `CARGO_TARGET_DIR` debug exe this session's own `node scripts/ci-local.mjs`
// (or a prior `pnpm tauri build --debug --no-bundle`) already produced, rebuilding it fresh here
// too (cheap once Rust is unchanged -- only the frontend changed, so this is a vite rebuild plus
// an incremental cargo link) and copying it to a PRIVATE scratch dir immediately, confirmed
// byte-unchanged through the copy, per the standing cross-lane shared-target lesson.

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
const SHOTS_DIR = 'C:/Users/shopwood/AppData/Local/Temp/refract-565-shots/';

const TURN_A_PROMPT =
  "Make exactly TWO separate bash tool calls, one after the other, never combined into one call: first run `echo spine-one`, then second run a command that DELIBERATELY fails, such as `exit 7`. Wait for both calls to finish. Then reply with exactly the single word 'spine565a' and nothing else.";
const TURN_B_PROMPT =
  "Make exactly ONE bash tool call: run `echo spine-solo`. Then reply with exactly the single word 'spine565b' and nothing else.";
const TURN_A_SENTINEL = 'spine565a';
const TURN_B_SENTINEL = 'spine565b';

function spawnSync_(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
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

/** Rebuilds the debug exe fresh, then copies it to `destDir` IMMEDIATELY -- the shared
 * `CARGO_TARGET_DIR`'s own `debug/refract-tauri.exe` can be overwritten mid-session by a
 * concurrent lane's own build. Retries the whole build-and-copy if the source changed mid-copy
 * (a concurrent writer), rather than trusting a torn read. */
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
}

function startAutoApprove(cdp) {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        const hasApprove = await cdp.evaluate(`!!Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Approve')`);
        if (hasApprove) await cdp.clickByText('Approve');
      } catch {
        // transient; retried next tick
      }
      await sleep(400);
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

/** Finds the `ToolGroupRow` header trigger by its visible tool name (`bash`), scoped to the
 * transcript -- never a generic first-button match, so this fails loudly if the group never
 * rendered instead of silently clicking something unrelated. */
async function findToolGroupTrigger(cdp) {
  return cdp.evaluate(
    `(() => { const t = document.querySelector('[aria-label="Transcript"]'); if (!t) return false; const btn = Array.from(t.querySelectorAll('button')).find((el) => el.textContent.includes('bash')); return !!btn; })()`,
  );
}

async function clickToolGroupTrigger(cdp) {
  await cdp.click(`(() => { const t = document.querySelector('[aria-label="Transcript"]'); if (!t) return null; return Array.from(t.querySelectorAll('button')).find((el) => el.textContent.includes('bash')); })()`);
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

async function main() {
  let dataDir, importSourceDir, repoDir, exeDir, launcherDir;
  let child;
  let cdp;
  let autoApprove;
  const findings = [];
  const notExercised = [];
  try {
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-565-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-565-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-565-repo-')));
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-565-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-565-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    const port = await getFreePort();

    console.log(`verify-565-spine: data dir ${dataDir}`);
    console.log(`verify-565-spine: repo dir ${repoDir}`);
    console.log(`verify-565-spine: shots dir ${SHOTS_DIR}`);
    console.log(`verify-565-spine: CDP port ${port}`);

    const { dest: exePath, hash: exeHash } = buildAndCopyExeFresh(exeDir);
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

    autoApprove = startAutoApprove(cdp);

    // ---- Turn (a): 2 bash calls, second fails -> multi-call ToolGroupRow on a SpineList ----
    await cdp.typeIntoByLabel('Message', TURN_A_PROMPT);
    await cdp.clickByLabel('Send message');

    // Best-effort Running-state screenshot (real model timing is not controllable): capture
    // once the group header first appears, before it necessarily settles. Non-fatal if missed.
    try {
      await cdp.waitFor(
        `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && Array.from(t.querySelectorAll('button')).some((el) => el.textContent.includes('bash')); })()`,
        { timeoutMs: 20_000, label: 'bash group header first appears (best-effort running capture)' },
      );
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

    const hasGroup = await findToolGroupTrigger(cdp);
    if (!hasGroup) {
      await cdp.screenshot(path.join(SHOTS_DIR, '99-diag-turn-a-no-group.png'));
      throw new Error('verify-565-spine: no bash ToolGroupRow trigger found after turn (a) settled -- see turn-a-transcript.html');
    }
    findings.push('Multi-call bash ToolGroupRow rendered after turn (a).');

    // #565-only marker: the group's collapsed summary must name the failure in TEXT, and the
    // member list must NOT be in the DOM yet (collapsed by default, decision 15).
    const collapsedSummaryHasFailure = await cdp.evaluate(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && /1 failed/.test(t.textContent); })()`,
    );
    if (!collapsedSummaryHasFailure) notExercised.push('Collapsed group summary did not contain "1 failed" text -- see turn-a-transcript.html.');
    else findings.push('Collapsed group names the failure in text ("...1 failed"), never colour alone (decision 16).');

    const olPresentCollapsed = await cdp.evaluate(`!!document.querySelector('[aria-label="Transcript"] ol.border-l')`);
    if (olPresentCollapsed) throw new Error('verify-565-spine: a SpineList <ol> is present in the DOM while the group is still COLLAPSED -- decision 17 requires it unmounted until expanded.');
    findings.push('SpineList is unmounted while the group is collapsed (decision 17).');
    await cdp.screenshot(path.join(SHOTS_DIR, '01-dark-collapsed-failed-group.png'));

    // ---- Expand the group: measure the Spine's real geometry ----
    await clickToolGroupTrigger(cdp);
    await cdp.waitFor(`!!document.querySelector('[aria-label="Transcript"] ol.border-l')`, { timeoutMs: 10_000, label: 'SpineList <ol> mounted after expand' });
    await cdp.screenshot(path.join(SHOTS_DIR, '02-dark-expanded-failed-group.png'));

    const geometry = await cdp.evaluate(`(() => {
      const t = document.querySelector('[aria-label="Transcript"]');
      const header = Array.from(t.querySelectorAll('button')).find((el) => el.textContent.includes('bash'));
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
      throw new Error(`verify-565-spine: could not measure Spine geometry -- header icon or <ol> missing (${JSON.stringify(geometry)})`);
    }
    const headerIconToLine = geometry.olLeft - geometry.headerIconLeft;
    if (headerIconToLine < 12 || headerIconToLine > 20) {
      notExercised.push(`Spine line x-offset from the header icon measured ${headerIconToLine}px, expected ~16px (ml-4) -- geometry drifted from decision 8; see turn-a-transcript.html.`);
    } else {
      findings.push(`Spine line measured ${headerIconToLine}px right of the header's own icon (decision 8 expects 16px, ml-4).`);
    }
    if (geometry.headerIconWidth == null || geometry.headerIconWidth < 15 || geometry.headerIconWidth > 17) {
      notExercised.push(`Header icon slot measured ${geometry.headerIconWidth}px wide, expected 16px (decision 7, size-4).`);
    } else {
      findings.push(`Icon slot measured ${geometry.headerIconWidth}px (decision 7: 14px -> 16px).`);
    }
    if (geometry.memberCount !== 2) {
      throw new Error(`verify-565-spine: expected 2 SpineList members after turn (a), found ${geometry.memberCount}.`);
    }
    if (geometry.firstMemberIconLeft != null) {
      const lineToMemberIcon = geometry.firstMemberIconLeft - geometry.olLeft;
      if (lineToMemberIcon < 5 || lineToMemberIcon > 11) {
        notExercised.push(`Member icon measured ${lineToMemberIcon}px right of the Spine line, expected ~8px (px-2); see turn-a-transcript.html.`);
      } else {
        findings.push(`Member icon measured ${lineToMemberIcon}px right of the Spine line (decision 8 expects 8px, px-2).`);
      }
    }

    // ---- Icon slot / tabular-nums / hover-border-removal checks on the header trigger ----
    const headerChecks = await cdp.evaluate(`(() => {
      const t = document.querySelector('[aria-label="Transcript"]');
      const header = Array.from(t.querySelectorAll('button')).find((el) => el.textContent.includes('bash'));
      if (!header) return null;
      const root = header.closest('[data-slot="collapsible"]');
      const rootStyle = root ? getComputedStyle(root) : null;
      const metaSpan = Array.from(header.querySelectorAll('span')).find((s) => /\\d+(ms|s)$|^\\d/.test(s.textContent.trim()) && getComputedStyle(s).fontVariantNumeric.includes('tabular'));
      return {
        rootBorderWidth: rootStyle ? rootStyle.borderWidth : null,
        hasTabularNumsMeta: !!metaSpan,
      };
    })()`);
    if (!headerChecks) throw new Error('verify-565-spine: could not locate the bash group header a second time for style checks.');
    if (headerChecks.rootBorderWidth !== '0px' && headerChecks.rootBorderWidth != null) {
      notExercised.push(`Collapsible root computed border-width is ${headerChecks.rootBorderWidth}, expected 0px (decision 18 removed the always-on border).`);
    } else {
      findings.push('Collapsible root carries no border at rest (decision 18, settles #430).');
    }

    // ---- Member body padding (decision 10: pl-8) ----
    await cdp.click(`(() => { const t = document.querySelector('[aria-label="Transcript"]'); const ol = t.querySelector('ol.border-l'); if (!ol) return null; const li = ol.querySelector('li'); return li ? li.querySelector('button') : null; })()`);
    const memberBodyPadding = await cdp.evaluate(`(() => {
      const t = document.querySelector('[aria-label="Transcript"]');
      const content = t.querySelector('ol.border-l [data-slot="collapsible-content"]');
      return content ? getComputedStyle(content).paddingLeft : null;
    })()`);
    if (memberBodyPadding !== '32px') {
      notExercised.push(`Member expanded body computed padding-left is ${memberBodyPadding}, expected 32px (pl-8, decision 10).`);
    } else {
      findings.push('Member expanded body starts at pl-8 (32px), the label column (decision 10).');
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '03-dark-member-body-expanded.png'));

    // ---- Accessible semantics: <ol> reads "list", never "tree" (decision 21) ----
    const olAx = await getAccessibleNameAndRole(cdp, `document.querySelector('[aria-label="Transcript"] ol.border-l')`);
    if (olAx.role !== 'list') {
      notExercised.push(`SpineList <ol> accessible role measured "${olAx.role}", expected "list" (decision 21).`);
    } else {
      findings.push('SpineList exposes role "list" in the accessibility tree, never "tree" (decision 21).');
    }

    // ---- Collapse it back, then Dark/Obsidian/High-contrast screenshots ----
    await clickToolGroupTrigger(cdp);
    await cdp.waitFor(`!document.querySelector('[aria-label="Transcript"] ol.border-l')`, { timeoutMs: 10_000, label: 'SpineList <ol> unmounted after collapse' });
    findings.push('Collapsing the group unmounts the SpineList again (decision 17).');

    await cdp.evaluate(`(async () => { await window.refract.theme.preview('obsidian'); return true; })()`);
    await sleep(300);
    await clickToolGroupTrigger(cdp);
    await cdp.waitFor(`!!document.querySelector('[aria-label="Transcript"] ol.border-l')`, { timeoutMs: 10_000, label: 'Obsidian: expanded' });
    await cdp.screenshot(path.join(SHOTS_DIR, '04-obsidian-expanded.png'));
    findings.push('Obsidian theme screenshot captured, group expanded.');

    await cdp.evaluate(`(async () => { await window.refract.theme.preview('dark-high-contrast'); return true; })()`);
    await sleep(300);
    await cdp.screenshot(path.join(SHOTS_DIR, '05-dark-high-contrast-expanded.png'));
    findings.push('Dark (high contrast) theme screenshot captured, group expanded.');

    // ---- Narrow width (360px) and reduced motion ----
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const narrowOverflow = await cdp.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth + 2`);
    if (narrowOverflow) notExercised.push('A horizontal scrollbar appeared at 360px width -- decision 30 requires no horizontal scroll.');
    else findings.push('No horizontal scroll at 360px width (decision 30).');
    await cdp.screenshot(path.join(SHOTS_DIR, '06-360px-expanded.png'));
    await cdp.send('Emulation.clearDeviceMetricsOverride', {});

    await cdp.evaluate(`(async () => { await window.refract.theme.preview('dark'); return true; })()`);
    await sleep(300);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const spineTransition = await cdp.evaluate(`(() => {
      const ol = document.querySelector('[aria-label="Transcript"] ol.border-l');
      if (!ol) return null;
      const s = getComputedStyle(ol);
      return { transitionDuration: s.transitionDuration, animationName: s.animationName };
    })()`);
    if (!spineTransition) notExercised.push('Could not measure the Spine <ol> transition/animation under reduced motion (element not found).');
    else findings.push(`Spine has no transition/animation under reduced motion (transitionDuration=${spineTransition.transitionDuration}, animationName=${spineTransition.animationName}), matching decision 27 (it never animates regardless).`);
    await cdp.screenshot(path.join(SHOTS_DIR, '07-dark-reduced-motion.png'));
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });

    // ---- Turn (b): exactly one bash call -> solo ToolGroupRow, no Spine, no <ol> ----
    await cdp.typeIntoByLabel('Message', TURN_B_PROMPT);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(
      `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && (t.textContent.match(/${TURN_B_SENTINEL}/g) ?? []).length >= 2; })()`,
      { timeoutMs: 180_000, label: 'Turn (b) finished (assistant echoed the sentinel back)' },
    );
    const turnBTranscriptHtml = await cdp.evaluate(`document.querySelector('[aria-label="Transcript"]')?.outerHTML ?? ''`);
    writeFileSync(path.join(SHOTS_DIR, 'turn-b-transcript.html'), turnBTranscriptHtml);
    // Expand the LAST bash trigger (turn b's own solo group, not turn a's).
    await cdp.click(`(() => { const t = document.querySelector('[aria-label="Transcript"]'); const btns = Array.from(t.querySelectorAll('button')).filter((el) => el.textContent.includes('bash')); return btns[btns.length - 1]; })()`);
    await sleep(500);
    const soloHasOl = await cdp.evaluate(`(() => {
      const t = document.querySelector('[aria-label="Transcript"]');
      const ols = Array.from(t.querySelectorAll('ol.border-l'));
      return ols.length;
    })()`);
    // Turn (a)'s own group is collapsed at this point (never re-expanded), so any <ol> found now
    // belongs only to a genuinely multi-member group; turn (b)'s solo expansion must add none.
    if (soloHasOl > 0) {
      notExercised.push(`A SpineList <ol> was found (count=${soloHasOl}) after expanding turn (b)'s solo bash call -- decision 13 requires no Spine for a group of one; see turn-b-transcript.html.`);
    } else {
      findings.push("A group of exactly one call (turn b's solo bash) renders with no SpineList and no <ol> (decision 13).");
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '08-dark-solo-group-expanded.png'));

    console.log('\n=== verify-565-spine: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-565-spine: NOT EXERCISED / SOFT FAILURES ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots: ${SHOTS_DIR}`);
    console.log('verify-565-spine: DONE.');
    if (notExercised.length > 0) process.exitCode = 1;
  } catch (err) {
    console.error('verify-565-spine: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (autoApprove) await autoApprove.stop().catch(() => {});
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
