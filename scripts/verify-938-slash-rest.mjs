#!/usr/bin/env node
// Live CDP check for issue #938's remaining items (2, 3, 5) after PR #954 shipped items 1 and 4;
// item 6 was resolved by static code audit (research.md decision 18, spec.md Clarifications) --
// re-read against the real OMP session log after gate round 1 corrected the first draft's cause
// -- not a live probe, and is only recorded here, never asserted.
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
//     `window.refract.chat.commands`, resolved the same way Rust's own `resolve_matched_descriptor`
//     does -- a builtin-sourced match first, else the first match at all -- never a bare
//     `.find(name)`), in that install's own order -- not the old generic "doesn't support
//     arguments yet" wording. Also checks the OTHER refusal wording (gate round 1 decision): a
//     valid subcommand with extra text after it (`/advisor on now`) refuses as "doesn't take
//     more text yet", never the "takes one of" listing. `/advisor` missing entirely from this
//     install is a hard FAILURE for this check and FR-082 below (both depend on a real
//     `/advisor off` round trip), not a quiet skip -- gate round 1 decision.
//   FR-082 (item 3): `/advisor off`'s own short, deterministic "Advisor disabled." reply renders
//     as a `NoticeRow` whose summary span REALLY wraps once the window is narrow enough to force
//     it (`textOverflow !== 'ellipsis'`, `scrollWidth <= clientWidth`, height over one 20px line)
//     -- gate round 1 fix: a bare className check alone was not proof it visibly wraps. Falls
//     back to a className-only check (`whitespace-normal`, never `truncate`) plus a disclosed
//     `notExercised` only if no width in the probed range actually forces more than one line.
//     Screenshotted across Dark, Obsidian, and Dark (high contrast) either way.
//   Item 6: not reasserted live (resolved by static audit); recorded in `findings` only, citing
//     `research.md` decision 18.

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

// One real text line's own height (CollapsedLine's row, `text-xs`/13px line-height-ish content at
// a 20px row box, per the shared baseline T080 establishes) -- a measured height over this means
// the summary span genuinely grew a second line, not just a generous single-line box.
const ONE_LINE_HEIGHT_PX = 20;
// Narrowing attempts for forcing the short "Advisor disabled." notice to wrap (gate round 1,
// Test MEDIUM): widest first, so the evidence screenshot is still a realistic window size if a
// narrower one is never actually needed.
const NARROW_WIDTHS = [480, 360, 300, 260, 220, 190, 160, 140, 120];

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

/** Finds the notice row whose own summary matches `/Advisor disabled\./` specifically (gate
 * round 1, Test MEDIUM: the LAST Info notice is not necessarily this one -- an unrelated system
 * notice can mount after it), and measures the geometry/style FR-082 cares about in one shot (an
 * element handle cannot cross a `returnByValue` CDP call, so find-and-measure happens together). */
