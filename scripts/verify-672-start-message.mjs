#!/usr/bin/env node
// Live CDP check for issue #672 (follow-up to #618, shipped and closed): one centred Session
// start notice for every Session, larger and in the normal foreground colour, the transcript
// dimmed behind it for a Session that already has history. Modelled on
// `verify-947-938-slash-menu.mjs`'s own structure and isolation posture; the fake-omp launch
// (env vars only, no PATH shim) follows `verify-563-subagent-stage.mjs`/`verify-556-zero-box.mjs`'s
// own direct `launchViaJobObject` pattern, since the shared `launchBuiltExe` in
// `verify-tauri-scratch-helpers.mjs` supports only a real-omp launch.
//
// REWRITE (gate-fix, 2026-10-18 build-slot run): the FIRST version of this script drove every
// `startProgress.kind` by writing directly into `window.__refractStores` (a dev-only CDP
// injection seam). That global does not exist against the exe this script actually launches --
// `tauri build --debug` still runs `vite build` in PRODUCTION mode (`import.meta.env.DEV` is
// false), exactly the gotcha `verify-tauri-scratch-helpers.mjs`'s own `launchBuiltExe` doc
// comment already records for a different store -- so every call failed outright on first use
// ("Cannot read properties of undefined (reading 'sessions')"), before a single finding was
// recorded. This version drives every `startProgress.kind` through REAL production paths only:
//   - `waiting`/`prompt`/`extended`: the Rust start-queue's OWN real timers
//     (`READY_PROMPT_AFTER_MS`=60s, `src-tauri/src/omp/process.rs`), made observable on a
//     human timescale via a new, generic `REFRACT_FAKE_OMP_READY_DELAY_MS` knob on the shared
//     `verify-tauri-fake-omp.mjs` harness (delays the fake `omp`'s own first frame; does NOT
//     add a new `.jsonl` fixture -- AGENTS.md says not to, and `verify-563-subagent-stage.mjs`'s
//     own header comment already establishes reusing existing fixtures over adding one).
//   - Session id/name/`startProgress`/`currentConversation`: `window.refract.sessions.list()`,
//     the same real IPC bridge `verify-557`/`verify-564`/`verify-tauri-560`/
//     `verify-rm-live-check.mjs` etc. already read live Session state through.
//   - A fresh start on an already-ready Session: a real `stopAgent` + `recover` round trip (the
//     same bridge methods ChatPane.tsx's own Stop/Retry buttons call), safe against the
//     restarted tape's own fresh `get_state{messageCount:0}` because `sync_from_state.rs` only
//     ever PATCHES `current_conversation` when `message_count > 0` (read directly, not assumed)
//     -- real history built earlier survives the restart untouched.
//   - Split pane: a real Ctrl+click on the OTHER Session's own row (`[data-session-open]`,
//     `SessionRow.tsx`'s own `onClick` branch), not a direct `useSplitStore` call.
// `queued`/`memory-deferred` (issue #512, pre-existing, unchanged by #672) are intentionally not
// exercised here -- see the `notExercised` entry below for why.
//
// This costs real wall-clock time the synthetic version didn't: one dedicated "long" launch
// waits out the genuine 60s `READY_PROMPT_AFTER_MS` threshold twice (once to build real history,
// once more to reach `prompt` on the restarted Session) -- around 2-3 minutes added, entirely
// spent waiting on the SAME timers the shipped code actually runs on, not a fixed sleep guessed
// to "probably be enough".
//
// Gate round 1 (Main, A11y/UI/Test FAIL, kept from the original version): opacity reads poll
// with a timeout instead of a single read; the dimmed transcript is proven to stay genuinely
// scrollable (a real wheel event, forced scrollable via a temporary short viewport override) and
// to restore full opacity on focus; the split-pane and short-window cases are FORCED via
// `Emulation.setDeviceMetricsOverride` rather than only measuring whatever width/height this run
// happens to get; a failed `theme.set` is a failure, not `notExercised`.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveCssVarColor, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import {
  GROUP, REGIONS, REGION0, ANNOUNCE, OVERLAY, THEMES, NARROW_BREAKPOINT_PX,
  expectedSizesForWidth, fontSizePx, animationDurationMs, contrastRatio, parseRgba, blendOver, rgbToCss, dispatchTab,
  waitForRegionOpacity, waitForComputedOpacity, withDeviceMetrics, readNoticeState, assertCentred, assertSizesAndColours, focusLastTabbableOrSelf,
  readVisibleStartKind, waitForStartProgressKind, ctrlClickSessionRow, restartAgent, assertFocusedPlainStageNotice,
  setupLaunch, teardownLaunch, quickCreateSessionAndWaitReady, quickCreateSessionId
} from './verify-672-start-message-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-672';
const SHOTS_DIR =
  process.env.REFRACT_672_SHOTS_DIR || path.join(tmpdir(), 'refract-672-start-message-shots', new Date().toISOString().replace(/[:.]/g, '-'));

// `READY_PROMPT_AFTER_MS` (src-tauri/src/omp/process.rs) is 60_000; the "long" delay must clear
// it with headroom but stay comfortably under `READY_CEILING_MS` (180_000).
const READY_DELAY_BRIEF_MS = 15_000;
const READY_DELAY_LONG_MS = 150_000;

