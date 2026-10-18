#!/usr/bin/env node
// Live CDP check for issue #938's remaining items (2, 3, 5) after PR #954 shipped items 1 and 4;
// item 6 was resolved by static code audit (research.md decision 17, spec.md Clarifications), not
// a live probe, and is only recorded here, never asserted.
//
// Drives a REAL `omp` (ambient already-signed-in default profile; no scratch OMP_PROFILE
// override -- only Refract's OWN data, `REFRACT_DATA_DIR`, is scratch), the same isolation
// posture as `verify-917-advisor-command.mjs`/`verify-947-938-slash-menu.mjs`. The fake-omp
// shim's own recorded fixtures (`scripts/fixtures/omp-frames/*.jsonl`) are deliberately NOT used
// here: none of them lists a builtin command with verified subcommands at all (`session.jsonl`'s
// own `available_commands_update` offers only `new`/`tools`, neither of which has one), and
// AGENTS.md forbids adding a new fixture to manufacture one -- its own "fall back to a real omp
// only for a flow the fixtures do not cover yet" clause is exactly this case, and is the same
// reason #954's own `verify-947-938-slash-menu.mjs` (the sibling script for this same issue
// family) drove a real ambient `/advisor` rather than the shim.
//
// Checks, in order:
//   FR-083 (item 5): Settings > Model roles' Advisor row description mentions `/advisor on`.
//   FR-081 (item 2): typing an unverified `/advisor` subcommand and sending it produces a
//     refusal toast listing the REAL verified subcommands this ambient install reports (read via
//     `window.refract.chat.commands`, never hardcoded), in that install's own order -- not the
//     old generic "doesn't support arguments yet" wording.
//   FR-082 (item 3): `/advisor off`'s own short, deterministic "Advisor disabled." reply renders
//     as a `NoticeRow` whose summary span carries `whitespace-normal` (wraps in place), never
//     `truncate` -- across Dark, Obsidian, and Dark (high contrast), screenshotted each time.
//   Item 6: not reasserted live (resolved by static audit); recorded in `findings` only, citing
//     `research.md` decision 17.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import {
  gitHead,
  buildLauncher,
  makeScratchRepo,
  buildAndCopyExeFresh,
  launchBuiltExe,
  safeRmSync,
  requireSharedCargoTarget,
  sha256OfFile,
  switchTheme,
  clearKnownOutputFiles
} from './verify-tauri-scratch-helpers.mjs';
import { pressKey } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR =
  process.env.REFRACT_938_SHOTS_DIR || path.join(tmpdir(), 'refract-938-slash-rest-shots', new Date().toISOString().replace(/[:.]/g, '-'));
const SHOT_NAMES = [
  '00-settings-advisor-description.png',
  '01-refusal-toast.png',
  '02-notice-wrap-dark.png',
  '03-notice-wrap-obsidian.png',
  '04-notice-wrap-dark-high-contrast.png'
];

const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' }
];

// Same two-parent-climb pattern `verify-917-advisor-command.mjs`/`verify-947-938-helpers.mjs`
// use: `CollapsedLine` renders the icon-slot span and the summary span as direct siblings of
// either a plain `<div>` (a short notice) or a `<CollapsibleTrigger>` button (a long one); the
// sr-only "Info:" label's own icon-slot span, then that span's row container, lands on the right
// element either way.
const NOTICE_FINDER =
  `Array.from(document.querySelectorAll('span.sr-only')).filter((el) => (el.textContent ?? '').trim() === 'Info:').map((el) => el.parentElement?.parentElement).filter(Boolean)`;

async function allNoticeTexts(cdp) {
  return cdp.evaluate(`(${NOTICE_FINDER}).map((row) => (row.querySelector(':scope > span.min-w-0.flex-1')?.textContent ?? '').trim())`);
}

async function countNotices(cdp) {
  return cdp.evaluate(`(${NOTICE_FINDER}).length`);
}

/** The summary span's own `className` for the LAST mounted notice row -- used to confirm FR-082
 * (`whitespace-normal`, never `truncate`) without needing the real reply text to sit near the
 * 160-char threshold: any genuinely short, single-line notice exercises the same branch. */
async function lastNoticeSummaryClassName(cdp) {
  return cdp.evaluate(
    `(() => { const rows = (${NOTICE_FINDER}); const row = rows[rows.length - 1]; return row?.querySelector(':scope > span.min-w-0.flex-1')?.className ?? null; })()`
  );
}