async function measureAdvisorOffNotice(cdp) {
  return cdp.evaluate(`(() => {
    const rows = (${NOTICE_FINDER});
    const row = rows.find((r) => /Advisor disabled\\./.test((r.querySelector(':scope > span.min-w-0.flex-1')?.textContent ?? '').trim()));
    const span = row?.querySelector(':scope > span.min-w-0.flex-1');
    if (!span) return null;
    const style = getComputedStyle(span);
    const rect = span.getBoundingClientRect();
    return {
      className: span.className,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
      scrollWidth: span.scrollWidth,
      clientWidth: span.clientWidth,
      height: rect.height
    };
  })()`);
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

/** Resolves the `/advisor` descriptor the same way Rust's own `resolve_matched_descriptor`
 * does (`commands.rs`, issue #938 gate round 1, item 7): a builtin-sourced match (by name or
 * alias) first regardless of list order, else the first match at all. `null` when nothing in
 * `commands` matches `advisor` at all. Previously a bare `.find((c) => c.name === 'advisor')`,
 * which could pick a shadowing non-builtin entry Rust itself would never classify against. */
function resolveAdvisorDescriptor(commands) {
  const isBuiltinSource = (source) => source !== 'file' && source !== 'skill';
  const matchesAdvisor = (c) => c.name === 'advisor' || (c.aliases ?? []).includes('advisor');
  return commands.find((c) => matchesAdvisor(c) && isBuiltinSource(c.source)) ?? commands.find((c) => matchesAdvisor(c)) ?? null;
}

// The refusal toast (`notify.ts` -> `toast.error`, Sonner): newest toast PREPENDS in DOM order
// (`verify-980-toast-send.mjs`'s own header comment records this), so the first match is the
// most recent. `before` (gate round 1, item 7) is the toast count sampled BEFORE sending, so the
// wait below can never read a STALE toast left over from an earlier step as this command's own.
// `:not([data-removed="true"])` (gate round 2, Test LOW) excludes a toast still mid-exit
// animation from both the count and the read -- it is not this command's own reply either.
async function sendAndReadToast(cdp, command) {
  const selector = `document.querySelectorAll('[data-sonner-toast]:not([data-removed="true"])')`;
  const before = await cdp.evaluate(`${selector}.length`);
  await clearComposer(cdp);
  await cdp.typeIntoByLabel('Message', command);
  await cdp.clickByLabel('Send message');
  await cdp.waitFor(`${selector}.length > ${before}`, { timeoutMs: 15_000, label: 'A NEW refusal toast mounted' });
  return cdp.evaluate(`${selector}[0]?.textContent ?? null`);
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
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    const dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

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
    const expectedDescription = "Reviews a Session's turns while the Advisor is on (/advisor on); falls back to Slow.";
    if (advisorDescription !== expectedDescription) {
      failures.push(`FR-083: Advisor role description reads ${JSON.stringify(advisorDescription)}, expected ${JSON.stringify(expectedDescription)}.`);
    } else {
      findings.push(`FR-083: Advisor role description reads exactly as specified: ${JSON.stringify(advisorDescription)}.`);
    }
    await cdp.screenshot(path.join(SHOTS_DIR, '00-settings-advisor-description.png'));
    await closeSettings(cdp);

    // ==== FR-081/FR-082 prerequisite: does this ambient install even offer `/advisor`? ====
    // Gate round 1 decision: a missing `/advisor` is a hard FAILURE for both checks below (not a
    // quiet skip) -- both depend on a real `/advisor off` round trip, and #917's own live check
    // already established this ambient install is expected to offer it.
    const commandsResult = await cdp.evaluate(`window.refract.chat.commands(${JSON.stringify(sessionId)})`);
    let advisorCommand = null;
    if (!commandsResult?.ok) {
      failures.push(`FR-081/FR-082 unproven in this run: window.refract.chat.commands failed: ${JSON.stringify(commandsResult?.error ?? commandsResult)}.`);
    } else {
      advisorCommand = resolveAdvisorDescriptor(commandsResult.value);
      if (!advisorCommand) {
        failures.push(
          'FR-081/FR-082 unproven in this run: this ambient omp install does not list "/advisor" at all, so neither the refusal-wording check nor the short-notice-wrap check (both depend on a real "/advisor off" round trip) could run.'
        );
      }
    }
    if (advisorCommand) {
      // ==== FR-081 (item 2): refusal wording ====
      const subNames = advisorCommand.subcommands?.map((s) => s.name) ?? [];
      if (subNames.length === 0) {
        notExercised.push(
          `FR-081 unproven in this run: this install's own "/advisor" descriptor carries no verified subcommands (${JSON.stringify(advisorCommand)}) -- cannot exercise the "takes one of" listing branch against it.`
        );
      } else {
        const expectedToast = `/advisor takes one of: ${subNames.join(', ')}.`;
        const toastText = await sendAndReadToast(cdp, '/advisor 000bogus000');
        if (toastText !== expectedToast) {
          failures.push(`FR-081: refusal toast read ${JSON.stringify(toastText)}, expected ${JSON.stringify(expectedToast)} (computed from this install's own real "/advisor" subcommand list).`);
        } else {
          findings.push(`FR-081: "/advisor 000bogus000" refused with the real subcommand list: ${JSON.stringify(toastText)}.`);
        }
        await cdp.screenshot(path.join(SHOTS_DIR, '01-refusal-toast.png'));
        // ---- The extra-text-after-a-valid-subcommand wording (gate round 1 decision) ----
        if (subNames.includes('on')) {
          const extraTextToast = await sendAndReadToast(cdp, '/advisor on now');
          const expectedExtraText = '/advisor on doesn\'t take more text yet. Try /advisor on on its own.';
          if (extraTextToast !== expectedExtraText) {
            failures.push(`FR-081 (extra text after a valid subcommand): refusal toast read ${JSON.stringify(extraTextToast)}, expected ${JSON.stringify(expectedExtraText)}.`);
          } else {
            findings.push(`FR-081 (extra text after a valid subcommand): "/advisor on now" refused as ${JSON.stringify(extraTextToast)}.`);
          }
        } else {
          notExercised.push('FR-081 (extra text after a valid subcommand) unproven in this run: this install\'s own "/advisor" subcommand list does not include "on".');
        }
        await clearComposer(cdp);
      }

      // ==== FR-082 (item 3): the short "/advisor off" notice really wraps ====
      await sendSlashCommand(cdp, '/advisor off', /Advisor disabled\./);
      let forcedWrapWidth = null;
      let forcedMeasurement = null;
      for (const width of NARROW_WIDTHS) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
        const measured = await measureAdvisorOffNotice(cdp);
        if (measured && measured.height > ONE_LINE_HEIGHT_PX) {
          forcedWrapWidth = width;
          forcedMeasurement = measured;
          break;
        }
      }
      if (forcedMeasurement) {
        if (forcedMeasurement.textOverflow === 'ellipsis') {
          failures.push(`FR-082: at ${forcedWrapWidth}px the notice's own computed text-overflow is still "ellipsis" (truncating), not wrapping.`);
        } else if (forcedMeasurement.scrollWidth > forcedMeasurement.clientWidth) {
          failures.push(`FR-082: at ${forcedWrapWidth}px the notice overflows horizontally (scrollWidth ${forcedMeasurement.scrollWidth} > clientWidth ${forcedMeasurement.clientWidth}) instead of wrapping in place.`);
        } else {
          findings.push(`FR-082: at ${forcedWrapWidth}px the short notice genuinely wraps to a second line (height ${forcedMeasurement.height.toFixed(1)}px over the ${ONE_LINE_HEIGHT_PX}px one-line baseline), text-overflow "${forcedMeasurement.textOverflow}", no horizontal overflow.`);
        }
      } else {
        await cdp.send('Emulation.clearDeviceMetricsOverride', {});
        const classOnly = await measureAdvisorOffNotice(cdp);
        if (!classOnly) {
          failures.push('FR-082: no notice row matching "Advisor disabled." was found at all.');
        } else if (classOnly.className.includes('truncate')) {
          failures.push(`FR-082: the short notice's summary span still carries "truncate" (className: ${JSON.stringify(classOnly.className)}) -- summaryWrap did not land.`);
        } else if (!classOnly.className.includes('whitespace-normal')) {
          failures.push(`FR-082: the short notice's summary span carries neither "truncate" nor "whitespace-normal" (className: ${JSON.stringify(classOnly.className)}).`);
        } else {
          findings.push(`FR-082: className confirms summaryWrap landed (${JSON.stringify(classOnly.className)}), but no probed width (${NARROW_WIDTHS.join(', ')}px) actually forced this short reply onto a second line.`);
        }
        notExercised.push('FR-082: real multi-line wrapping could not be forced in this run at any probed window width -- className-only evidence recorded above instead.');
      }
      // Gate round 2 fix (Test MEDIUM): `switchTheme` clicks the profile name button, which can
      // sit off-screen at a width narrow enough to force wrapping -- clear the override before
      // switching, then re-apply the SAME width (the one actually measured above, or none if
      // wrapping was never forced) only for the screenshot itself.
      for (const theme of THEMES) {
        await cdp.send('Emulation.clearDeviceMetricsOverride', {});
        await switchTheme(cdp, theme.id, theme.name);
        if (forcedWrapWidth) {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width: forcedWrapWidth, height: 800, deviceScaleFactor: 1, mobile: false });
        }
        const shotName = theme.id === 'dark' ? '02-notice-wrap-dark.png' : theme.id === 'obsidian' ? '03-notice-wrap-obsidian.png' : '04-notice-wrap-dark-high-contrast.png';
        await cdp.screenshot(path.join(SHOTS_DIR, shotName));
      }
      await cdp.send('Emulation.clearDeviceMetricsOverride', {});
    }

    // ==== Item 6 (possible duplicate render): resolved by static code audit, not a live probe ====
    findings.push(
      'Item 6 (possible duplicate render) was investigated by static code audit, not a live probe -- corrected gate round 1 after re-reading the real OMP session logs. ' +
      '`build_assistant_items`/`apply_message_snapshot`/`replace_message_items` (src-tauri/src/omp/transcript.rs) apply every assistant message snapshot as a full ' +
      'replace keyed by message_id/message_id:index, so no code path can render one message\'s own content index twice. Both the #917 screenshot\'s and a #954/#947 ' +
      'verify run\'s own session log show the same shape: the user\'s own prompt (containing the sentinel word once, as an instruction) plus TWO genuinely distinct ' +
      'assistant messages -- the model called the hidden `todo` tool, replied once, and stopped; OMP\'s own incomplete-todo reminder made it continue, mark the ' +
      'todo done, and reply a second time. Recorded in research.md decision 18 and spec.md\'s Clarifications session; no code change, nothing to assert live.'
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
