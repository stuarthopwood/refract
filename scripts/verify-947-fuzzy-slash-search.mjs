#!/usr/bin/env node
// Live CDP check for issues #947 (fuzzy slash-command search) and #938 items 1 and 4 (slash
// subcommand step; a command reply no longer stretching the previous turn's own shown time),
// required before the draft PR. Modelled on `verify-917-advisor-command.mjs`'s own structure and
// isolation posture.
//
// Drives a REAL `omp` (ambient already-signed-in default profile; no scratch OMP_PROFILE
// override -- only Refract's OWN data, `REFRACT_DATA_DIR`, is scratch). Checks, in order:
// (1) fuzzy ranking -- typing `/fst` (no prefix, word-start, or substring match against "fast",
// only a subsequence one: f-a-s-t contains f, s, t in order) surfaces the built-in `fast`
// command with at least one bolded span in its rendered name (FR-072); (2) the subcommand step
// -- selecting `/advisor` leaves the composer reading `/advisor ` instead of sending, the menu's
// own accessible name becomes "/advisor subcommands", and its first row is `status` with nothing
// typed yet (FR-073); selecting that subcommand completes `/advisor status ` without sending;
// (3) a real turn's own total-time line (the "`Turn took <N>`" sr-only text) does not change
// after a command reply (`/advisor status`, this story's #938 item 4 fix) arrives once that
// turn has already settled -- asserted by reading the SAME line's text before and after the
// command, not merely that the command's own reply arrived.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, launchBuiltExe, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import { pressKey } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR =
  process.env.REFRACT_947_SHOTS_DIR || path.join(tmpdir(), 'refract-947-slash-search-shots', new Date().toISOString().replace(/[:.]/g, '-'));

const TRANSCRIPT = `document.querySelector('[aria-label="Transcript"]')`;

// Same `NoticeRow` sr-only "Info:" icon-slot finder `verify-917-advisor-command.mjs` uses, for
// the same reasons (survives `react-virtuoso` windowing; two-parent climb reaches either the
// plain-div short-notice or the `CollapsibleTrigger`-button long-notice container).
const NOTICE_FINDER =
  `Array.from(document.querySelectorAll('span.sr-only')).filter((el) => (el.textContent ?? '').trim() === 'Info:').map((el) => el.parentElement?.parentElement).filter(Boolean)`;

async function allNoticeTexts(cdp) {
  return cdp.evaluate(`(${NOTICE_FINDER}).map((row) => (row.querySelector(':scope > span.min-w-0.flex-1')?.textContent ?? '').trim())`);
}

async function countNotices(cdp) {
  return cdp.evaluate(`(${NOTICE_FINDER}).length`);
}

// The turn-total-time line (`Transcript.tsx`'s `TurnTotalLine`, FR-046): found by its own
// sr-only "Turn took <N>" text, never by the bare visible "<N>" span alone (which this script
// would otherwise confuse with any other short muted text on the page). The LAST one in document
// order is the most recent turn's own line.
const TURN_TOTAL_FINDER =
  `Array.from(document.querySelectorAll('[aria-label="Transcript"] div')).filter((el) => (el.querySelector(':scope > span.sr-only')?.textContent ?? '').startsWith('Turn took'))`;

async function readLatestTurnTotalText(cdp) {
  return cdp.evaluate(
    `(() => { const rows = (${TURN_TOTAL_FINDER}); const row = rows[rows.length - 1]; return row ? (row.querySelector(':scope > span[aria-hidden="true"]')?.textContent ?? null) : null; })()`
  );
}

/** Real Backspace keydown/keyup pairs, one per character currently in the composer (same
 * reasoning `verify-917-advisor-command.mjs`'s own `clearComposer` records). */
async function clearComposer(cdp) {
  const current = await cdp.evaluate(`document.querySelector('[aria-label="Message"]')?.value ?? ''`);
  for (let i = 0; i < current.length; i++) {
    await pressKey(cdp, 8, 'Backspace', 'Backspace');
  }
  await cdp.waitFor(`(document.querySelector('[aria-label="Message"]')?.value ?? '') === ''`, { timeoutMs: 5_000, label: 'Composer cleared' });
}

async function pressEnter(cdp) {
  await pressKey(cdp, 13, 'Enter', 'Enter');
}

/** Reads whichever slash-menu listbox is mounted (top-level or a subcommand step share the same
 * markup): its own accessible name and each option row's name text, whether that name carries at
 * least one `<b>` span, and its description. `null` when no slash menu is mounted. */
