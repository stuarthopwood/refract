#!/usr/bin/env node
// Live CDP check for issue #962 (follow-up from #950/#632): a collapsed multi-call tool group's
// Error line attribution prefix used to run into the message with no visible gap ("$ exit 9:
// Command exited with code 9") -- the space was the LAST character inside the prefix `bdi`'s own
// `inline-block` line box, and CSS collapses/drops trailing whitespace at the end of an inline
// formatting context, so the space never rendered even though it was in the markup. Also:
// `commandRowText` did not strip control/bidi-override characters the way `errorLine`'s own
// `sanitizeLines` already did.
//
// Modeled on `verify-917-advisor-command.mjs` (a REAL `omp`, ambient signed-in default profile,
// scratch `REFRACT_DATA_DIR`/repo only). Two turns, one scratch Session:
//   (a) two bash calls, the second `exit 9` (same shape as #632's own turn (a)) -- proves the
//       collapsed group's Error line prefix and message have a real visual gap (measured via
//       `getBoundingClientRect`, never just `textContent`, which would pass even with the bug:
//       the space character was always IN the DOM, only its CSS rendering collapsed it away).
//   (b) one bash call whose own command embeds a real U+202E (RIGHT-TO-LEFT OVERRIDE) byte --
//       proves `commandRowText`'s rendered row text never contains it.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
  assertExeUnchanged,
  requireSharedCargoTarget,
  sha256OfFile
} from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR =
  process.env.REFRACT_962_SHOTS_DIR || path.join(tmpdir(), 'refract-962-error-prefix-space-shots', new Date().toISOString().replace(/[:.]/g, '-'));

const TRANSCRIPT = `document.querySelector('[aria-label="Transcript"]')`;
// Same finder `verify-632-grouped-calls.mjs` uses: every top-level tool-call group header button
// (a multi-call group's own `span.font-medium` reads "bash \u00d72"; a solo command-style row has
// no label at all, recognised instead by its summary starting with the command grammar). Excludes
// an expanded group's own member rows (inside `ol.border-l`), which match the same label-less
// fallback.
const GROUP_HEADERS = `Array.from(${TRANSCRIPT}.querySelectorAll('button')).filter((el) => {
  if (el.closest('ol.border-l')) return false;
  const l = el.querySelector('span.font-medium');
  if (l) return /^(?:bash|grep|glob|find|read|write|edit)(?:\\s*\\u00d7\\d+)?$/.test((l.textContent || '').trim());
  const s = el.querySelector('span.min-w-0.flex-1');
  const t = s ? (s.textContent || '').trim() : '';
  return /^\\$ /.test(t) || /^grep "/.test(t);
})`;
const BASH_GROUP_LABEL = /^bash\s*\u00d72$/;

const TURN_A_PROMPT =
  "Make exactly TWO separate bash tool calls, strictly in this order, waiting for each one to finish before starting the next: first run exactly `sleep 1 && echo t962-one`, second run exactly `exit 9` (which deliberately fails with no output). After both finish, reply with exactly the single word 't962a' and nothing else.";
// A REAL U+202E (RIGHT-TO-LEFT OVERRIDE) byte embedded directly in the prompt text -- the model
// copies it through into its own bash tool call's command argument verbatim, no shell-side
// escape interpretation (same technique #632's own `TURN_F_PROMPT` used for a real ESC byte).
const TURN_B_PROMPT =
  "Make exactly ONE bash tool call that runs exactly this, byte for byte, with no retyping or reinterpreting: `echo t962BidiMarker\u202Eafter-override` (its own command text deliberately contains a real U+202E RIGHT-TO-LEFT OVERRIDE character). Then reply with exactly the single word 't962b' and nothing else.";

