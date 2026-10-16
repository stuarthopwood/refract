#!/usr/bin/env node
// Falsification probe for #917 (gate round 2, Main/architect/G923Tests): "the two /advisor
// status replies differ" is not proof that `/advisor off` actually stops the advisor's reviews
// -- omp's own docs (omp://advisor-watchdog.md "Enabling the advisor"/"Slash commands" table)
// say `/advisor off` "Disable the advisor subsystem for this session and stop its runtimes", yet
// a live run's status reply right after `/advisor off` read `Advisor "default" is running.`,
// which reads as a direct contradiction unless "running" means something narrower than
// "actively reviewing". A first version of this probe measured one phase (ON) with a warm-up
// plus a second turn but the other phase (OFF) with only ONE turn, which also happened to be
// the Session's very first turn ever -- G923Tests correctly called this lopsided: a brand-new
// Session's first turn could itself be skipped for reasons that have nothing to do with on/off
// (whatever actually causes the warm-up skip), so "no file after one off turn" proved nothing.
//
// This version is symmetric: EVERY phase (on, off, on again) gets the identical warm-up-turn
// plus a second real turn before being measured, so the only variable that differs between
// phases is the on/off state itself:
//   1. `/advisor on`, warm-up turn, second turn -- record size/lines (should exist and grow).
//   2. `/advisor off` -> literal reply recorded; `/advisor status` -> literal reply recorded
//      (nothing in between); warm-up turn, second turn -- record size/lines again. Off is
//      proven ONLY if the file does NOT grow across these two turns, compared to the end of
//      phase 1.
//   3. `/advisor on` again, warm-up turn, second turn -- record size/lines again (optional
//      confirmation that growth resumes).
// Ground truth, not wording: every finalized advisor review is appended to the owning Session's
// own `__advisor*.jsonl` file (omp://advisor-watchdog.md "Transcript persistence and
// observability"), REGARDLESS of whether the emission guard lets any note surface to the user.
// The conclusion is written in plain language at the end, from the measured deltas only -- the
// meaning of `Advisor "default" is running.` stays explicitly "not established" unless the
// evidence actually shows it; this probe does not guess at it as fact.
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
 * command or real turn has been sent). */
async function getSessionDir(cdp) {
  return cdp.waitFor(
    `(async () => { const result = await window.refract.sessions.list(); if (!result.ok) return null; const s = result.value[0]; return s?.sessionDir ?? null; })()`,
    { timeoutMs: 30_000, label: 'Session sessionDir populated' }
  );
}

/** Total size (bytes) and line count across every `__advisor*.jsonl` belonging to THIS Session
 * right now -- `folderExists: false`, 0/0 when the advisor has not produced a single finalized
 * review yet (confirmed live: right after an off-phase turn with no review run, `sessionDir`
 * holds ONLY the Conversation's own `.jsonl` file -- no sibling artifacts folder exists at all
 * yet). The folder appears LAZILY, created only once the advisor actually writes to it: it
 * shares the current Conversation file's own basename (no `.jsonl`), inside `sessionDir`, NOT
 * beside the `.jsonl` file the way `omp://advisor-watchdog.md`'s own "<session>/__advisor.jsonl"
 * wording reads at a glance. Re-derives the folder name fresh on every call (never cached), so a
 * caller polling this across a real turn self-heals the instant the folder is created. Reads the
 * REAL host filesystem directly (Node `fs`, not the renderer): this lives under OMP's own
 * session store, not Refract's own scratch data dir, so it survives this probe's own cleanup. */
