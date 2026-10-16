#!/usr/bin/env node
// Falsification probe for #917 (gate round 2, Main/architect): "the two /advisor status replies
// differ" is not proof that `/advisor off` actually stops the advisor's reviews -- omp's own docs
// (omp://advisor-watchdog.md "Enabling the advisor"/"Slash commands" table) say `/advisor off`
// "Disable the advisor subsystem for this session and stop its runtimes", yet a live run's
// status reply right after `/advisor off` read `Advisor "default" is running.`, which reads as a
// direct contradiction unless "running" means something narrower than "actively reviewing".
//
// This probe settles it with ground truth, not wording: every finalized advisor review turn is
// appended to the owning Session's own `__advisor*.jsonl` file, beside its Conversation file
// (omp://advisor-watchdog.md "Transcript persistence and observability"), REGARDLESS of whether
// the emission guard lets any note surface to the user. So:
//   1. `/advisor off`, then immediately `/advisor status` (nothing else in between) -- record the
//      literal reply of each.
//   2. Find this Session's own `__advisor*.jsonl` file(s) (via `window.refract.sessions.list()`'s
//      `currentConversation` -> its directory), record total size and line count.
//   3. Send a real turn. Re-measure the same file(s). If `/advisor off` actually stops reviews,
//      this file must NOT grow.
//   4. `/advisor on`, another real turn, re-measure again. If `/advisor on` actually resumes
//      reviews, this file SHOULD grow this time.
// The conclusion is written in plain language at the end, from the measured deltas, not assumed.
//
// Drives a REAL `omp` (ambient already-signed-in default profile; no scratch OMP_PROFILE
// override, same isolation posture as verify-917-advisor-command.mjs/verify-558). Reuses the
// already-built exe (`CARGO_TARGET_DIR`/debug) without rebuilding when the caller has already
// confirmed `git diff --stat <evidence-head> HEAD -- src src-tauri` is empty.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, launchBuiltExe, safeRmSync, sha256OfFile } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
const SHOTS_DIR =
  process.env.REFRACT_917B_SHOTS_DIR || path.join(tmpdir(), 'refract-917-advisor-off-probe', new Date().toISOString().replace(/[:.]/g, '-'));

function copyAlreadyBuiltExe(destDir, buildOutputDir) {
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'refract-tauri.exe');
  const src = path.join(buildOutputDir, 'refract-tauri.exe');
  if (!existsSync(src)) throw new Error(`copyAlreadyBuiltExe: no built exe at ${src} -- a fresh build is needed`);
  copyFileSync(src, dest);
  return { dest, hash: sha256OfFile(dest) };
}

const NOTICE_FINDER =
  `Array.from(document.querySelectorAll('span.sr-only')).filter((el) => (el.textContent ?? '').trim() === 'Info:').map((el) => el.parentElement?.parentElement).filter(Boolean)`;

async function countNotices(cdp) {
  return cdp.evaluate(`(${NOTICE_FINDER}).length`);
}

async function allNoticeTexts(cdp) {
  return cdp.evaluate(`(${NOTICE_FINDER}).map((row) => (row.querySelector(':scope > span.min-w-0.flex-1')?.textContent ?? '').trim())`);
}

async function clearComposer(cdp) {
  const current = await cdp.evaluate(`document.querySelector('[aria-label="Message"]')?.value ?? ''`);
  for (let i = 0; i < current.length; i++) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' });
  }
  await cdp.waitFor(`(document.querySelector('[aria-label="Message"]')?.value ?? '') === ''`, { timeoutMs: 5_000, label: 'Composer cleared' });
}

async function sendSlashCommand(cdp, command) {
  await clearComposer(cdp);
  const before = await countNotices(cdp);
  await cdp.typeIntoByLabel('Message', command);
  await cdp.clickByLabel('Send message');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const texts = await allNoticeTexts(cdp);
    const match = texts.slice(before).find((t) => /advisor/i.test(t));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`sendSlashCommand: no advisor-mentioning notice appeared within 60s for "${command}"`);
}

