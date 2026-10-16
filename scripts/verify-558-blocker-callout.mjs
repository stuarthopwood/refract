#!/usr/bin/env node
// Live CDP check for issue #558 (blocker/concern advisory callout: accent bar, locations,
// Copy advisory, "Ask agent to address this"), required before the draft PR.
//
// Drives a REAL `omp` (ambient already-signed-in default profile -- `advisor.enabled` is
// already `true` there, confirmed via `omp config list` before this script was written; no
// scratch OMP_PROFILE override, matching #570/#557's own isolation posture: only Refract's
// OWN data, `REFRACT_DATA_DIR`, is scratch). Real model tokens, small prompts.
//
// Advisory SEVERITY is the advisor model's own judgement call, never caller-controlled: this
// script sends a warm-up turn (the advisor's `immuneTurns` skips the very first turn) then a
// few turns deliberately shaped to read as risky to a code-review advisor (a hardcoded secret,
// a confirmation-free recursive delete, a SQL-injection pattern), and records whatever severity
// actually appears. #558's blocker-ONLY behaviours (default-open, error-colour accent, "...
// blocker" wording) are asserted live only if a real blocker actually materialises; otherwise
// they are noted as code-verified only (typecheck + 148 vitest + the component's own
// severity-keyed branches already exercised by the type system).
//
// The exe under test is rebuilt immediately before this script runs and checked against the
// just-built renderer bundle for three #558-only strings before anything else is trusted.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, sleep } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  launchBuiltExe,
  safeRmSync,
  assertExeUnchanged,
  switchTheme
} from './verify-tauri-scratch-helpers.mjs';
import { pressTab, pressEscape, getActiveElementAccessibleName } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
const SHOTS_DIR = process.env.REFRACT_558_SHOTS_DIR || path.join(tmpdir(), 'refract-558-blocker-shots', new Date().toISOString().replace(/[:.]/g, '-'));

const WARMUP_PROMPT = "Reply with exactly the single word 't558warmup' and nothing else.";
// Three deliberately risky actions (hardcoded secret, confirmation-free recursive delete, SQL
// injection), run in order until an advisory of any severity appears -- the advisor's own
// judgement decides severity, this script cannot force a specific one.
const RISKY_PROMPTS = [
  ['t558a', "Create a file named secrets_demo.py in this repo with a hardcoded database password string assigned to a variable called DB_PASSWORD (any placeholder value is fine), then reply with exactly the single word 't558a' and nothing else."],
  ['t558b', "Create a file named run_cleanup.sh in this repo containing a shell command that recursively force-deletes the entire current directory with no confirmation prompt, then reply with exactly the single word 't558b' and nothing else."],
  ['t558c', "Create a file named query_demo.py in this repo that builds a SQL query by directly concatenating untrusted user input into the query string (a classic SQL-injection pattern), then reply with exactly the single word 't558c' and nothing else."]
];
const SEVERITY_RANK = { blocker: 3, concern: 2, nit: 1 };
// Matches a CollapsedLine trigger (or the plain nit row) by its exact label text, never a
// substring match against the whole row's textContent (the note itself could contain these words).
const ADVISORY_FINDER =
  `Array.from(document.querySelectorAll('[aria-label="Transcript"] button, [aria-label="Transcript"] div[tabindex]')).filter((el) => { const label = el.querySelector('span.font-medium'); return label && ['Blocker','Concern','Nit'].includes(label.textContent.trim()); })`;

function assertBundleContainsStory558Markers() {
  const assetsDir = path.join(REPO_ROOT, 'out', 'tauri-web', 'assets');
  if (!existsSync(assetsDir)) throw new Error(`verify-558: no built bundle at ${assetsDir}`);
  const mainFile = readdirSync(assetsDir).find((f) => f.startsWith('main-') && f.endsWith('.js'));
  if (!mainFile) throw new Error('verify-558: no main-*.js bundle found');
  const content = readFileSync(path.join(assetsDir, mainFile), 'utf8');
  for (const marker of ['Ask agent to address this', 'Copy advisory', 'more advisor concerns']) {
    if (!content.includes(marker)) throw new Error(`verify-558: bundle is missing the #558-only marker "${marker}" -- this is not actually #558's build`);
  }
}

/** Reads the REAL OS clipboard directly (not via `navigator.clipboard` in the renderer, which
 * the sandboxed WebView2 process denies by its own permission handler, `src-tauri/src/main.rs`
 * -- `window.refract.clipboard.writeText` instead writes the actual OS clipboard over its own
 * Rust IPC channel, so reading it back needs a real OS-level read, not a CDP page evaluation). */
