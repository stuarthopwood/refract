#!/usr/bin/env node
// Live CDP check for issue #917 (allow `/advisor` on/off/status per Session), required before
// the draft PR. `/advisor` was never run by `docs/spike/slash-commands-probe.mjs` (its own
// `DENYLIST` names it), so this script stands in for that probe's own verification bar
// (FR-032), the same precedent `verify-558-blocker-callout.mjs` already set for the advisor
// subsystem generally (its own header comment records: "an earlier draft wrongly assumed RPC
// hosts always start the advisor disabled, filed as #917").
//
// Drives a REAL `omp` (ambient already-signed-in default profile; no scratch OMP_PROFILE
// override, matching #558/#570/#557's own isolation posture: only Refract's OWN data,
// `REFRACT_DATA_DIR`, is scratch). Checks, in order: the slash-command menu lists `advisor`
// with a non-empty description (FR-032); `/advisor off` then `/advisor status` (expecting
// "disabled") proves the off direction; `/advisor on` then `/advisor status` (expecting
// "enabled") proves the on direction -- each reply is asserted against its own exact pattern,
// not just a loose "/advisor/i" substring match; a real turn runs with the advisor left on and
// is recorded whether a real advisory row arrives (the advisor's own judgement, never forced or
// guaranteed by this script); `/advisor off` runs once more at the end to leave the Session in a
// known state.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, launchBuiltExe, safeRmSync } from './verify-tauri-scratch-helpers.mjs';
import { pressKey } from './verify-tauri-session-list-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR;
const BUILD_OUTPUT_DIR = CARGO_TARGET_DIR ? path.join(CARGO_TARGET_DIR, 'debug') : path.join(REPO_ROOT, 'src-tauri', 'target', 'debug');
const SHOTS_DIR =
  process.env.REFRACT_917_SHOTS_DIR || path.join(tmpdir(), 'refract-917-advisor-shots', new Date().toISOString().replace(/[:.]/g, '-'));

const TRANSCRIPT = `document.querySelector('[aria-label="Transcript"]')`;

// `NoticeRow` (a `command.send` reply becomes a `command_output` -> `notice` transcript item,
// `ui-architect-v3`'s own correction to this story's brief) is the one `CollapsedLine` consumer
// whose icon slot carries an sr-only "Info:" label (`NOTICE_LABEL.info`) -- every `command.send`
// reply observed live renders at `level: Info` (never `Warning`/`Error`), so counting only
// `Info:` rows avoids ever mismatching an unrelated warning/error notice as an advisor reply.
// Unlike the whole-transcript textContent length this script used in an earlier draft, counting
// and reading THESE specific rows survives `react-virtuoso`'s windowing (only mounted, visible
// rows are ever queried) and whatever reflow an adjacent row's own re-render causes elsewhere.
// `CollapsedLine` renders the icon-slot span and the summary span as siblings, as DIRECT
// children of either a plain `<div>` (a short notice, `text.length <= 160` and no `\n`) or a
// `<CollapsibleTrigger>` `<button>` (a long one, #565's `isLong` branch) -- climbing exactly two
// parents from the sr-only label (its own icon-slot span, then that span's row container) lands
// on the right container either way, unlike `.closest('div')`, which skips past a button-rooted
// long notice to an OUTER wrapper div that does not hold the summary as a direct child.
const NOTICE_FINDER =
  `Array.from(document.querySelectorAll('span.sr-only')).filter((el) => (el.textContent ?? '').trim() === 'Info:').map((el) => el.parentElement?.parentElement).filter(Boolean)`;

async function countNotices(cdp) {
  return cdp.evaluate(`(${NOTICE_FINDER}).length`);
}

async function allNoticeTexts(cdp) {
  return cdp.evaluate(`(${NOTICE_FINDER}).map((row) => (row.querySelector(':scope > span.min-w-0.flex-1')?.textContent ?? '').trim())`);
}

/** Real Backspace keydown/keyup pairs, one per character currently in the composer -- clears a
 * controlled React textarea the same way a user would (never a direct DOM/store poke), so a
 * fresh command can be typed into an empty field without racing the click-to-focus cursor
 * position a second `Input.insertText` call would otherwise land at. */