function measureAdvisorFiles(sessionDir) {
  let conversationFile;
  try {
    conversationFile = readdirSync(sessionDir).find((f) => f.endsWith('.jsonl') && !f.startsWith('__advisor'));
  } catch {
    return { folderExists: false, files: [], totalBytes: 0, totalLines: 0 };
  }
  if (!conversationFile) return { folderExists: false, files: [], totalBytes: 0, totalLines: 0 };
  const artifactsDir = path.join(sessionDir, conversationFile.slice(0, -'.jsonl'.length));
  if (!existsSync(artifactsDir)) return { folderExists: false, files: [], totalBytes: 0, totalLines: 0 };
  const files = readdirSync(artifactsDir).filter((f) => /^__advisor.*\.jsonl$/.test(f));
  let totalBytes = 0;
  let totalLines = 0;
  for (const f of files) {
    const full = path.join(artifactsDir, f);
    const stat = statSync(full);
    totalBytes += stat.size;
    const content = readFileSync(full, 'utf8');
    totalLines += content.split('\n').filter((l) => l.trim().length > 0).length;
  }
  return { folderExists: true, files, totalBytes, totalLines };
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

    // ---- Phase 1: /advisor on (explicit, even though the ambient profile may already default
    // to it), warm-up turn, second turn -- establishes the file exists and grows at all ----
    const onReply1 = await sendSlashCommand(cdp, '/advisor on');
    findings.push(`Phase 1 "/advisor on" literal reply: ${JSON.stringify(onReply1)}`);
    const sessionDir = await getSessionDir(cdp);
    findings.push(`Session dir: ${sessionDir}`);
    const beforePhase1 = measureAdvisorFiles(sessionDir);
    findings.push(
      `Phase 1 (ON) baseline before any turn: folderExists=${beforePhase1.folderExists} files=${JSON.stringify(beforePhase1.files)} bytes=${beforePhase1.totalBytes} lines=${beforePhase1.totalLines}`
    );
    await sendRealTurn(cdp, 't917symon1warmup');
    await sendRealTurn(cdp, 't917symon1turn');
    findings.push('Phase 1 (ON): warm-up turn then a second real turn both completed.');
    const afterPhase1 = await pollForGrowth(sessionDir, beforePhase1, 60_000);
    findings.push(
      `Phase 1 (ON) after warm-up + second turn (polled up to 60s): folderExists=${afterPhase1.folderExists} files=${JSON.stringify(afterPhase1.files)} bytes=${afterPhase1.totalBytes} lines=${afterPhase1.totalLines}`
    );
    const grewInPhase1 = afterPhase1.totalBytes > beforePhase1.totalBytes || afterPhase1.totalLines > beforePhase1.totalLines;

    // ---- Phase 2: /advisor off, literal /advisor status reply (nothing in between), then the
    // IDENTICAL warm-up turn + second turn treatment -- off is proven only if this does NOT
    // grow past where Phase 1 left off ----
    const offReply = await sendSlashCommand(cdp, '/advisor off');
    findings.push(`Phase 2 "/advisor off" literal reply: ${JSON.stringify(offReply)}`);
    const statusAfterOff = await sendSlashCommand(cdp, '/advisor status');
    findings.push(`Phase 2 "/advisor status" literal reply right after off (nothing in between): ${JSON.stringify(statusAfterOff)}`);
    const beforePhase2 = afterPhase1;
    await sendRealTurn(cdp, 't917symoffwarmup');
    await sendRealTurn(cdp, 't917symoffturn');
    findings.push('Phase 2 (OFF): warm-up turn then a second real turn both completed.');
    const afterPhase2 = await pollForGrowth(sessionDir, beforePhase2, 60_000);
    findings.push(
      `Phase 2 (OFF) after warm-up + second turn (polled up to 60s, compared against Phase 1's own end state): files=${JSON.stringify(afterPhase2.files)} bytes=${afterPhase2.totalBytes} lines=${afterPhase2.totalLines}`
    );
    const grewInPhase2 = afterPhase2.totalBytes > beforePhase2.totalBytes || afterPhase2.totalLines > beforePhase2.totalLines;

    // ---- Phase 3 (optional confirmation): /advisor on again, warm-up turn, second turn --
    // growth should resume if off in Phase 2 genuinely paused it rather than something else
    // having silently stopped the advisor for good ----
    const onReply2 = await sendSlashCommand(cdp, '/advisor on');
    findings.push(`Phase 3 "/advisor on" (again) literal reply: ${JSON.stringify(onReply2)}`);
    const beforePhase3 = afterPhase2;
    await sendRealTurn(cdp, 't917symon2warmup');
    await sendRealTurn(cdp, 't917symon2turn');
    findings.push('Phase 3 (ON again): warm-up turn then a second real turn both completed.');
    const afterPhase3 = await pollForGrowth(sessionDir, beforePhase3, 60_000);
    findings.push(
      `Phase 3 (ON again) after warm-up + second turn (polled up to 60s): files=${JSON.stringify(afterPhase3.files)} bytes=${afterPhase3.totalBytes} lines=${afterPhase3.totalLines}`
    );
    const grewInPhase3 = afterPhase3.totalBytes > beforePhase3.totalBytes || afterPhase3.totalLines > beforePhase3.totalLines;

    // ---- Conclusion, from the measured deltas only -- "is running" stays unexplained unless
    // the evidence actually shows what it means ----
    let conclusion;
    if (!grewInPhase1) {
      failures.push(
        `Phase 1 (ON, warm-up + second turn) did NOT grow the file at all (stayed at bytes=${beforePhase1.totalBytes}, lines=${beforePhase1.totalLines}): inconclusive baseline -- cannot test whether OFF stops reviews when nothing confirms ON runs them in the first place under this exact two-turn treatment.`
      );
      conclusion = 'INCONCLUSIVE: the ON baseline itself never grew the file.';
    } else if (grewInPhase2) {
      failures.push(
        `The file GREW in Phase 2 (OFF, warm-up + second turn: bytes ${beforePhase2.totalBytes} -> ${afterPhase2.totalBytes}, lines ${beforePhase2.totalLines} -> ${afterPhase2.totalLines}), under the SAME two-turn treatment that grew it in Phase 1 (ON): "/advisor off" does NOT appear to stop the advisor from reviewing turns, contradicting omp://advisor-watchdog.md's own documented behaviour ("stop its runtimes"). This is either an omp behaviour or a Refract forwarding bug -- #917 cannot claim off works until this is resolved.`
      );
      conclusion = 'FALSIFIED: off did not stop reviews (symmetric comparison).';
    } else {
      findings.push(
        `CONFIRMED by symmetric file evidence: Phase 1 (ON, warm-up + second turn) grew the file (bytes ${beforePhase1.totalBytes} -> ${afterPhase1.totalBytes}, lines ${beforePhase1.totalLines} -> ${afterPhase1.totalLines}). Phase 2 (OFF, the IDENTICAL warm-up + second turn treatment) did NOT grow it at all (stayed at bytes=${afterPhase2.totalBytes}, lines=${afterPhase2.totalLines}). Since both phases got the exact same two-turn treatment, the only variable that differs is the on/off state itself -- "/advisor off" genuinely stops the advisor from running a review for a turn.${grewInPhase3 ? ` Phase 3 (ON again, same two-turn treatment) resumed growth (bytes ${beforePhase3.totalBytes} -> ${afterPhase3.totalBytes}, lines ${beforePhase3.totalLines} -> ${afterPhase3.totalLines}), confirming the pause in Phase 2 was the toggle, not something else having silently stopped the advisor for good.` : ' Phase 3 (ON again, same two-turn treatment) did NOT resume growth, which is odd given Phase 1 worked under the identical treatment -- left unexplained rather than guessed at.'} The meaning of the status reply "Advisor \\"default\\" is running." observed right after off is NOT established by this evidence either way -- it is a real, literal reply that differs from "Advisor is enabled (...)", but this probe does not know what "running" refers to and does not guess.`
      );
      conclusion = grewInPhase3
        ? 'CONFIRMED: off stops reviews, on resumes them (symmetric warm-up+turn comparison in all three phases).'
        : 'CONFIRMED (off stops reviews, Phases 1 vs 2) but Phase 3 did not resume growth -- partially confirmed, the resumption itself unproven this run.';
    }
    findings.push(`CONCLUSION: ${conclusion}`);

    const report = {
      gitHead: gitHeadSha,
      exeSha256: exeHash,
      sessionDir,
      beforePhase1,
      afterPhase1,
      afterPhase2,
      afterPhase3,
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