/** Real Backspace keydown/keyup pairs, one per character currently in the composer -- clears a
 * controlled React textarea the way a user would. */
async function clearComposer(cdp) {
  const current = await cdp.evaluate(`document.querySelector('[aria-label="Message"]')?.value ?? ''`);
  for (let i = 0; i < current.length; i++) {
    await pressKey(cdp, 8, 'Backspace', 'Backspace');
  }
  await cdp.waitFor(`(document.querySelector('[aria-label="Message"]')?.value ?? '') === ''`, { timeoutMs: 5_000, label: 'Composer cleared' });
}

/** Sends `command` (via the real Send button, bypassing the slash menu's own Enter/Tab
 * completion routing entirely), then waits for a NEWLY-mounted notice whose text matches
 * `expectedPattern`. Same polling-past-an-unrelated-notice reasoning as
 * `verify-917-advisor-command.mjs`'s own `sendSlashCommand`. */
async function sendSlashCommand(cdp, command, expectedPattern) {
  await clearComposer(cdp);
  const before = await countNotices(cdp);
  await cdp.typeIntoByLabel('Message', command);
  await cdp.clickByLabel('Send message');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const texts = await allNoticeTexts(cdp);
    const match = texts.slice(before).find((t) => expectedPattern.test(t));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const allTexts = await allNoticeTexts(cdp);
  throw new Error(`sendSlashCommand: no notice matching ${expectedPattern} appeared within 60s for "${command}". All notices present at timeout: ${JSON.stringify(allTexts)}`);
}

async function openSettingsModelRoles(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings screen opened' });
  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Model roles')`);
  await cdp.waitFor(`!!document.getElementById('model-role-advisor-description')`, { timeoutMs: 10_000, label: 'Model roles section mounted (Advisor row)' });
}

async function closeSettings(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Returned from Settings to chat' });
}