// Reads the collapsed group header at `index`, its `aria-describedby` detail paragraph, the
// prefix `bdi` inside it, and the gap between the `bdi`'s own right edge and the first
// non-whitespace character that follows it -- the CSS symptom (collapsed trailing space inside
// the `bdi`'s `inline-block`) only shows up as a GEOMETRIC gap of (near) zero; `textContent`
// alone would pass even with the bug, since the space character was always present in the DOM.
function groupDetailGeometry(index) {
  return `(() => {
    const h = (${GROUP_HEADERS}).at(${index});
    if (!h) return { error: 'no group header found' };
    const label = h.querySelector('span.font-medium');
    const describedBy = h.getAttribute('aria-describedby');
    const detail = describedBy ? document.getElementById(describedBy) : null;
    if (!detail) return { error: 'no aria-describedby detail paragraph found', labelText: label ? label.textContent.trim() : null };
    const bdi = detail.querySelector('bdi');
    if (!bdi) return { error: 'no prefix bdi found inside detail', detailText: detail.textContent };
    const bdiRect = bdi.getBoundingClientRect();
    // Walk forward from the bdi through its following siblings (text nodes and/or elements)
    // until the first non-whitespace character, and measure a Range from there to the end of
    // that node -- the actual visible "message" left edge, excluding the leading space itself
    // (a space has layout width but no ink, so including it would not prove a real visible gap).
    let node = bdi.nextSibling;
    let messageRect = null;
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const idx = node.textContent.search(/\\S/);
        if (idx !== -1) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, node.textContent.length);
          messageRect = range.getBoundingClientRect();
          break;
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const range = document.createRange();
        range.selectNode(node);
        messageRect = range.getBoundingClientRect();
        break;
      }
      node = node.nextSibling;
    }
    return {
      labelText: label ? label.textContent.trim() : null,
      detailText: detail.textContent,
      bdiText: bdi.textContent,
      bdiRight: bdiRect.right,
      messageLeft: messageRect ? messageRect.left : null,
      gapPx: messageRect ? messageRect.left - bdiRect.right : null,
    };
  })()`;
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
  let dirtyFlag = 'unknown';
  try {
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-962-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-962-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-962-repo-')), 'verify-error-prefix-space');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-962-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-962-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, approvalMode: 'auto' }));

    const port = await getFreePort();
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    if (gitStatusResult.status === 0) {
      const dirtyLines = gitStatusResult.stdout.split('\n').filter(Boolean);
      dirtyFlag = dirtyLines.length ? dirtyLines : false;
    }
    console.log(`verify-962: git HEAD ${gitHeadSha}${dirtyFlag === 'unknown' ? ' (dirty flag unknown: git status failed)' : dirtyFlag ? ` (DIRTY: ${dirtyFlag.length} path(s))` : ''}`);
    console.log(`verify-962: shots dir ${SHOTS_DIR}`);

    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-962' });
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app.log') });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-962: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }
    assertExeUnchanged(exePath, exeHash, 'post-launch', 'verify-962');

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green (real omp --version + get_state round trip)' }
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
      timeoutMs: 90_000,
      label: 'Session opened, real agent attached, composer enabled'
    });
    findings.push('Session created; REAL omp process attached (ambient signed-in profile, scratch cwd/worktree).');

    // ---- Turn (a): 2 bash calls, #2 fails -- the collapsed group's Error line prefix gap ----
    await cdp.typeIntoByLabel('Message', TURN_A_PROMPT);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(
      `(() => { const t = ${TRANSCRIPT}; return !!t && (t.textContent.match(/t962a/g) ?? []).length >= 2; })()`,
      { timeoutMs: 180_000, label: 'Turn (a) finished' }
    );
    const geomA = await cdp.evaluate(groupDetailGeometry(0));
    await cdp.screenshot(path.join(SHOTS_DIR, '01-turn-a-collapsed-group.png'));
    if (geomA.error) {
      failures.push(`Turn (a): ${geomA.error} (label "${geomA.labelText}").`);
    } else if (!BASH_GROUP_LABEL.test(geomA.labelText ?? '')) {
      failures.push(`Turn (a) group header label is "${geomA.labelText}", expected to match /${BASH_GROUP_LABEL}/ ("bash ×2").`);
    } else if (geomA.messageLeft === null) {
      failures.push(`Turn (a): no visible message text found after the prefix bdi (detail text: ${JSON.stringify(geomA.detailText)}).`);
    } else {
      findings.push(`Turn (a) group detail text reads ${JSON.stringify(geomA.detailText)}; prefix bdi reads ${JSON.stringify(geomA.bdiText)}; bdi right edge ${geomA.bdiRight.toFixed(2)}px, message left edge ${geomA.messageLeft.toFixed(2)}px, gap ${geomA.gapPx.toFixed(2)}px.`);
      if (geomA.gapPx < 2) {
        failures.push(`Turn (a): rendered gap between the prefix bdi and the message is ${geomA.gapPx.toFixed(2)}px (< 2px) -- the space is collapsed away, command runs into the message (the #962 bug).`);
      } else {
        findings.push(`Turn (a): rendered gap between the prefix bdi and the message is ${geomA.gapPx.toFixed(2)}px (>= 2px) -- visibly separated, never "$ exit 9:Command exited...".`);
      }
      if (!/^\$ exit 9: /.test(geomA.detailText ?? '')) {
        failures.push(`Turn (a): detail textContent is ${JSON.stringify(geomA.detailText)}, expected to start with "$ exit 9: " (a real space after the colon).`);
      } else {
        findings.push('Turn (a): detail textContent starts with "$ exit 9: " (prefix, colon, one space, then the message).');
      }
    }

    // ---- Turn (b): one bash call whose own command embeds a real U+202E override byte ----
    await cdp.typeIntoByLabel('Message', TURN_B_PROMPT);
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(
      `(() => { const t = ${TRANSCRIPT}; return !!t && (t.textContent.match(/t962b/g) ?? []).length >= 1; })()`,
      { timeoutMs: 180_000, label: 'Turn (b) finished' }
    );
    await cdp.waitFor(
      `(() => { const t = ${TRANSCRIPT}; return !!t && t.textContent.includes('t962BidiMarker'); })()`,
      { timeoutMs: 15_000, label: "Turn (b) bash row mounted (marker text visible)" }
    );
    const transcriptText = await cdp.evaluate(`(${TRANSCRIPT}).textContent`);
    await cdp.screenshot(path.join(SHOTS_DIR, '02-turn-b-bidi-override.png'));
    if (!transcriptText.includes('t962BidiMarker')) {
      failures.push('Turn (b): the bidi-marker command row never rendered at all (marker text not found in the transcript) -- this check would be vacuous.');
    } else if (transcriptText.includes('\u202E')) {
      failures.push('Turn (b): the transcript still renders a real U+202E (RIGHT-TO-LEFT OVERRIDE) character -- `commandRowText` leaked an unsanitized bidi-override byte into the row text.');
    } else {
      findings.push('Turn (b): the marker command rendered, with no U+202E override character anywhere in the transcript -- `commandRowText` strips it the same way `errorLine` already did.');
    }

    const hasNotExercised = notExercised.length > 0;
    const exitCode = failures.length > 0 || hasNotExercised ? 1 : 0;
    const report = {
      gitHead: gitHeadSha,
      dirty: dirtyFlag,
      exeSha256: exeHash,
      scriptSha256: sha256OfFile(fileURLToPath(import.meta.url)),
      findings,
      failures,
      notExercised,
      exitCode
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-962: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-962: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-962: NOT EXERCISED (genuine skips only; any entry here fails the run) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-962: ${exitCode !== 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = exitCode;
  } catch (err) {
    try {
      writeFileSync(
        path.join(SHOTS_DIR, 'report.json'),
        JSON.stringify(
          { gitHead: gitHeadSha, dirty: dirtyFlag, exeSha256: exeHash, scriptSha256: sha256OfFile(fileURLToPath(import.meta.url)), findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 },
          null,
          2
        )
      );
    } catch {
      // best-effort only
    }
    console.error('verify-962: FAILED:', err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    if (child) {
      await stopLauncher(child).catch((err) => {
        console.error('verify-962: stopLauncher failed:', err?.stack ?? err);
      });
    }
    await safeRmSync(dataDir);
    await safeRmSync(importSourceDir);
    await safeRmSync(repoDir);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
  }
}

main().catch((err) => {
  console.error('verify-962: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