async function readSlashMenu(cdp) {
  return cdp.evaluate(
    `(() => {
      const list = document.querySelector('ul[aria-label="Slash commands"], ul[aria-label$=" subcommands"]');
      if (!list) return null;
      return {
        ariaLabel: list.getAttribute('aria-label'),
        options: Array.from(list.querySelectorAll('li[role="option"]')).map((li) => {
          const nameEl = li.querySelector('span.font-medium');
          return {
            name: (nameEl?.textContent ?? '').trim(),
            hasBold: !!nameEl?.querySelector('b'),
            description: (li.querySelector('span.text-muted-foreground')?.textContent ?? '').trim()
          };
        })
      };
    })()`
  );
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
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-947-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-947-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-947-repo-')), 'verify-947-fuzzy-slash-search');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-947-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-947-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, approvalMode: 'auto' }));
    const port = await getFreePort();
    gitHeadSha = gitHead(REPO_ROOT);

    console.log(`verify-947: git HEAD ${gitHeadSha}`);
    console.log(`verify-947: data dir ${dataDir}`);
    console.log(`verify-947: shots dir ${SHOTS_DIR}`);
    console.log(`verify-947: CDP port ${port}`);

    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-947' });
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app.log') });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-947: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
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

    // ---- (1) Fuzzy ranking (#947, FR-072): "/fst" matches "fast" only as a subsequence (no
    // prefix, word-start, or substring match is possible), proving the new scorer's own
    // lowest-priority tier actually runs, and that the matched letters render bolded ----
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);
    await cdp.send('Input.insertText', { text: '/fst' });
    try {
      await cdp.waitFor(
        `!!Array.from(document.querySelectorAll('ul[aria-label="Slash commands"] li[role="option"] span.font-medium')).find((el) => el.textContent.trim() === 'fast')`,
        { timeoutMs: 15_000, label: 'Slash menu lists "fast" for the subsequence query "/fst"' }
      );
      const hasBold = await cdp.evaluate(
        `!!Array.from(document.querySelectorAll('ul[aria-label="Slash commands"] li[role="option"]')).find((el) => (el.querySelector('span.font-medium')?.textContent ?? '').trim() === 'fast')?.querySelector('span.font-medium b')`
      );
      if (!hasBold) {
        failures.push('"/fst" listed "fast" but with no bolded span in its name -- matched characters are not shown bold (FR-072 decision 5).');
      } else {
        findings.push('"/fst" (prefix/word-start/substring all impossible against "fast") listed "fast" with a bolded match span -- the subsequence tier runs and renders bold.');
      }
    } catch {
      failures.push('Typing "/fst" never listed "fast" within 15s -- the subsequence tier (FR-072) does not appear to run, or "fast" is not offered by this OMP install.');
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '00-fuzzy-subsequence.png'));
    await clearComposer(cdp);

    // ---- (2) Subcommand step (#938 item 1, FR-073): choosing "/advisor" does not send it; the
    // menu advances to a second step naming "/advisor subcommands", "status" first ----
    await cdp.send('Input.insertText', { text: '/advisor' });
    await cdp.waitFor(
      `!!Array.from(document.querySelectorAll('ul[aria-label="Slash commands"] li[role="option"] span.font-medium')).find((el) => el.textContent.trim() === '/advisor')`,
      { timeoutMs: 15_000, label: 'Slash menu lists "/advisor"' }
    );
    await pressEnter(cdp); // selects /advisor -- should NOT send; should advance to its subcommand step
    const afterParentSelect = await cdp.waitFor(`document.querySelector('[aria-label="Message"]')?.value ?? ''`, {
      timeoutMs: 10_000,
      label: 'Composer value settles after selecting "/advisor"'
    });
    if (afterParentSelect !== '/advisor ') {
      failures.push(`Selecting "/advisor" left the composer reading "${afterParentSelect}", not "/advisor " -- it may have sent immediately instead of advancing to the subcommand step.`);
    }
    let subMenu = null;
    try {
      await cdp.waitFor(`!!document.querySelector('ul[aria-label$=" subcommands"]')`, { timeoutMs: 10_000, label: 'Subcommand step menu mounted' });
      subMenu = await readSlashMenu(cdp);
    } catch {
      failures.push('The subcommand step menu never mounted after selecting "/advisor".');
    }
    if (subMenu && subMenu.ariaLabel !== '/advisor subcommands') {
      failures.push(`Expected the subcommand step's own accessible name "/advisor subcommands"; got ${JSON.stringify(subMenu.ariaLabel)}.`);
    } else if (subMenu) {
      findings.push(`Subcommand step mounted with accessible name "${subMenu.ariaLabel}".`);
    }
    if (subMenu && subMenu.options[0]?.name !== 'status') {
      failures.push(`Expected "status" first in the untyped subcommand step; got ${JSON.stringify(subMenu.options.map((o) => o.name))}.`);
    } else if (subMenu) {
      findings.push(`Subcommand step lists "status" first (options: ${JSON.stringify(subMenu.options.map((o) => o.name))}).`);
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '01-subcommand-step.png'));
    if (subMenu) {
      await pressEnter(cdp); // selects "status" (first row) -- should complete the text, not send
      const afterSubSelect = await cdp.waitFor(`document.querySelector('[aria-label="Message"]')?.value ?? ''`, {
        timeoutMs: 10_000,
        label: 'Composer value settles after selecting "status"'
      });
      if (afterSubSelect !== '/advisor status ') {
        failures.push(`Selecting "status" left the composer reading "${afterSubSelect}", not "/advisor status ".`);
      } else {
        findings.push('Selecting "status" completed the composer to "/advisor status " without sending -- the subcommand step\'s own Enter only completes text, exactly like the top-level step.');
      }
      await cdp.screenshot(path.join(SHOTS_DIR, '02-subcommand-completed.png'));
    } else {
      notExercised.push('Selecting a subcommand was not exercised -- the subcommand step menu never mounted (see the failure above).');
    }

    // ---- (3) A real turn, then a command reply that must NOT stretch its own turn-total-time
    // line (#938 item 4, amended FR-046) ----
    await clearComposer(cdp);
    await cdp.typeIntoByLabel('Message', "Reply with exactly the single word 't947turn' and nothing else.");
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(
      `(() => { const t = (${TRANSCRIPT}); return !!t && (t.textContent.match(/t947turn/g) ?? []).length >= 2; })()`,
      { timeoutMs: 180_000, label: 'Turn (t947turn) finished (assistant echoed the sentinel back)' }
    );
    let elapsedBefore = null;
    try {
      await cdp.waitFor(`(${TURN_TOTAL_FINDER}).length > 0`, { timeoutMs: 30_000, label: 'Turn-total-time line mounted' });
      elapsedBefore = await readLatestTurnTotalText(cdp);
    } catch {
      // fall through: handled by the null check below
    }
    if (!elapsedBefore) {
      notExercised.push('No turn-total-time line was found after the sentinel turn settled -- the live-time-stretch check below could not run.');
    } else {
      findings.push(`Turn-total-time line reads "${elapsedBefore}" right after the sentinel turn settled.`);
      await cdp.screenshot(path.join(SHOTS_DIR, '03-turn-settled.png'));
      await new Promise((resolve) => setTimeout(resolve, 3_000)); // real wall-clock gap before the command reply, so a bug WOULD visibly grow the line
      const before = await countNotices(cdp);
      await clearComposer(cdp);
      await cdp.typeIntoByLabel('Message', '/advisor status');
      await cdp.clickByLabel('Send message');
      const deadline = Date.now() + 30_000;
      let replyText = null;
      while (Date.now() < deadline) {
        const texts = await allNoticeTexts(cdp);
        const match = texts.slice(before).find((t) => /advisor/i.test(t));
        if (match) {
          replyText = match;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!replyText) {
        notExercised.push('"/advisor status" produced no notice within 30s after the settled turn -- the time-stretch check could not confirm a reply actually arrived.');
      } else {
        findings.push(`"/advisor status" (sent after the turn settled) produced: ${JSON.stringify(replyText)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000)); // settle time for computeTurnEnd's own re-commit
      const elapsedAfter = await readLatestTurnTotalText(cdp);
      await cdp.screenshot(path.join(SHOTS_DIR, '04-after-command-reply.png'));
      if (elapsedAfter !== elapsedBefore) {
        failures.push(`Turn-total-time line changed from "${elapsedBefore}" to "${elapsedAfter}" after the command reply -- the reply is still stretching the previous turn's own shown time.`);
      } else {
        findings.push(`Turn-total-time line is UNCHANGED ("${elapsedAfter}") after the command reply -- the reply no longer stretches the turn's own shown time.`);
      }
    }

    const report = { gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, notExercised, exitCode: failures.length > 0 ? 1 : 0 };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-947: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-947: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-947: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-947: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      writeFileSync(
        path.join(SHOTS_DIR, 'report.json'),
        JSON.stringify({ gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2)
      );
    } catch {
      // best-effort only
    }
    console.error('verify-947: FAILED:', err?.stack ?? err);
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
  console.error('verify-947: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