async function sendRealTurn(cdp, sentinel) {
  await clearComposer(cdp);
  await cdp.typeIntoByLabel('Message', `Reply with exactly the single word '${sentinel}' and nothing else.`);
  await cdp.clickByLabel('Send message');
  await cdp.waitFor(
    `(() => { const t = document.querySelector('[aria-label="Transcript"]'); return !!t && (t.textContent.match(/${sentinel}/g) ?? []).length >= 2; })()`,
    { timeoutMs: 180_000, label: `Turn (${sentinel}) finished` }
  );
}

/** `window.refract.sessions.list()`'s own `sessionDir` field (populated from `get_state`'s own
 * `sessionFile` as soon as it is first learned -- unlike `currentConversation`, which the Rust
 * side (`sync_from_state.rs`) only persists once `messageCount > 0`, `sessionDir` has no such
 * gate, so it is already populated by the time the composer is enabled, well before any slash
 * command or real turn has been sent); `__advisor*.jsonl` lives inside a per-Conversation
 * artifacts folder under it, resolved separately by `getArtifactsDir` below. */
async function getSessionDir(cdp) {
  return cdp.waitFor(
    `(async () => { const result = await window.refract.sessions.list(); if (!result.ok) return null; const s = result.value[0]; return s?.sessionDir ?? null; })()`,
    { timeoutMs: 30_000, label: 'Session sessionDir populated' }
  );
}

/** The per-Conversation ARTIFACTS SUBDIRECTORY inside `sessionDir` -- discovered live to be a
 * folder sharing the Conversation file's own basename (no `.jsonl`), NOT `sessionDir` itself:
 * `sessionDir` directly holds `<timestamp>_<uuid>.jsonl` (the Conversation) alongside a
 * same-named (no extension) folder, and `__advisor.jsonl` lives INSIDE that folder, not beside
 * the `.jsonl` file as `omp://advisor-watchdog.md`'s "<session>/__advisor.jsonl" wording reads
 * at a glance (an earlier version of this probe searched `sessionDir` directly and found
 * nothing in either phase because of this). Polls because the Conversation file, and so this
 * folder, may not exist yet in the first moment after Session creation. */
async function getArtifactsDir(sessionDir, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const conversationFile = readdirSync(sessionDir).find((f) => f.endsWith('.jsonl') && !f.startsWith('__advisor'));
      if (conversationFile) {
        const dir = path.join(sessionDir, conversationFile.slice(0, -'.jsonl'.length));
        if (existsSync(dir)) return dir;
      }
    } catch {
      // sessionDir may not exist yet either; keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`getArtifactsDir: no Conversation artifacts folder appeared under ${sessionDir} within ${timeoutMs}ms`);
}

/** Total size (bytes) and line count across every `__advisor*.jsonl` in `dir` right now -- 0/0
 * when none exist yet (the advisor has never been built for this Session, e.g. it starts
 * disabled and no turn has run with it on yet). Reads the REAL host filesystem directly (Node
 * `fs`, not the renderer), since this file lives under OMP's own session store, not Refract's
 * own scratch data dir. */
function measureAdvisorFiles(dir) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /^__advisor.*\.jsonl$/.test(f));
  } catch {
    return { files: [], totalBytes: 0, totalLines: 0 };
  }
  let totalBytes = 0;
  let totalLines = 0;
  for (const f of files) {
    const full = path.join(dir, f);
    const stat = statSync(full);
    totalBytes += stat.size;
    const content = readFileSync(full, 'utf8');
    totalLines += content.split('\n').filter((l) => l.trim().length > 0).length;
  }
  return { files, totalBytes, totalLines };
}

/** Polls `measureAdvisorFiles(dir)` until it shows growth past `baseline` (bytes or lines) or
 * `timeoutMs` elapses -- a finalized review is written asynchronously after the primary turn
 * settles (omp://advisor-watchdog.md "Advisor review is async after the turn settles"), so a
 * single immediate measurement right after the turn would under-count a real but still-pending
 * review. Returns the LAST measurement either way (growth or none), never throws. */
async function pollForGrowth(dir, baseline, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = measureAdvisorFiles(dir);
  while (Date.now() < deadline) {
    if (latest.totalBytes > baseline.totalBytes || latest.totalLines > baseline.totalLines) return latest;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    latest = measureAdvisorFiles(dir);
  }
  return latest;
}