async function clearComposer(cdp) {
  const current = await cdp.evaluate(`document.querySelector('[aria-label="Message"]')?.value ?? ''`);
  for (let i = 0; i < current.length; i++) {
    await pressKey(cdp, 8, 'Backspace', 'Backspace');
  }
  await cdp.waitFor(`(document.querySelector('[aria-label="Message"]')?.value ?? '') === ''`, { timeoutMs: 5_000, label: 'Composer cleared' });
}

/** Sends `command`, then waits for a NEWLY-mounted notice (index >= the pre-send count) whose
 * text matches `expectedPattern` -- a per-command exact pattern (`/Advisor enabled\./`,
 * `/Advisor disabled\./`, `/^Advisor is (enabled|disabled)/`), not simply the latest notice by
 * index or a loose "mentions advisor" substring test, because this ambient signed-in profile's
 * own session occasionally mounts an unrelated system notice (e.g. its own MCP tool list) within
 * the same short window, which can race ahead of the real `/advisor` reply and would otherwise
 * be misread as the command's own output. Keeps polling past an unrelated new notice instead of
 * accepting the first growth alone. Throws (rather than returning a wrong match) when the
 * pattern never appears within the deadline. */
async function sendSlashCommand(cdp, command, expectedPattern) {
  await clearComposer(cdp);
  const before = await countNotices(cdp);
  await cdp.typeIntoByLabel('Message', command);
  await cdp.clickByLabel('Send message');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const texts = await allNoticeTexts(cdp);
    const match = texts.slice(before).find((t) => expectedPattern.test(t));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`sendSlashCommand: no notice matching ${expectedPattern} appeared within 30s for "${command}"`);
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
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-917-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-917-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-917-repo-')), 'verify-917-advisor-command');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-917-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-917-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, approvalMode: 'auto' }));
    const port = await getFreePort();
    gitHeadSha = gitHead(REPO_ROOT);

    console.log(`verify-917: git HEAD ${gitHeadSha}`);
    console.log(`verify-917: data dir ${dataDir}`);
    console.log(`verify-917: shots dir ${SHOTS_DIR}`);
    console.log(`verify-917: CDP port ${port}`);

    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: 'verify-917' });
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    const launched = await launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile: path.join(exeDir, 'app.log') });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-917: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
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

    // ---- Slash menu lists `advisor` with a non-empty description (FR-032) ----
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);
    await cdp.send('Input.insertText', { text: '/advisor' });
    const menuResult = await cdp.waitFor(
      `(() => {
        const items = Array.from(document.querySelectorAll('ul[aria-label="Slash commands"] li[role="option"]'));
        const item = items.find((el) => (el.querySelector('span.font-medium')?.textContent ?? '').trim() === '/advisor');
        if (!item) return null;
        return { description: (item.querySelector('span.text-muted-foreground')?.textContent ?? '').trim() };
      })()`,
      { timeoutMs: 15_000, label: 'Slash menu lists /advisor' }
    );
    if (!menuResult.description) {
      failures.push('Slash menu lists `advisor` but with an empty description.');
    } else {
      findings.push(`Slash menu lists "/advisor" with description "${menuResult.description}" (real text from OMP's own get_available_commands).`);
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '00-slash-menu.png'));
    await clearComposer(cdp);

    // ---- /advisor off, then /advisor status (expect "disabled") -- proves the off direction ----
    const offReply1 = await sendSlashCommand(cdp, '/advisor off', /Advisor disabled\./);
    findings.push(`"/advisor off" produced: ${JSON.stringify(offReply1)}`);
    await cdp.screenshot(path.join(SHOTS_DIR, '01-advisor-off.png'));

    const statusAfterOff = await sendSlashCommand(cdp, '/advisor status', /^Advisor is (enabled|disabled)/);
    if (!/^Advisor is disabled/.test(statusAfterOff)) {
      failures.push(`"/advisor status" after "/advisor off" reported "${statusAfterOff}", expected it to start with "Advisor is disabled".`);
    } else {
      findings.push(`"/advisor status" after off confirms disabled: ${JSON.stringify(statusAfterOff)}`);
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '02-advisor-status-disabled.png'));

    // ---- /advisor on, then /advisor status (expect "enabled") -- proves the on direction ----
    const onReply = await sendSlashCommand(cdp, '/advisor on', /Advisor enabled\./);
    findings.push(`"/advisor on" produced: ${JSON.stringify(onReply)}`);
    await cdp.screenshot(path.join(SHOTS_DIR, '03-advisor-on.png'));

    const statusAfterOn = await sendSlashCommand(cdp, '/advisor status', /^Advisor is (enabled|disabled)/);
    if (!/^Advisor is enabled/.test(statusAfterOn)) {
      failures.push(`"/advisor status" after "/advisor on" reported "${statusAfterOn}", expected it to start with "Advisor is enabled".`);
    } else {
      findings.push(`"/advisor status" after on confirms enabled: ${JSON.stringify(statusAfterOn)}`);
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '04-advisor-status-enabled.png'));

    // ---- A real turn, and whether a real advisory row arrives (never forced) ----
    const ADVISORY_FINDER =
      `Array.from(document.querySelectorAll('[aria-label="Transcript"] button, [aria-label="Transcript"] div[tabindex]')).filter((el) => { const label = el.querySelector('span.font-medium'); return label && ['Blocker','Concern','Nit'].includes(label.textContent.trim()); })`;
    const advisoriesBefore = await cdp.evaluate(`(${ADVISORY_FINDER}).length`);
    await clearComposer(cdp);
    await cdp.typeIntoByLabel('Message', "Reply with exactly the single word 't917turn' and nothing else.");
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(
      `(() => { const t = (${TRANSCRIPT}); return !!t && (t.textContent.match(/t917turn/g) ?? []).length >= 2; })()`,
      { timeoutMs: 180_000, label: 'Turn (t917turn) finished (assistant echoed the sentinel back)' }
    );
    findings.push('A real turn completed while the advisor was toggled on for this Session.');
    try {
      await cdp.waitFor(`(${ADVISORY_FINDER}).length > ${advisoriesBefore}`, { timeoutMs: 60_000, label: 'New advisory row after the turn' });
      const severity = await cdp.evaluate(
        `(() => { const items = (${ADVISORY_FINDER}); const el = items[items.length - 1]; return el.querySelector('span.font-medium')?.textContent?.trim() ?? null; })()`
      );
      findings.push(`A real advisory row arrived after the turn (severity "${severity}") -- the advisor is confirmed running for this Session.`);
      await cdp.screenshot(path.join(SHOTS_DIR, '05-advisory-arrived.png'));
    } catch {
      notExercised.push(
        'No advisory row arrived within 60s of the turn settling -- the advisor\'s own judgement decides whether a turn warrants a note, never caller-controlled or guaranteed; stated plainly rather than assumed.'
      );
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '06-after-turn.png'));

    // ---- /advisor off (final) -- leaves the Session in a known state ----
    const offReply2 = await sendSlashCommand(cdp, '/advisor off', /Advisor disabled\./);
    findings.push(`"/advisor off" (final) produced: ${JSON.stringify(offReply2)}`);
    await cdp.screenshot(path.join(SHOTS_DIR, '07-advisor-off-final.png'));

    notExercised.push(
      'Session scope and non-persistence ("session-scoped; not persisted to config", omp://advisor-watchdog.md) were not independently proven live -- this run never opened a second Session or re-read the on-disk config file to confirm the toggle neither leaked to a sibling Session nor survived a restart; taken on the documented behaviour.'
    );

    const report = { gitHead: gitHeadSha, exeSha256: exeHash, findings, failures, notExercised, exitCode: failures.length > 0 ? 1 : 0 };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== verify-917: FAILURES (always fail the run) ===');
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log('\n=== verify-917: FINDINGS ===');
    for (const f of findings) console.log(`- ${f}`);
    console.log('\n=== verify-917: NOT EXERCISED (genuine skips only) ===');
    if (notExercised.length === 0) console.log('(none)');
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`verify-917: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
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
    console.error('verify-917: FAILED:', err?.stack ?? err);
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
  console.error('verify-917: unhandled error:', err?.stack ?? err);
  process.exitCode = 1;
});