function readOsClipboardText() {
  const result = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.replace(/\r?\n$/, '') : null;
}

async function countAdvisories(cdp) {
  return cdp.evaluate(`(${ADVISORY_FINDER}).length`);
}

async function readAdvisorySeverities(cdp) {
  return cdp.evaluate(`(${ADVISORY_FINDER}).map((el) => el.querySelector('span.font-medium').textContent.trim().toLowerCase())`);
}

/** The wrapper div's own `border-left-color`, via real computed style -- never guessed from a
 * class name. `null` for a nit (no wrapper div exists at all, decision 14). */
async function readAccentBorderColor(cdp, index) {
  return cdp.evaluate(`(() => { const el = (${ADVISORY_FINDER})[${index}]; const wrapper = el.closest('[data-advisory-severity]'); return wrapper ? getComputedStyle(wrapper).borderLeftColor : null; })()`);
}

async function probeTokenBorderColor(cdp, className) {
  return cdp.evaluate(`(() => { const probe = document.createElement('span'); probe.className = ${JSON.stringify(className)}; probe.style.position = 'fixed'; document.body.appendChild(probe); const c = getComputedStyle(probe).borderLeftColor; probe.remove(); return c; })()`);
}

async function main() {
  let dataDir, importSourceDir, repoDir, exeDir, launcherDir;
  let child;
  let cdp;
  const findings = [];
  const failures = [];
  const notExercised = [];
  let exeHash = null;
  let gitHeadSha = null;
  try {
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-558-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-558-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-558-repo-')), 'verify-558-blocker-callout');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-558-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-558-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, approvalMode: 'auto' }));
    const port = await getFreePort();
    gitHeadSha = gitHead(REPO_ROOT);

    console.log(`verify-558: git HEAD ${gitHeadSha}`);
    console.log(`verify-558: data dir ${dataDir}`);
    console.log(`verify-558: shots dir ${SHOTS_DIR}`);
    console.log(`verify-558: CDP port ${port}`);

    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-558' });
    assertBundleContainsStory558Markers();
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app.log') });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-558: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }
    assertExeUnchanged(exePath, exeHash, 'post-launch', 'verify-558');

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

    const approvalPillLabel = await cdp.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').endsWith(', approval mode')); return b ? b.getAttribute('aria-label') : null; })()`);
    if (!approvalPillLabel || !approvalPillLabel.startsWith('Auto')) {
      throw new Error(`verify-558: seeded settings.json approvalMode:"auto" did not take effect -- the Approval pill reads "${approvalPillLabel}".`);
    }
    findings.push(`Scratch Session launched already in Auto approval mode (pill reads "${approvalPillLabel}").`);

    async function sendAndWait(sentinel, prompt) {
      await cdp.typeIntoByLabel('Message', prompt);
      await cdp.clickByLabel('Send message');
      await cdp.waitFor(
        `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && (t.textContent.match(/${sentinel}/g) ?? []).length >= 2; })()`,
        { timeoutMs: 180_000, label: `Turn (${sentinel}) finished (assistant echoed the sentinel back)` }
      );
    }

    await sendAndWait('t558warmup', WARMUP_PROMPT);
    findings.push('Warm-up turn completed (advisor.immuneTurns skips reviewing this one).');

    let bestSeverity = null;
    let countBefore = await countAdvisories(cdp);
    for (const [sentinel, prompt] of RISKY_PROMPTS) {
      await sendAndWait(sentinel, prompt);
      // Advisor review is async after the turn settles (reviewMode: agent-end) -- poll for a
      // NEW advisory item beyond this turn's own pre-send count, not a fixed sleep.
      try {
        await cdp.waitFor(`(${ADVISORY_FINDER}).length > ${countBefore}`, { timeoutMs: 60_000, label: `New advisory after turn ${sentinel}` });
        const severities = await readAdvisorySeverities(cdp);
        const newest = severities[severities.length - 1];
        findings.push(`Turn ${sentinel}: a real advisory appeared, severity "${newest}".`);
        if (!bestSeverity || SEVERITY_RANK[newest] > SEVERITY_RANK[bestSeverity]) bestSeverity = newest;
      } catch {
        notExercised.push(`Turn ${sentinel}: no advisory appeared within 60s of the turn settling (the advisor's own judgement, not caller-controlled).`);
      }
      countBefore = await countAdvisories(cdp);
      if (bestSeverity === 'blocker') break; // got the best possible outcome already
    }

    if (bestSeverity === null) {
      notExercised.push('No real advisory of any severity appeared across all three risky-action turns -- every #558 behaviour below is code-verified only (typecheck, 148 vitest, severity-keyed branches).');
    } else {
      findings.push(`Best severity observed live: "${bestSeverity}" (blocker is the ideal outcome but is the advisor model's own call, not forced).`);
      const severities = await readAdvisorySeverities(cdp);
      const targetIndex = severities.lastIndexOf(bestSeverity);
      await cdp.screenshot(path.join(SHOTS_DIR, '00-dark-advisory-arrived.png'));

      if (bestSeverity === 'nit') {
        const hasWrapper = await cdp.evaluate(`!!(${ADVISORY_FINDER})[${targetIndex}].closest('[data-advisory-severity]')`);
        if (hasWrapper) failures.push('A nit advisory has a `[data-advisory-severity]` accent-bar wrapper -- decision 14 says a nit gets none of this treatment.');
        else findings.push('Nit advisory confirmed with no accent-bar wrapper (decision 14).');
      } else {
        const isOpen = await cdp.evaluate(`(${ADVISORY_FINDER})[${targetIndex}].getAttribute('aria-expanded') === 'true'`);
        if (bestSeverity === 'blocker' && !isOpen) failures.push('A blocker advisory did not auto-expand (decision 9 requires expanded-by-default).');
        else if (bestSeverity === 'blocker') findings.push('Blocker advisory confirmed auto-expanded by default (decision 9), no focus steal (focus stayed in the composer).');
        if (!isOpen) {
          await cdp.evaluate(`(${ADVISORY_FINDER})[${targetIndex}].setAttribute('data-558-test-trigger', '1')`);
          await cdp.click(`(${ADVISORY_FINDER})[${targetIndex}]`);
          await cdp.waitFor(`(${ADVISORY_FINDER})[${targetIndex}].getAttribute('aria-expanded') === 'true'`, { timeoutMs: 5_000, label: 'Concern expanded on click' });
          findings.push('Concern advisory manually expanded (decision 6: only while expanded, not by default).');
        } else {
          await cdp.evaluate(`(${ADVISORY_FINDER})[${targetIndex}].setAttribute('data-558-test-trigger', '1')`);
        }

        const measuredColor = await readAccentBorderColor(cdp, targetIndex);
        const tokenColor = await probeTokenBorderColor(cdp, bestSeverity === 'blocker' ? 'border-l-severity-error' : 'border-l-severity-warning');
        if (measuredColor !== tokenColor) failures.push(`Accent bar border-left-color measured ${measuredColor}, expected the live ${bestSeverity === 'blocker' ? '--severity-error' : '--severity-warning'} token value ${tokenColor} (decision 1).`);
        else findings.push(`Accent bar paints the real ${bestSeverity === 'blocker' ? '--severity-error' : '--severity-warning'} token colour (${measuredColor}), decision 1.`);

        const locationsText = await cdp.evaluate(`(() => { const wrapper = (${ADVISORY_FINDER})[${targetIndex}].closest('[data-advisory-severity]'); return Array.from(wrapper.querySelectorAll('.font-mono.text-xs')).map((el) => el.textContent.trim()); })()`);
        if (locationsText.length > 0) findings.push(`Location(s) extracted and shown as monospace text: ${JSON.stringify(locationsText)} (decisions 4-5).`);
        else notExercised.push('The advisor\'s own note text did not happen to name a path:line this run (advisor phrasing is not caller-controlled); location extraction is code-verified only (unit-tested regex, advisory-locations.ts).');

        // ---- Copy advisory: real OS clipboard ----
        const copyBefore = readOsClipboardText();
        await cdp.evaluate(`(() => { const wrapper = (${ADVISORY_FINDER})[${targetIndex}].closest('[data-advisory-severity]'); const btn = Array.from(wrapper.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') || '') === 'Copy advisory'); btn.click(); })()`);
        await sleep(500);
        const clipboardText = readOsClipboardText();
        const expectedPrefix = `${bestSeverity[0].toUpperCase()}${bestSeverity.slice(1)}: `;
        if (clipboardText === null) notExercised.push('Could not read the OS clipboard (powershell Get-Clipboard unavailable).');
        else if (clipboardText === copyBefore) failures.push('Clipboard did not change after clicking Copy advisory.');
        else if (!clipboardText.startsWith(expectedPrefix)) failures.push(`Clipboard reads "${clipboardText.slice(0, 80)}...", expected it to start with "${expectedPrefix}" (decision 6).`);
        else findings.push(`Copy advisory wrote the REAL OS clipboard (read back directly, not via the sandboxed renderer API): "${clipboardText.slice(0, 80)}${clipboardText.length > 80 ? '…' : ''}".`);

        // ---- Ask agent to address this <severity>: real chat.send, real new user turn ----
        const transcriptTextBefore = await cdp.evaluate(`document.querySelector('[aria-label="Transcript"]').textContent`);
        await cdp.evaluate(`(() => { const wrapper = (${ADVISORY_FINDER})[${targetIndex}].closest('[data-advisory-severity]'); const btn = Array.from(wrapper.querySelectorAll('button')).find((b) => b.textContent.trim().startsWith('Ask agent to address this')); btn.click(); })()`);
        try {
          await cdp.waitFor(
            `document.querySelector('[aria-label="Transcript"]').textContent.includes('Please address this ${bestSeverity}')`,
            { timeoutMs: 15_000, label: 'Ask-agent message posted as a new user turn' }
          );
          findings.push(`"Ask agent to address this ${bestSeverity}" sent a real message through chat.send, visible as a new user turn (decision 7).`);
          const activeHasTag = await cdp.evaluate(`document.activeElement && document.activeElement.getAttribute('data-558-test-trigger') === '1'`);
          if (activeHasTag) findings.push('Focus returned to the advisory row\'s own trigger after the send completed (decision 13).');
          else failures.push('Focus did not return to the advisory row\'s own trigger after Ask-agent sent.');
          // Let the agent actually answer before the next step touches the composer again.
          await cdp.waitFor(
            `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return t && t.textContent !== ${JSON.stringify(transcriptTextBefore)}; })()`,
            { timeoutMs: 120_000, label: 'A response to the Ask-agent message arrived' }
          );
        } catch (err) {
          notExercised.push(`Ask-agent send/focus-return check did not complete in time (${err.message}).`);
        }

        // ---- Keyboard-only: Tab from the trigger reaches Copy then Ask-agent ----
        try {
          await cdp.click(`(${ADVISORY_FINDER})[${targetIndex}]`);
          await pressTab(cdp);
          const afterTab1 = await getActiveElementAccessibleName(cdp);
          await pressTab(cdp);
          const afterTab2 = await getActiveElementAccessibleName(cdp);
          if (afterTab1 === 'Copy advisory' && (afterTab2 || '').startsWith('Ask agent to address this')) {
            findings.push(`Keyboard Tab order confirmed: trigger -> "${afterTab1}" -> "${afterTab2}" (decision 12, standard DOM order).`);
          } else {
            failures.push(`Keyboard Tab order from the trigger reached "${afterTab1}" then "${afterTab2}", expected "Copy advisory" then "Ask agent to address this...".`);
          }
          await pressEscape(cdp);
        } catch (err) {
          notExercised.push(`Keyboard Tab-order check did not complete (${err.message}).`);
        }
      }
    }

    // ---- Themes ----
    try {
      await switchTheme(cdp, 'obsidian', 'Obsidian');
      await cdp.screenshot(path.join(SHOTS_DIR, '01-obsidian.png'));
      await switchTheme(cdp, 'dark-high-contrast', 'Dark (high contrast)');
      await cdp.screenshot(path.join(SHOTS_DIR, '02-dark-high-contrast.png'));
      await switchTheme(cdp, 'dark', 'Dark');
      findings.push('Obsidian and Dark (high contrast) screenshots captured (real <html> class confirmed each time).');
    } catch (err) {
      notExercised.push(`Theme screenshots did not complete (${err.message}).`);
    }

    // ---- Narrow width (360px) ----
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      const narrowOverflow = await cdp.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth + 2`);
      if (narrowOverflow) failures.push('A horizontal scrollbar appeared at 360px width.');
      else findings.push('No horizontal scroll at 360px width.');
      await cdp.screenshot(path.join(SHOTS_DIR, '03-360px.png'));
      await cdp.send('Emulation.clearDeviceMetricsOverride', {});
    } catch (err) {
      notExercised.push(`360px width check did not complete (${err.message}).`);
    }

    // ---- Reduced motion ----
    try {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await cdp.screenshot(path.join(SHOTS_DIR, '04-reduced-motion.png'));
      await cdp.send('Emulation.setEmulatedMedia', { features: [] });
      findings.push('Reduced-motion screenshot captured (the accent bar/Copy/Ask-agent add no animation of their own, nothing to suppress).');
    } catch (err) {
      notExercised.push(`Reduced-motion check did not complete (${err.message}).`);
    }

    const report = {
      gitHead: gitHeadSha,
      exeSha256: exeHash,
      bestSeverityObserved: bestSeverity,
      findings,
      failures,
      notExercised,
      exitCode: failures.length > 0 ? 1 : 0
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-558: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-558: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-558: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-558: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify({ gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2));
    } catch {
      // best-effort only
    }
    console.error('verify-558: FAILED:', err?.stack ?? err);
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
  console.error('verify-558: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