async function main() {
  let dataDir, importSourceDir, repoDir, exeDir, launcherDir;
  let child;
  let cdp;
  const findings = [];
  const failures = [];
  let exeHash = null;
  let gitHeadSha = null;
  try {
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-917b-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-917b-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-917b-repo-')), 'verify-917-advisor-off-probe');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-917b-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-917b-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, approvalMode: 'auto' }));
    const port = await getFreePort();
    gitHeadSha = gitHead(REPO_ROOT);

    console.log(`verify-917b: git HEAD ${gitHeadSha}`);
    console.log(`verify-917b: shots dir ${SHOTS_DIR}`);

    const built = copyAlreadyBuiltExe(exeDir, BUILD_OUTPUT_DIR);
    const exePath = built.dest;
    exeHash = built.hash;
    console.log(`verify-917b: reused already-built exe, sha256 ${exeHash}`);
    const launcherExe = buildLauncher(launcherDir);

    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app.log') });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-917b: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 60_000, label: 'Readiness green' }
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
      { timeoutMs: 15_000, label: 'Create session enabled' }
    );
    await cdp.clickByText('Create session', { inDialog: true });
    await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeoutMs: 15_000, label: 'Dialog closed' });
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 90_000,
      label: 'Session opened, composer enabled'
    });
    findings.push('Session created; REAL omp process attached (ambient signed-in profile, scratch cwd/worktree).');

    // ---- /advisor off, then /advisor status with nothing in between ----
    const offReply = await sendSlashCommand(cdp, '/advisor off');
    findings.push(`"/advisor off" literal reply: ${JSON.stringify(offReply)}`);
    const statusAfterOff = await sendSlashCommand(cdp, '/advisor status');
    findings.push(`"/advisor status" literal reply right after off (nothing in between): ${JSON.stringify(statusAfterOff)}`);

    const sessionDir = await getSessionDir(cdp);
    const artifactsDir = await getArtifactsDir(sessionDir);
    findings.push(`Session dir: ${sessionDir}`);
    findings.push(`Conversation artifacts dir (where __advisor*.jsonl actually lives): ${artifactsDir}`);
    const beforeOffTurn = measureAdvisorFiles(artifactsDir);
    findings.push(
      `__advisor*.jsonl before the off-phase turn: files=${JSON.stringify(beforeOffTurn.files)} bytes=${beforeOffTurn.totalBytes} lines=${beforeOffTurn.totalLines}`
    );

    // ---- A real turn while the advisor is OFF (poll for up to 45s: a review is async, so even
    // a failed "off" would not necessarily grow the file instantly) ----
    await sendRealTurn(cdp, 't917boff');
    findings.push('A real turn completed while the advisor was OFF.');
    const afterOffTurn = await pollForGrowth(artifactsDir, beforeOffTurn, 45_000);
    findings.push(
      `__advisor*.jsonl after the off-phase turn (polled up to 45s): files=${JSON.stringify(afterOffTurn.files)} bytes=${afterOffTurn.totalBytes} lines=${afterOffTurn.totalLines}`
    );
    const grewWhileOff = afterOffTurn.totalBytes > beforeOffTurn.totalBytes || afterOffTurn.totalLines > beforeOffTurn.totalLines;

    // ---- /advisor on, then TWO real turns -- the first is a deliberate warm-up
    // (`advisor.immuneTurns` skips reviewing it, the same precedent verify-558-blocker-callout.mjs
    // already established for this exact advisor subsystem), the second is the one a review is
    // actually expected against ----
    const onReply = await sendSlashCommand(cdp, '/advisor on');
    findings.push(`"/advisor on" literal reply: ${JSON.stringify(onReply)}`);
    const beforeOnTurn = measureAdvisorFiles(artifactsDir);
    findings.push(
      `__advisor*.jsonl before the on-phase turns: files=${JSON.stringify(beforeOnTurn.files)} bytes=${beforeOnTurn.totalBytes} lines=${beforeOnTurn.totalLines}`
    );
    await sendRealTurn(cdp, 't917bwarmup');
    findings.push('Warm-up turn completed (advisor.immuneTurns skips reviewing this one, per verify-558-blocker-callout.mjs\'s own precedent).');
    await sendRealTurn(cdp, 't917bon');
    findings.push('Second (non-warm-up) real turn completed while the advisor was ON.');
    const afterOnTurn = await pollForGrowth(artifactsDir, beforeOnTurn, 60_000);
    findings.push(
      `__advisor*.jsonl after the on-phase turns (polled up to 60s): files=${JSON.stringify(afterOnTurn.files)} bytes=${afterOnTurn.totalBytes} lines=${afterOnTurn.totalLines}`
    );
    const grewWhileOn = afterOnTurn.totalBytes > beforeOnTurn.totalBytes || afterOnTurn.totalLines > beforeOnTurn.totalLines;

    // ---- Conclusion, from the measured deltas only ----
    let conclusion;
    if (grewWhileOff) {
      failures.push(
        `The __advisor*.jsonl file GREW during the OFF-phase turn (bytes ${beforeOffTurn.totalBytes} -> ${afterOffTurn.totalBytes}, lines ${beforeOffTurn.totalLines} -> ${afterOffTurn.totalLines}): "/advisor off" does NOT appear to stop the advisor from reviewing turns, contradicting omp://advisor-watchdog.md's own documented behaviour ("stop its runtimes"). This is either an omp behaviour or a Refract forwarding bug -- #917 cannot claim off works until this is resolved.`
      );
      conclusion = 'FALSIFIED: off did not stop reviews.';
    } else if (!grewWhileOn) {
      failures.push(
        `The __advisor*.jsonl file did NOT grow during the ON-phase turn either (bytes ${beforeOnTurn.totalBytes} -> ${afterOnTurn.totalBytes}): inconclusive -- either /advisor on also failed to start reviews, or the advisor never produced a finalized review this run for an unrelated reason (e.g. reviewMode/cadence). Cannot confirm the toggle has the documented effect from this evidence alone.`
      );
      conclusion = 'INCONCLUSIVE: neither phase grew the file.';
    } else {
      findings.push(
        `CONFIRMED by file evidence: the __advisor*.jsonl file did NOT grow while the advisor was OFF (stayed at bytes=${beforeOffTurn.totalBytes}, lines=${beforeOffTurn.totalLines}) but DID grow while it was ON (bytes ${beforeOnTurn.totalBytes} -> ${afterOnTurn.totalBytes}, lines ${beforeOnTurn.totalLines} -> ${afterOnTurn.totalLines}). "/advisor off" genuinely stops the advisor from running a review for a turn; the status reply "Advisor \\"default\\" is running." observed right after off does NOT mean "actively reviewing" -- it reports the named advisor's own object/runtime still being instantiated and alive (per omp://advisor-watchdog.md's "Rebuilding advisors ... keeps updates the cadence skipped", a built advisor instance persists even while the session-scoped override has it gated off from running against new turns), distinct from the review-cadence gate the session-scoped on/off override actually controls.`
      );
      conclusion = 'CONFIRMED: off stops reviews (file evidence), on resumes them; "is running" describes the instance, not the review gate.';
    }
    findings.push(`CONCLUSION: ${conclusion}`);

    const report = {
      gitHead: gitHeadSha,
      exeSha256: exeHash,
      sessionDir,
      artifactsDir,
      beforeOffTurn,
      afterOffTurn,
      beforeOnTurn,
      afterOnTurn,
      conclusion,
      findings,
      failures,
      exitCode: failures.length > 0 ? 1 : 0
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-917b: FAILURES ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-917b: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log(`\nReport: ${path.join(SHOTS_DIR, 'report.json')}`);
    console.log(`verify-917b: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(
        path.join(SHOTS_DIR, 'report.json'),
        JSON.stringify({ gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, error: String(err?.stack ?? err), exitCode: 1 }, null, 2)
      );
    } catch {
      // best-effort only
    }
    console.error('verify-917b: FAILED:', err?.stack ?? err);
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
  console.error('verify-917b: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