// The refusal toast (`notify.ts` -> `toast.error`, Sonner): newest toast PREPENDS in DOM order
// (`verify-980-toast-send.mjs`'s own header comment records this), so the first match is the
// most recent.
async function readLatestToastText(cdp) {
  return cdp.evaluate(`document.querySelector('[data-sonner-toast]')?.textContent ?? null`);
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
    clearKnownOutputFiles(SHOTS_DIR, 'refract-938-slash-rest-shots', SHOT_NAMES);
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirty = gitStatusResult.status === 0 ? (gitStatusResult.stdout.split('\n').filter(Boolean).length ? gitStatusResult.stdout.split('\n').filter(Boolean) : false) : 'unknown';

    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-938-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-938-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-938-repo-')), 'verify-938-slash-rest');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-938-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-938-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, approvalMode: 'auto' }));
    const port = await getFreePort();

    console.log(`verify-938: git HEAD ${gitHeadSha}${dirty && dirty !== 'unknown' ? ` (DIRTY: ${dirty.length} path(s))` : ''}`);
    console.log(`verify-938: shots dir ${SHOTS_DIR}`);
    console.log(`verify-938: CDP port ${port}`);

    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-938' });
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app.log') });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-938: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
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

    const sessionId = await cdp.evaluate(`window.refract.sessions.list().then((r) => r.ok ? (r.value.find((s) => !s.archived)?.id ?? null) : null)`);
    if (!sessionId) throw new Error('verify-938: could not read the created Session\'s own id via window.refract.sessions.list()');

    // ==== FR-083 (item 5): Settings > Model roles' Advisor description mentions `/advisor on` ====
    await openSettingsModelRoles(cdp);
    const advisorDescription = await cdp.evaluate(`document.getElementById('model-role-advisor-description')?.textContent ?? null`);
    if (advisorDescription !== 'Reviews turns when the advisor is enabled (/advisor on in a Session); falls back to Slow.') {
      failures.push(`FR-083: Advisor role description reads ${JSON.stringify(advisorDescription)}, expected the exact FR-083 wording mentioning "/advisor on".`);
    } else {
      findings.push(`FR-083: Advisor role description reads exactly as specified: ${JSON.stringify(advisorDescription)}.`);
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '00-settings-advisor-description.png'));
    await closeSettings(cdp);

    // ==== FR-081 (item 2): refusal lists the REAL verified subcommands, in this install's own order ====
    const commandsResult = await cdp.evaluate(`window.refract.chat.commands(${JSON.stringify(sessionId)})`);
    const advisorCommand = commandsResult?.ok ? commandsResult.value.find((c) => c.name === 'advisor') : null;
    if (!advisorCommand) {
      notExercised.push(
        'FR-081: this ambient omp install does not list "/advisor" at all (issue #917\'s own evidence already records this as install-dependent) -- the refusal-lists-subcommands check could not be exercised; FR-032/FR-081\'s existing unit coverage (commands.test.rs) already proves the Rust logic directly.'
      );
    } else if (!advisorCommand.subcommands || advisorCommand.subcommands.length === 0) {
      notExercised.push(`FR-081: this install's own "/advisor" descriptor carries no verified subcommands (${JSON.stringify(advisorCommand)}) -- cannot exercise the "lists them" branch against it this run.`);
    } else {
      const subNames = advisorCommand.subcommands.map((s) => s.name);
      const expectedToast = `/advisor takes one of: ${subNames.join(', ')}.`;
      await clearComposer(cdp);
      await cdp.typeIntoByLabel('Message', '/advisor 000bogus000');
      await cdp.clickByLabel('Send message');
      const toastText = await cdp.waitFor(`document.querySelector('[data-sonner-toast]')?.textContent ?? null`, {
        timeoutMs: 15_000,
        label: 'Refusal toast mounted'
      });
      if (toastText !== expectedToast) {
        failures.push(`FR-081: refusal toast read ${JSON.stringify(toastText)}, expected ${JSON.stringify(expectedToast)} (computed from this install's own real "/advisor" subcommand list).`);
      } else {
        findings.push(`FR-081: "/advisor 000bogus000" refused with the real subcommand list: ${JSON.stringify(toastText)}.`);
      }
      await cdp.screenshot(path.join(SHOTS_DIR, '01-refusal-toast.png'));
      await clearComposer(cdp);
    }

    // ==== FR-082 (item 3): a short notice's summary wraps (`whitespace-normal`), never truncates ====
    await sendSlashCommand(cdp, '/advisor off', /Advisor disabled\./);
    for (const theme of THEMES) {
      await switchTheme(cdp, theme.id, theme.name);
      const className = await lastNoticeSummaryClassName(cdp);
      if (className === null) {
        failures.push(`FR-082 (${theme.name}): no notice row found after "/advisor off".`);
        continue;
      }
      if (className.includes('truncate')) {
        failures.push(`FR-082 (${theme.name}): the short notice's summary span still carries "truncate" (className: ${JSON.stringify(className)}) -- summaryWrap did not land.`);
      } else if (!className.includes('whitespace-normal')) {
        failures.push(`FR-082 (${theme.name}): the short notice's summary span carries neither "truncate" nor "whitespace-normal" (className: ${JSON.stringify(className)}) -- unexpected class shape.`);
      } else {
        findings.push(`FR-082 (${theme.name}): the short notice's summary span wraps (className: ${JSON.stringify(className)}), never truncates.`);
      }
      const shotName = theme.id === 'dark' ? '02-notice-wrap-dark.png' : theme.id === 'obsidian' ? '03-notice-wrap-obsidian.png' : '04-notice-wrap-dark-high-contrast.png';
      await cdp.screenshot(path.join(SHOTS_DIR, shotName));
    }

    // ==== Item 6 (possible duplicate render): resolved by static code audit, not a live probe ====
    findings.push(
      'Item 6 (possible duplicate render) was investigated by static code audit, not a live probe: ' +
      '`build_assistant_items`/`apply_message_snapshot`/`replace_message_items` (src-tauri/src/omp/transcript.rs) ' +
      'apply every assistant message snapshot as a full replace keyed by message_id/message_id:index, so no code ' +
      'path can render one content index twice for one message. The real cause of the #917/#954 screenshots\' ' +
      'doubled sentinel text: both live-check scripts wait for the sentinel word twice as their own "turn ' +
      'finished" signal, and the typed PROMPT itself contains the sentinel word once as an instruction -- the ' +
      'second occurrence is the assistant\'s own one-time echoed reply, not a duplicate render. Recorded in ' +
      'research.md decision 17 and spec.md\'s 2026-10-18 Clarifications session; no code change, nothing to ' +
      'assert live.'
    );

    const report = {
      gitHead: gitHeadSha,
      dirty,
      exeSha256: exeHash,
      scriptSha256: sha256OfFile(fileURLToPath(import.meta.url)),
      findings,
      failures,
      notExercised,
      exitCode: failures.length > 0 ? 1 : 0
    };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-938: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-938: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-938: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-938: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
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
    console.error('verify-938: FAILED:', err?.stack ?? err);
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
  console.error('verify-938: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