async function main() {
  let launch1 = null;
  let launch2 = null;
  const findings = [];
  const failures = [];
  // Both `queued` and `memory-deferred` (issue #512, pre-existing, unchanged by #672) are
  // exercised for real below (launch 2, Sessions D and E) -- nothing left notExercised.
  const notExercised = [];
  let exeHash = null;
  let gitHeadSha = null;
  let dirty = 'unknown';
  let buildOutputDir = null;
  let exeDir = null;
  let launcherDir = null;
  try {
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;
    buildOutputDir = requireSharedCargoTarget(REPO_ROOT);

    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-672-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-672-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });

    console.log(`${LOG}: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`${LOG}: shots dir ${SHOTS_DIR}`);

    // Built ONCE, launched twice (different env/data dirs each time) -- the slow part is the
    // Rust/Vite build, not spawning the already-built exe a second time.
    const built = buildAndCopyExeFresh(exeDir, buildOutputDir, REPO_ROOT, { label: LOG });
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    // ======================================================================
    // Launch 1 ("brief", 3s ready-delay): brand-new sizing/colour, clear-on-ready, the
    // announcement rules, real history, Session-with-history dimmed/wheel/focus, split pane,
    // reduced motion.
    // ======================================================================
    launch1 = await setupLaunch(exePath, launcherExe, 'brief', { REFRACT_FAKE_OMP_READY_DELAY_MS: String(READY_DELAY_BRIEF_MS) });
    const cdp1 = launch1.cdp;
    const fg = await resolveCssVarColor(cdp1, '--foreground', 'color');
    const muted = await resolveCssVarColor(cdp1, '--muted-foreground', 'color');

    // Gate-fix (confirmed live, bg_791/bg_794 runs): `quickCreateSessionAndWaitReady` blocks
    // until the composer is enabled -- by the time it returned, Session A had ALREADY reached
    // `ready` and `startProgress` had already cleared to `null`, so the very next
    // `waitForStartProgressKind(..., 'waiting', ...)` below timed out waiting for a state that
    // had already come and gone. `quickCreateSessionId` (non-blocking, same as Launch 2's own
    // C/D/E) lets this section observe 'waiting' WHILE it is still happening; the explicit
    // "notice unmounts, ready" wait further down is still the real ready-wait for this Session.
    const sessionA = await quickCreateSessionId(cdp1, 'brief/A (1st start)');
    findings.push(`Session A created (id ${sessionA.id}, name "${sessionA.name}"), brand-new (no history yet).`);

    // ---- (1) Brand-new Session, real 'waiting' kind: centred, not dimmed, large sizing ----
    await waitForStartProgressKind(cdp1, sessionA.id, 'waiting', 10_000);
    await cdp1.waitFor(`!!${GROUP}`, { timeoutMs: 10_000, label: 'brand-new: notice mounted (real waiting kind)' });
    const brandNewOpacity = await waitForRegionOpacity(cdp1, (v) => v > 0.95);
    if (!brandNewOpacity.ok) failures.push(`brand-new/waiting: transcript region opacity settled at ${brandNewOpacity.value}, expected >0.95 (brand-new Session has nothing to dim).`);
    else findings.push(`brand-new/waiting: transcript region opacity settled at ${brandNewOpacity.value} (not dimmed), as expected.`);
    const brandNewState = await readNoticeState(cdp1);
    assertCentred(brandNewState, 'brand-new/waiting', failures);
    let wideRegionWidth = null;
    let jokeMessageText = null;
    if (brandNewState.regionFound) {
      wideRegionWidth = brandNewState.regionRect.width;
      assertSizesAndColours(brandNewState, brandNewState.regionRect.width, 'brand-new/waiting', fg, muted, failures, findings);
    }
    jokeMessageText = await cdp1.evaluate(`document.querySelector('[data-start-message]')?.textContent ?? null`);
    await cdp1.screenshot(path.join(SHOTS_DIR, '01-brand-new-waiting.png'));

    // ---- (4) Reduced motion: the emoji's bob collapses to (near-)zero duration ----
    const beforeMotionState = await readNoticeState(cdp1);
    const normalDurationMs = animationDurationMs(beforeMotionState.emoji?.animationDuration);
    await cdp1.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(200);
    const reducedState = await readNoticeState(cdp1);
    const reducedDurationMs = animationDurationMs(reducedState.emoji?.animationDuration);
    if (normalDurationMs !== null && normalDurationMs <= 1) notExercised.push(`Normal (non-reduced-motion) emoji animation-duration was already ${beforeMotionState.emoji?.animationDuration} -- could not confirm reduced-motion actually changed anything.`);
    if (reducedDurationMs === null || reducedDurationMs > 1) failures.push(`With prefers-reduced-motion:reduce, emoji animation-duration is ${reducedState.emoji?.animationDuration} (${reducedDurationMs}ms), expected <=1ms (collapsed by the global reduced-motion rule).`);
    else findings.push(`With prefers-reduced-motion:reduce, emoji animation-duration collapsed to ${reducedState.emoji?.animationDuration} (<=1ms), down from ${beforeMotionState.emoji?.animationDuration} normally.`);
    await cdp1.screenshot(path.join(SHOTS_DIR, '02-reduced-motion.png'));
    await cdp1.send('Emulation.setEmulatedMedia', { features: [] });

    // ---- Clear: notice unmounts, "Ready..." reappears (brand-new Session reaches ready) ----
    await cdp1.waitFor(`!${GROUP}`, { timeoutMs: 30_000, label: 'notice unmounted once the real start reaches ready (brand-new)' });
    const readyShown = await cdp1.evaluate(`Array.from(${REGIONS}).some((r) => r.textContent.includes('Ready. Type a message to get started.'))`);
    if (!readyShown) failures.push('After the real start reached ready on a brand-new Session, "Ready. Type a message to get started." did not reappear.');
    else findings.push('The notice cleared and "Ready. Type a message to get started." reappeared once the real start reached ready (brand-new Session).');
    await cdp1.screenshot(path.join(SHOTS_DIR, '03-brand-new-cleared-ready.png'));

    // ---- (5) Announcement: a real undefined->waiting restart reads exactly, never the joke,
    // and a same-kind re-render (the real elapsed-ms ticker, not a synthetic one) produces zero
    // DOM mutations. Waits out useClearedAnnouncement's own 6s auto-clear timer first so the
    // restart below measures a genuinely clean first announcement, not a leftover one. ----
    await sleep(6_500);
    const staleAnnouncement = await cdp1.evaluate(`${ANNOUNCE}?.textContent || ''`);
    if (staleAnnouncement !== '') notExercised.push(`Announcement region still read "${staleAnnouncement}" after waiting 6.5s to auto-clear -- the fresh-start text assertion below may not be measuring a clean first announcement.`);
    await restartAgent(cdp1, sessionA.id);
    const freshText = await cdp1.waitFor(`${ANNOUNCE}?.textContent || null`, { timeoutMs: 10_000, label: 'fresh restart announcement text set' });
    const expectedFreshText = `Starting agent: ${sessionA.name}`;
    if (freshText !== expectedFreshText) failures.push(`Real undefined->waiting restart announced "${freshText}", expected exactly "${expectedFreshText}".`);
    else findings.push(`Real undefined->waiting restart announced exactly "${freshText}", as expected.`);
    if (jokeMessageText && freshText.includes(jokeMessageText)) failures.push(`Announcement text ("${freshText}") includes the joke message ("${jokeMessageText}") -- the joke must never be announced.`);
    else findings.push('Announcement text does not include the joke message, as specified.');

    const beforeTick = await readVisibleStartKind(cdp1);
    const elapsedBefore = beforeTick?.kind === 'waiting' ? beforeTick.elapsedMs : null;
    await cdp1.evaluate(`(() => {
      window.__672Mutations = 0;
      window.__672Observer = new MutationObserver(() => { window.__672Mutations++; });
      window.__672Observer.observe(${ANNOUNCE}, { childList: true, characterData: true, subtree: true });
      return true;
    })()`);
    await sleep(2_500); // real elapsed-ms ticks happen on the Rust side's own ~1s cadence while waiting
    const mutationCount = await cdp1.evaluate(`(() => { window.__672Observer.disconnect(); return window.__672Mutations; })()`);
    const afterTick = await readVisibleStartKind(cdp1);
    const elapsedAfter = afterTick?.kind === 'waiting' ? afterTick.elapsedMs : null;
    if (afterTick?.kind !== 'waiting') {
      failures.push(`Announcement mutation window: the visible notice's own kind was "${afterTick?.kind}" after the 2.5s window, expected still "waiting" -- the zero-mutation claim below would be vacuous if the kind itself changed.`);
    } else if (elapsedBefore === null || elapsedAfter === null || !(elapsedAfter > elapsedBefore)) {
      failures.push(`Announcement mutation window: the visible elapsed-seconds counter did not advance (${elapsedBefore} -> ${elapsedAfter}) across the 2.5s window -- this check would not be exercising a real same-kind re-tick at all.`);
    } else {
      findings.push(`Announcement mutation window: the visible elapsed-seconds counter advanced (${elapsedBefore}ms -> ${elapsedAfter}ms) while kind stayed "waiting", confirming a genuine same-kind re-render was exercised.`);
    }
    if (mutationCount !== 0) failures.push(`Announcement region mutated ${mutationCount} time(s) (MutationObserver) across real same-kind (waiting) elapsed-ms ticks -- it must not re-announce (the #618 round-2 fix regressed).`);
    else findings.push('Announcement region recorded zero DOM mutations (MutationObserver) across real same-kind elapsed-ms ticks -- no re-announcement.');

    // ---- Build real history on Session A (a real send through the fake-omp session tape) ----
    await cdp1.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: 30_000, label: 'Session A ready again after the announcement restart' });
    await cdp1.click(`document.querySelector('[aria-label="Message"]')`);
    await cdp1.send('Input.insertText', { text: 'Reply with exactly the single word t672turn and nothing else.' });
    await cdp1.clickByLabel('Send message');
    await cdp1.waitFor(`Array.from(${REGIONS}).some((r) => /t672turn/.test(r.textContent))`, { timeoutMs: 60_000, label: 'Real turn settled (fake-omp reply contains sentinel)' });
    const sessionAHasHistory = await cdp1.waitFor(`window.refract.sessions.list().then((r) => r.ok && r.value.find((s) => s.id === ${JSON.stringify(sessionA.id)})?.currentConversation !== null)`, {
      timeoutMs: 30_000,
      label: 'Session A now has real history (currentConversation settled)'
    });
    findings.push(`Session A sent and settled one real turn through the fake-omp session tape -- currentConversation settled: ${sessionAHasHistory}.`);

    // ---- Session B: a second real Session (front pane), used only as the split-pane partner ----
    const sessionB = await quickCreateSessionAndWaitReady(cdp1, 'brief/B (split partner)');
    findings.push(`Session B created (id ${sessionB.id}) as the split-pane partner.`);

    // ---- (2) Session with history, real restart: centred, dimmed ~40%, stays interactive ----
    await restartAgent(cdp1, sessionA.id);
    await waitForStartProgressKind(cdp1, sessionA.id, 'waiting', 10_000);
    await cdp1.waitFor(`!!${GROUP}`, { timeoutMs: 10_000, label: 'notice mounted over Session-with-history (real restart)' });
    const dimPoll = await waitForRegionOpacity(cdp1, (v) => v <= 0.45);
    if (!dimPoll.ok) failures.push(`history/waiting: transcript region opacity settled at ${dimPoll.value}, expected <=0.45 (~40%, dimmed behind the notice).`);
    else findings.push(`history/waiting: transcript region opacity settled at ${dimPoll.value} (~40%), dimmed behind the notice as specified.`);
    const historyState = await readNoticeState(cdp1);
    assertCentred(historyState, 'history/waiting', failures);
    if (historyState.regionFound) assertSizesAndColours(historyState, historyState.regionRect.width, 'history/waiting', fg, muted, failures, findings);
    await cdp1.screenshot(path.join(SHOTS_DIR, '04-history-dimmed.png'));

    await withDeviceMetrics(cdp1, 900, 260, async () => {
      await cdp1.waitFor(`!!${GROUP}`, { timeoutMs: 10_000, label: 'notice still mounted after short-viewport override' });
      const probe = await cdp1.evaluate(`(() => {
        const region = ${REGION0}, group = ${GROUP};
        if (!region) return null;
        const rr = region.getBoundingClientRect();
        const x = rr.x + 16, y = rr.y + 16;
        const hit = document.elementFromPoint(x, y);
        return { x, y, landsInTranscript: !!hit && region.contains(hit), landsInNotice: !!hit && !!group && group.contains(hit) };
      })()`);
      if (!probe || !probe.landsInTranscript || probe.landsInNotice) {
        failures.push(`history/wheel: could not find a point confirmed (elementFromPoint) inside the transcript and outside the notice (${JSON.stringify(probe)}).`);
        return;
      }
      const before = await cdp1.evaluate(`${REGION0}?.scrollTop ?? null`);
      if (before === null || !(before > 0)) {
        failures.push(`history/wheel: transcript scrollTop is ${before} before the wheel, expected >0 (defaultScrollPosition="end" in a forced-short viewport) so an upward wheel has somewhere to decrease from.`);
        return;
      }
      await cdp1.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: probe.x, y: probe.y, deltaX: 0, deltaY: -150 });
      await sleep(200);
      const after = await cdp1.evaluate(`${REGION0}?.scrollTop ?? null`);
      if (after === null || !(after < before)) {
        failures.push(`history/wheel: a wheel (deltaY:-150) at a point confirmed inside the transcript and outside the notice did not decrease scrollTop (${before} -> ${after}) -- it must stay scrollable while dimmed.`);
      } else {
        findings.push(`history/wheel: a wheel at a point confirmed (elementFromPoint) inside the transcript and outside the notice decreased scrollTop (${before} -> ${after}), confirming it stays interactive while dimmed.`);
      }
      await focusLastTabbableOrSelf(cdp1, REGION0);
      const focusedOpacity = await waitForRegionOpacity(cdp1, (v) => v > 0.95, 2_000);
      if (!focusedOpacity.ok) failures.push(`history/focus: focusing the dimmed transcript region did not restore full opacity (settled at ${focusedOpacity.value}) -- focus-within:opacity-100 regressed.`);
      else findings.push(`history/focus: focusing the dimmed transcript region restored full opacity (${focusedOpacity.value}), as specified.`);
      await cdp1.evaluate(`document.activeElement?.blur()`);
    });

    // ---- History-with-start clears: once this real restart reaches ready, the dimmed
    // transcript returns to full opacity (single pane, before the split-pane test below). ----
    await cdp1.waitFor(`!${GROUP}`, { timeoutMs: 30_000, label: 'history/waiting restart reached ready, notice cleared' });
    const historyCleared = await waitForRegionOpacity(cdp1, (v) => v > 0.95);
    if (!historyCleared.ok) failures.push(`history/cleared: transcript region opacity settled at ${historyCleared.value}, expected ~1 after startProgress cleared.`);
    else findings.push(`history/cleared: transcript region opacity returned to ${historyCleared.value} once startProgress cleared.`);
    await cdp1.screenshot(path.join(SHOTS_DIR, '04b-history-cleared.png'));

    // ---- (3) Split pane: a FRESH real restart (so the notice is visible again), then a real
    // Ctrl+click on Session A's own row (not a direct store call) moves it into split alongside
    // Session B; measured narrower width; forced under the narrow breakpoint if this run's own
    // window did not land there naturally. ----
    await restartAgent(cdp1, sessionA.id);
    await waitForStartProgressKind(cdp1, sessionA.id, 'waiting', 10_000);
    await cdp1.waitFor(`!!${GROUP}`, { timeoutMs: 10_000, label: 'notice mounted again for the split-pane test' });
    await ctrlClickSessionRow(cdp1, sessionA.id);
    await cdp1.waitFor(`${REGIONS}.length === 2`, { timeoutMs: 15_000, label: 'Split open (real Ctrl+click): two Transcript regions rendered' });
    let splitState = await readNoticeState(cdp1);
    assertCentred(splitState, 'split/waiting', failures);
    if (splitState.regionFound && wideRegionWidth !== null && !(splitState.regionRect.width < wideRegionWidth)) {
      failures.push(`split/waiting: split pane width (${splitState.regionRect.width.toFixed(0)}px) is not narrower than the single-pane width (${wideRegionWidth.toFixed(0)}px) -- the split did not actually narrow this pane.`);
    } else if (splitState.regionFound && wideRegionWidth !== null) {
      findings.push(`split/waiting: split pane measured ${splitState.regionRect.width.toFixed(0)}px wide, narrower than the single-pane ${wideRegionWidth.toFixed(0)}px, as expected.`);
    }
    if (splitState.regionFound && splitState.regionRect.width >= NARROW_BREAKPOINT_PX) {
      findings.push(`split/waiting: this run's own split pane measured ${splitState.regionRect.width.toFixed(0)}px (>=640px, the wide regime) -- forcing the window narrower to exercise the compact-sizing code path too.`);
      await withDeviceMetrics(cdp1, 950, 800, async () => {
        await cdp1.waitFor(`!!${GROUP}`, { timeoutMs: 10_000, label: 'notice still mounted after narrowing the window' });
        splitState = await readNoticeState(cdp1);
        if (splitState.regionFound) assertSizesAndColours(splitState, splitState.regionRect.width, 'split/waiting (forced narrow)', fg, muted, failures, findings);
        else failures.push('split/waiting (forced narrow): no Transcript region found to measure after narrowing the window.');
        await cdp1.screenshot(path.join(SHOTS_DIR, '05-split-pane-forced-narrow.png'));
      });
    } else if (splitState.regionFound) {
      assertSizesAndColours(splitState, splitState.regionRect.width, 'split/waiting', fg, muted, failures, findings);
      await cdp1.screenshot(path.join(SHOTS_DIR, '05-split-pane.png'));
    }

    await teardownLaunch(launch1);
    launch1 = null;

    // ======================================================================
    // Launch 2 ("long", 150s ready-delay): the REAL `prompt`/`extended` stages on a Session that
    // already has history -- Keep waiting/Cancel reachability, overlay-hide-on-focus, theme
    // contrast, the 600px-tall window case. Also the real `queued`/`memory-deferred` kinds.
    // ======================================================================
    launch2 = await setupLaunch(exePath, launcherExe, 'long', {
      REFRACT_FAKE_OMP_READY_DELAY_MS: String(READY_DELAY_LONG_MS),
      REFRACT_FORCE_LOW_MEMORY: '1'
    });
    const cdp2 = launch2.cdp;

    // ---- Real `queued` and `memory-deferred`: Session C grabs the Rust start-queue's 1st real
    // slot and actually spawns (MAX_CONCURRENT_STARTS, start_queue.rs:36); Session D grabs the
    // 2nd slot but, with REFRACT_FORCE_LOW_MEMORY=1 AND C still spawned, defers
    // (start_queue.rs:387); Session E then has no slot free at all and queues. Each becomes the
    // focused pane on its own creation (confirmed via aria-current below), so its own notice is
    // what GROUP/REGIONS scope to in turn. Both D and E are cancelled once their states are
    // captured -- left running, D's own eventual real spawn (once its 60s
    // MEMORY_DEFER_CEILING_MS elapses) would compete with Session C's own later with-history
    // restart for the same 2 real slots, adding a long, flaky, unrelated real-time dependency to
    // checks that are really about these two kinds' own rendering. ----
    const sessionC = await quickCreateSessionId(cdp2, 'long/C (1st start, 1st of 2 real slots)');
    findings.push(`Session C created (id ${sessionC.id}), brand-new, holding one of the 2 real start-queue slots.`);
    const sessionD = await quickCreateSessionId(cdp2, 'long/D (2nd of 2 real slots, defers)');
    const memoryDeferredProgress = await waitForStartProgressKind(cdp2, sessionD.id, 'memory-deferred', 10_000);
    findings.push(`Session D (id ${sessionD.id}) real startProgress is ${JSON.stringify(memoryDeferredProgress)} -- REFRACT_FORCE_LOW_MEMORY=1 while Session C is still spawned (start_queue.rs:387).`);
    await assertFocusedPlainStageNotice(cdp2, {
      sessionId: sessionD.id, kind: 'memory-deferred', expectedText: 'Starting agent… waiting for memory to free up',
      muted, failures, findings, screenshotPath: path.join(SHOTS_DIR, '05a-memory-deferred.png')
    });

    const sessionE = await quickCreateSessionId(cdp2, 'long/E (3rd start, observes real queued)');
    const queuedProgress = await waitForStartProgressKind(cdp2, sessionE.id, 'queued', 10_000);
    findings.push(`Session E (id ${sessionE.id}) real startProgress is ${JSON.stringify(queuedProgress)} -- both real slots held (C spawned, D deferred).`);
    await assertFocusedPlainStageNotice(cdp2, {
      sessionId: sessionE.id, kind: 'queued', expectedText: 'Waiting to start…',
      muted, failures, findings, screenshotPath: path.join(SHOTS_DIR, '05b-queued.png')
    });

    const cancelD = await cdp2.evaluate(`window.refract.sessions.cancelStart(${JSON.stringify(sessionD.id)})`);
    if (!cancelD?.ok) failures.push(`memory-deferred: cancelStart(D) did not return ok (${JSON.stringify(cancelD)}) -- Session D may still hold its real slot, risking cross-talk with Session C's own later restart.`);
    else findings.push("memory-deferred: Session D's start cancelled (real cancelStart) after asserting, freeing its slot before Session C's own later restart.");
    const cancelE = await cdp2.evaluate(`window.refract.sessions.cancelStart(${JSON.stringify(sessionE.id)})`);
    if (!cancelE?.ok) failures.push(`queued: cancelStart(E) did not return ok (${JSON.stringify(cancelE)}).`);
    else findings.push("queued: Session E's start cancelled (real cancelStart) after asserting.");

    // Re-focus Session C (a real plain click, not Ctrl) so GROUP/REGIONS scope back to it.
    await cdp2.click(`document.querySelector('[data-session-open=${JSON.stringify(sessionC.id)}]')`);
    await cdp2.waitFor(`${REGIONS}.length >= 1 && ${GROUP}`, { timeoutMs: 10_000, label: 'Session C refocused after the queued check' });

    // ---- Brand-new prompt/extended: Session C's own 1st start naturally crosses the real 60s
    // prompt threshold before it ever reaches ready -- exercised here, before any history
    // exists, so centring/sizing/button-presence is proven on a genuinely brand-new Session
    // too, not only the with-history restart later. ----
    await waitForStartProgressKind(cdp2, sessionC.id, 'prompt', READY_DELAY_LONG_MS);
    await cdp2.waitFor(`!!${GROUP}`, { timeoutMs: 10_000, label: 'brand-new/prompt: notice mounted (real prompt kind, 1st start)' });
    const bnPromptOpacity = await waitForRegionOpacity(cdp2, (v) => v > 0.95, 2_000);
    if (!bnPromptOpacity.ok) failures.push(`brand-new/prompt: transcript region opacity settled at ${bnPromptOpacity.value}, expected >0.95 (brand-new Session has nothing to dim).`);
    else findings.push(`brand-new/prompt: transcript region opacity settled at ${bnPromptOpacity.value} (not dimmed), as expected.`);
    const bnPromptState = await readNoticeState(cdp2);
    assertCentred(bnPromptState, 'brand-new/prompt', failures);
    if (bnPromptState.regionFound) assertSizesAndColours(bnPromptState, bnPromptState.regionRect.width, 'brand-new/prompt', fg, muted, failures, findings);
    if (!bnPromptState.buttonTexts.includes('Keep waiting')) failures.push(`brand-new/prompt: no "Keep waiting" button found (group buttons: ${JSON.stringify(bnPromptState.buttonTexts)}).`);
    if (!bnPromptState.buttonTexts.includes('Cancel')) failures.push(`brand-new/prompt: no "Cancel" button found (group buttons: ${JSON.stringify(bnPromptState.buttonTexts)}).`);
    await cdp2.screenshot(path.join(SHOTS_DIR, '05c-brand-new-prompt.png'));

    await cdp2.clickByText('Keep waiting');
    await waitForStartProgressKind(cdp2, sessionC.id, 'extended', 5_000);
    const bnExtendedState = await readNoticeState(cdp2);
    assertCentred(bnExtendedState, 'brand-new/extended', failures);
    if (bnExtendedState.regionFound) assertSizesAndColours(bnExtendedState, bnExtendedState.regionRect.width, 'brand-new/extended', fg, muted, failures, findings);
    const bnExtendedOpacity = await waitForRegionOpacity(cdp2, (v) => v > 0.95, 2_000);
    if (!bnExtendedOpacity.ok) failures.push(`brand-new/extended: transcript region opacity settled at ${bnExtendedOpacity.value}, expected >0.95 (brand-new Session has nothing to dim).`);
    if (bnExtendedState.buttonTexts.includes('Keep waiting')) failures.push(`brand-new/extended: "Keep waiting" still present (${JSON.stringify(bnExtendedState.buttonTexts)}) -- Extended has no further Keep-waiting decision.`);
    if (!bnExtendedState.buttonTexts.includes('Cancel')) failures.push(`brand-new/extended: no "Cancel" button found (group buttons: ${JSON.stringify(bnExtendedState.buttonTexts)}).`);
    else findings.push('brand-new/extended: a real "Keep waiting" click on the 1st (brand-new) start reached the real `extended` kind; Cancel remains, Keep waiting does not.');
    await cdp2.screenshot(path.join(SHOTS_DIR, '05d-brand-new-extended.png'));

    // ---- Build real history on Session C (1st start finally reaches ready) ----
    await cdp2.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, { timeoutMs: READY_DELAY_LONG_MS, label: 'Session C ready (1st start reaches ready after the brand-new prompt/extended checks)' });
    await cdp2.click(`document.querySelector('[aria-label="Message"]')`);
    await cdp2.send('Input.insertText', { text: 'Reply with exactly the single word t672turnC and nothing else.' });
    await cdp2.clickByLabel('Send message');
    await cdp2.waitFor(`Array.from(${REGIONS}).some((r) => /t672turnC/.test(r.textContent))`, { timeoutMs: 60_000, label: 'Real turn settled on Session C (fake-omp reply contains sentinel)' });
    await cdp2.waitFor(`window.refract.sessions.list().then((r) => r.ok && r.value.find((s) => s.id === ${JSON.stringify(sessionC.id)})?.currentConversation !== null)`, {
      timeoutMs: 30_000,
      label: 'Session C now has real history (currentConversation settled)'
    });
    findings.push('Session C sent and settled one real turn -- it now has real history, ready for the with-history prompt/extended restart.');

    await restartAgent(cdp2, sessionC.id);
    await waitForStartProgressKind(cdp2, sessionC.id, 'prompt', READY_DELAY_LONG_MS);
    findings.push('Session C restart (2nd start, now with history) reached the real `prompt` startProgress.kind (READY_PROMPT_AFTER_MS, 60s) without any synthetic injection.');

    await withDeviceMetrics(cdp2, 900, 260, async () => {
      await cdp2.waitFor(`!!${GROUP}`, { timeoutMs: 10_000, label: 'history/prompt: notice mounted (real prompt kind) after short-viewport override' });
      const dimBefore = await readNoticeState(cdp2);
      if (!dimBefore.regionFound || !(dimBefore.regionOpacity <= 0.45)) {
        failures.push(`history/prompt: transcript region opacity is ${dimBefore.regionFound ? dimBefore.regionOpacity : 'unknown (region not found)'}, expected <=0.45 (dimmed behind the real prompt-stage overlay).`);
      } else {
        findings.push(`history/prompt: transcript region opacity settled at ${dimBefore.regionOpacity} (~40%), dimmed behind the real prompt-stage overlay.`);
      }
      assertCentred(dimBefore, 'history/prompt', failures);
      if (dimBefore.regionFound) assertSizesAndColours(dimBefore, dimBefore.regionRect.width, 'history/prompt', fg, muted, failures, findings);
      if (!dimBefore.buttonTexts.includes('Keep waiting')) failures.push(`history/prompt: no "Keep waiting" button found (group buttons: ${JSON.stringify(dimBefore.buttonTexts)}).`);
      if (!dimBefore.buttonTexts.includes('Cancel')) failures.push(`history/prompt: no "Cancel" button found (group buttons: ${JSON.stringify(dimBefore.buttonTexts)}).`);
      await cdp2.screenshot(path.join(SHOTS_DIR, '06-history-prompt.png'));

      // Focus-hide: with real focus inside the dimmed history, the overlay itself hides
      // (WCAG 2.4.11), and one real Tab from there reaches "Keep waiting" and reveals it again.
      await focusLastTabbableOrSelf(cdp2, REGION0);
      const hiddenOpacityPoll = await waitForComputedOpacity(cdp2, OVERLAY, (v) => v <= 0.05, 2_000);
      const hidden = await cdp2.evaluate(`(() => {
        const overlay = ${OVERLAY};
        const wrapper = document.querySelector('[data-start-notice-wrapper]');
        if (!overlay || !wrapper) return null;
        const r = ${REGION0}.getBoundingClientRect();
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        return {
          wrapperPointerEvents: getComputedStyle(wrapper).pointerEvents,
          hitIsTranscript: ${REGION0}.contains(document.elementFromPoint(cx, cy))
        };
      })()`);
      if (!hiddenOpacityPoll.ok || !hidden || hidden.wrapperPointerEvents !== 'none') {
        failures.push(`focus-hide: with focus inside the history, the overlay opacity settled at ${hiddenOpacityPoll.value} (expected <=0.05) and the wrapper read pointer-events ${hidden?.wrapperPointerEvents} (expected none) -- WCAG 2.4.11.`);
      } else if (!hidden.hitIsTranscript) {
        failures.push('focus-hide: the overlay is hidden but the transcript region centre is still not the elementFromPoint hit -- something else may be covering it.');
      } else {
        findings.push(`focus-hide: with focus inside the history, the overlay opacity settled at ${hiddenOpacityPoll.value} and the wrapper reads pointer-events none (hidden), and the transcript's own centre is reachable by elementFromPoint.`);
      }
      await dispatchTab(cdp2);
      const afterTabOpacityPoll = await waitForComputedOpacity(cdp2, OVERLAY, (v) => v >= 0.95, 2_000);
      const afterTab = await cdp2.evaluate(`(() => {
        const overlay = ${OVERLAY};
        const active = document.activeElement;
        const btn = overlay ? Array.from(overlay.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Keep waiting') : null;
        let hitIsButton = false;
        if (btn) { const br = btn.getBoundingClientRect(); hitIsButton = document.elementFromPoint(br.x + br.width / 2, br.y + br.height / 2) === btn; }
        return { activeIsKeepWaiting: active === btn, hitIsButton };
      })()`);
      if (!afterTab || !afterTab.activeIsKeepWaiting) {
        failures.push(`focus-hide: one real Tab press from the history did not land on "Keep waiting" (${JSON.stringify(afterTab)}).`);
      } else if (!afterTabOpacityPoll.ok || !afterTab.hitIsButton) {
        failures.push(`focus-hide: Tab reached "Keep waiting" but the overlay opacity settled at ${afterTabOpacityPoll.value} (expected >=0.95) or elementFromPoint at its own centre did not hit the button (${afterTab.hitIsButton}).`);
      } else {
        findings.push(`focus-hide: one real Tab press from the history moved focus to "Keep waiting" and the overlay opacity settled at ${afterTabOpacityPoll.value}, reachable at its own screen position.`);
      }
      await cdp2.evaluate(`document.activeElement?.blur()`);
    });

    // ---- Themes: a failed theme.set is a FAILURE now, not notExercised. Driven at the real
    // `prompt` stage. Contrast is measured against the panel's own WORST-CASE effective
    // background (--foreground at 40% opacity, composited under the panel's real bg-background/90
    // alpha, read from the live element) for message, counter, guidance and every button label. A
    // regression-proof self-check (forcing the panel transparent and re-measuring) confirms this
    // would actually catch bg-background/90 being removed. ----
    for (const theme of THEMES) {
      if (theme.id !== 'dark') {
        const result = await cdp2.evaluate(`window.refract.theme.set(${JSON.stringify(theme.id)}).then((r) => r.ok)`);
        if (result !== true) {
          failures.push(`theme.set(${theme.id}) did not return ok -- cannot verify ${theme.name}.`);
          continue;
        }
        await cdp2.waitFor(`document.documentElement.classList.contains(${JSON.stringify(`theme-${theme.id}`)})`, { timeoutMs: 10_000, label: `${theme.name} theme applied` });
      }
      await cdp2.screenshot(path.join(SHOTS_DIR, `07-theme-${theme.id}.png`));
      const themeState = await readNoticeState(cdp2);
      const panelRaw = await cdp2.evaluate(`(() => { const el = ${GROUP}; return el ? getComputedStyle(el).backgroundColor : null; })()`);
      const panel = parseRgba(panelRaw);
      const backgroundRgb = parseRgba(await resolveCssVarColor(cdp2, '--background', 'background-color'));
      const foregroundRgb = parseRgba(await resolveCssVarColor(cdp2, '--foreground', 'background-color'));
      const buttonColours = await cdp2.evaluate(`${GROUP} ? Array.from(${GROUP}.querySelectorAll('button')).map((b) => ({ text: b.textContent.trim(), color: getComputedStyle(b).color })) : []`);
      if (!panel || !backgroundRgb || !foregroundRgb) {
        failures.push(`${theme.name}: could not resolve panel (${panelRaw})/--background/--foreground colours for contrast math.`);
        continue;
      }
      if (!(panel.a >= 0.85 && panel.a <= 0.95)) failures.push(`${theme.name}: panel background-color ${panelRaw} has alpha ${panel.a}, expected 0.85-0.95 (bg-background/90); the panel class may not be applied correctly.`);
      const worstCaseBackdrop = blendOver({ ...foregroundRgb, a: 0.4 }, backgroundRgb);
      const panelEffectiveCss = rgbToCss(blendOver(panel, worstCaseBackdrop));
      const pairs = [
        ['message', themeState.message?.color],
        ['counter', themeState.counter?.color],
        ['guidance', themeState.guidance?.color],
        ...buttonColours.map((b) => [`button "${b.text}"`, b.color])
      ];
      for (const [name, colour] of pairs) {
        const ratio = contrastRatio(colour, panelEffectiveCss);
        if (ratio === null) failures.push(`${theme.name}: could not compute a contrast ratio for ${name} (${colour}) over the panel's worst-case effective background (${panelEffectiveCss}).`);
        else if (ratio < 4.5) failures.push(`${theme.name}: ${name} colour ${colour} over the panel's worst-case effective background ${panelEffectiveCss} (foreground@40% under the real panel alpha) contrasts ${ratio.toFixed(2)}:1, expected >=4.5:1.`);
        else findings.push(`${theme.name}: ${name} colour contrasts ${ratio.toFixed(2)}:1 over the panel's worst-case effective background, >=4.5:1.`);
      }
      await cdp2.evaluate(`(() => { const el = ${GROUP}; if (el) el.style.backgroundColor = 'transparent'; return true; })()`);
      const bareCss = rgbToCss(worstCaseBackdrop);
      const hadWorseOrFailing = pairs.some(([, colour]) => {
        const withPanel = contrastRatio(colour, panelEffectiveCss);
        const withoutPanel = contrastRatio(colour, bareCss);
        return withPanel !== null && withoutPanel !== null && (withoutPanel < withPanel - 0.05 || withoutPanel < 4.5);
      });
      await cdp2.evaluate(`(() => { const el = ${GROUP}; if (el) el.style.removeProperty('background-color'); return true; })()`);
      if (!hadWorseOrFailing) failures.push(`${theme.name}: removing bg-background/90 did not read worse/failing for any measured colour -- this contrast check would not catch that regression.`);
      else findings.push(`${theme.name}: removing bg-background/90 (temporary fault injection) reads a worse or failing contrast for at least one colour, confirming this check would catch a regression.`);
    }
    await cdp2.evaluate(`window.refract.theme.set('dark')`);

    // ---- A genuinely short (600px tall) window: Keep waiting/Cancel reachable the user's way
    // (a real wheel scroll, elementFromPoint hit-testing), forced via Emulation.setDeviceMetricsOverride ----
    await withDeviceMetrics(cdp2, 900, 600, async () => {
      await cdp2.waitFor(`!!${GROUP}`, { timeoutMs: 10_000, label: 'notice still mounted in the 600px-tall window' });
      const overflowCheck = await cdp2.evaluate(`(() => { const el = ${OVERLAY}; return el ? { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } : null; })()`);
      if (!overflowCheck || !(overflowCheck.scrollHeight > overflowCheck.clientHeight)) {
        failures.push(`short-window: overlay scrollHeight (${overflowCheck?.scrollHeight}) is not greater than clientHeight (${overflowCheck?.clientHeight}) -- it did not genuinely overflow this 600px-tall window.`);
        return;
      }
      findings.push(`short-window: overlay genuinely overflows (scrollHeight ${overflowCheck.scrollHeight} > clientHeight ${overflowCheck.clientHeight}).`);
      async function scrollOverlayToEndViaWheel() {
        const centre = await cdp2.evaluate(`(() => { const el = ${OVERLAY}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        if (!centre) return false;
        for (let i = 0; i < 20; i++) {
          await cdp2.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: centre.x, y: centre.y, deltaX: 0, deltaY: 200 });
          await sleep(80);
        }
        return true;
      }
      const buttonHitExpr = `Array.from(${GROUP}.querySelectorAll('button')).map((b) => { const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { text: b.textContent.trim(), hitsSelf: hit === b || (!!hit && b.contains(hit)) }; })`;
      if (!(await scrollOverlayToEndViaWheel())) failures.push('short-window: no overlay element found to dispatch wheel events at.');
      const buttonHits = await cdp2.evaluate(`${GROUP} ? (${buttonHitExpr}) : []`);
      if (buttonHits.length === 0) failures.push('short-window: no buttons found in the Agent start group at the prompt stage (expected Keep waiting and Cancel).');
      for (const b of buttonHits) {
        if (b.hitsSelf) findings.push(`short-window: "${b.text}" button is the real elementFromPoint hit at its own centre after a real wheel scroll, confirming it is genuinely reachable.`);
        else failures.push(`short-window: "${b.text}" button is NOT the elementFromPoint hit at its own centre after a real wheel scroll to the overlay's end -- not genuinely reachable.`);
      }
      await cdp2.screenshot(path.join(SHOTS_DIR, '08-short-window-prompt.png'));

      await cdp2.evaluate(`(() => { const el = ${OVERLAY}; if (el) { el.dataset.verify672OldOverflow = el.style.overflowY || ''; el.style.overflowY = 'hidden'; el.scrollTop = 0; } return true; })()`);
      await sleep(150);
      await scrollOverlayToEndViaWheel();
      const noScrollHits = await cdp2.evaluate(`${GROUP} ? (${buttonHitExpr}).map((h) => h.hitsSelf) : []`);
      await cdp2.evaluate(`(() => { const el = ${OVERLAY}; if (el) { el.style.overflowY = el.dataset.verify672OldOverflow; delete el.dataset.verify672OldOverflow; } return true; })()`);
      if (noScrollHits.length > 0 && noScrollHits.every(Boolean)) {
        failures.push('short-window: forcing overflow-y:hidden still reached every button -- this check would not catch overflow-y-auto being removed.');
      } else {
        findings.push('short-window: forcing overflow-y:hidden (temporary fault injection) made at least one button unreachable, confirming this check would catch a regression.');
      }
    });

    // ---- Extended: a real "Keep waiting" click (not a synthetic kind write) ----
    await cdp2.clickByText('Keep waiting');
    await waitForStartProgressKind(cdp2, sessionC.id, 'extended', 5_000);
    const extendedState = await readNoticeState(cdp2);
    assertCentred(extendedState, 'history/extended', failures);
    if (extendedState.regionFound) assertSizesAndColours(extendedState, extendedState.regionRect.width, 'history/extended', fg, muted, failures, findings);
    if (extendedState.buttonTexts.includes('Keep waiting')) failures.push(`history/extended: "Keep waiting" is still present (group buttons: ${JSON.stringify(extendedState.buttonTexts)}) -- the state machine says Extended has no further Keep-waiting decision.`);
    if (!extendedState.buttonTexts.includes('Cancel')) failures.push(`history/extended: no "Cancel" button found (group buttons: ${JSON.stringify(extendedState.buttonTexts)}).`);
    else findings.push('history/extended: real "Keep waiting" click reached the real `extended` startProgress.kind; Cancel remains, Keep waiting does not, matching the state machine.');
    await cdp2.screenshot(path.join(SHOTS_DIR, '09-history-extended.png'));

    const report = { gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, exitCode: failures.length > 0 ? 1 : 0 };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`\n=== ${LOG}: FAILURES (always fail the run) ===`);
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log(`\n=== ${LOG}: FINDINGS ===`);
    for (const f of findings) console.log(`- ${f}`);
    console.log(`\n=== ${LOG}: NOT EXERCISED (genuine skips only) ===`);
    for (const n of notExercised) console.log(`- ${n}`);
    console.log(`\nScreenshots and report.json: ${SHOTS_DIR}`);
    console.log(`${LOG}: ${failures.length > 0 ? 'FAILED' : 'DONE'}.`);
    process.exitCode = failures.length > 0 ? 1 : 0;
  } catch (err) {
    try {
      mkdirSync(SHOTS_DIR, { recursive: true });
      writeFileSync(
        path.join(SHOTS_DIR, 'report.json'),
        JSON.stringify({ gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, error: String(err?.stack ?? err), exitCode: 1 }, null, 2)
      );
    } catch {
      // best-effort only
    }
    console.error(`${LOG}: FAILED:`, err?.stack ?? err);
    process.exitCode = 1;
  } finally {
    await teardownLaunch(launch1);
    await teardownLaunch(launch2);
    await safeRmSync(exeDir);
    await safeRmSync(launcherDir);
  }
}

main().catch((err) => {
  console.error(`${LOG}: unhandled error:`, err?.stack ?? err);
  process.exitCode = 1;
});
