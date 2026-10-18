#!/usr/bin/env node
// Live CDP check for issue #672 (follow-up to #618, shipped and closed): one centred Session
// start notice for every Session, larger and in the normal foreground colour, the transcript
// dimmed behind it for a Session that already has history. Modelled on
// `verify-947-938-slash-menu.mjs`'s own structure and isolation posture; the fake-omp launch
// (env vars only, no PATH shim) follows `verify-563-subagent-stage.mjs`/`verify-556-zero-box.mjs`'s
// own direct `launchViaJobObject` pattern, since the shared `launchBuiltExe` in
// `verify-tauri-scratch-helpers.mjs` supports only a real-omp launch.
//
// Drives the fake-omp shim (default `session` tape: one real tool-call turn) rather than a real
// `omp`, since every acceptance item here is about the notice's OWN rendering (size, colour,
// centring, dim) across five `startProgress.kind` values a real agent only reaches slowly and
// nondeterministically (`prompt`/`extended`/`queued`/`memory-deferred`) -- this script drives
// those directly through `window.__refractStores` (dev-only CDP injection seam,
// `src/renderer/state/index.ts`), the SAME technique #618's own PLAN.md row records using for its
// round 1/3 live checks ("CDP state injection"). A real send through the fake-omp tape (not
// synthetic) builds one Session's REAL history, and a real `openInSplit` store call (not manual
// divider dragging) opens a genuine second pane.
//
// Gate round 1 (Main, A11y/UI/Test FAIL) rewrote every check below: opacity reads now poll with a
// timeout instead of a single read; the dimmed transcript is proven to stay genuinely scrollable
// (a real wheel event, forced scrollable via a temporary short viewport override) and to restore
// full opacity on focus, instead of asserting `pointer-events: none` (the product decision
// reversed that); the announcement check now drives a fresh `undefined -> waiting` transition and
// a `MutationObserver` (not a 50ms poll) to prove zero re-announcements; the split-pane and
// short-window cases are FORCED via `Emulation.setDeviceMetricsOverride` rather than only
// measuring whatever width/height this run happens to get, so neither is ever silently skipped; a
// failed `theme.set` is a failure, not `notExercised`; and `requireSharedCargoTarget`/`gitHead` now
// run inside the `try` so `report.json` is written even if either throws.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, launchViaJobObject, resolveCssVarColor, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';
import {
  GROUP, REGIONS, REGION0, ANNOUNCE, OVERLAY, THEMES, JOKE_STAGES, PLAIN_STAGES, NARROW_BREAKPOINT_PX,
  expectedSizesForWidth, fontSizePx, animationDurationMs, contrastRatio, parseRgba, blendOver, rgbToCss, dispatchTab,
  setStartProgress, waitForRegionOpacity, waitForComputedOpacity, withDeviceMetrics, readNoticeState, assertCentred, assertSizesAndColours, focusLastTabbableOrSelf
} from './verify-672-start-message-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-672';
const SHOTS_DIR =
  process.env.REFRACT_672_SHOTS_DIR || path.join(tmpdir(), 'refract-672-start-message-shots', new Date().toISOString().replace(/[:.]/g, '-'));

async function main() {
  let dataDir, importSourceDir, repoDir, exeDir, launcherDir;
  let child;
  let cdp;
  const findings = [];
  const failures = [];
  const notExercised = [];
  let exeHash = null;
  let gitHeadSha = null;
  let dirty = 'unknown';
  let buildOutputDir = null;
  try {
    // Gate-fix (UI round 1, item 13): both of these can throw before any scratch state exists --
    // run first, inside the try, so a throw here still produces a report.json (the `catch` below
    // writes one from whatever these two managed to set).
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;
    buildOutputDir = requireSharedCargoTarget(REPO_ROOT);

    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-672-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-672-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-672-repo-')), 'verify-672-start-message');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-672-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-672-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, approvalMode: 'auto' }));
    const port = await getFreePort();

    console.log(`${LOG}: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`${LOG}: shots dir ${SHOTS_DIR}`);

    const built = buildAndCopyExeFresh(exeDir, buildOutputDir, REPO_ROOT, { label: LOG });
    const exePath = built.dest;
    exeHash = built.hash;
    const launcherExe = buildLauncher(launcherDir);

    const webview2DataDir = path.join(exeDir, 'webview2-data');
    mkdirSync(webview2DataDir, { recursive: true });
    const pidFile = path.join(exeDir, 'target.pid');
    const env = {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
      REFRACT_DATA_DIR: dataDir,
      REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      REFRACT_FAKE_OMP_DEBUG_LOG: path.join(exeDir, 'fake-omp-invocations.log')
    };
    const launched = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: exeDir, env });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`${LOG}: CDP target on port ${port} is not owned by the process this run launched (pid ${targetPid})`);
    }

    // ---- Readiness, add repository, create Session A (brand-new) ----
    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: 'Readiness screen mounted' });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 30_000, label: 'Readiness green (fake omp)' }
    );
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: 'Add repository dialog open' });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(`!!document.querySelector('[data-quick-create-session]')`, { timeoutMs: 30_000, label: 'Scratch repository added, quick-create button visible' });

    await cdp.click(`document.querySelector('[data-quick-create-session]')`);
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 30_000,
      label: 'Session A created, fake agent attached, composer enabled'
    });
    const sessionAId = await cdp.evaluate(`window.__refractStores.sessions.getState().sessions[0].id`);
    findings.push(`Session A created (id ${sessionAId}), brand-new (no history yet).`);

    // ---- (1) Brand-new Session: every startProgress.kind, centred, not dimmed, large sizing ----
    const resolvedForeground = await resolveCssVarColor(cdp, '--foreground', 'color');
    const resolvedMuted = await resolveCssVarColor(cdp, '--muted-foreground', 'color');
    let wideRegionWidth = null;
    let jokeMessageText = null;
    for (const stage of JOKE_STAGES) {
      await setStartProgress(cdp, sessionAId, stage);
      await cdp.waitFor(`!!${GROUP}`, { timeoutMs: 10_000, label: `notice mounted for kind=${stage.kind}` });
      const opacityPoll = await waitForRegionOpacity(cdp, (v) => v > 0.95);
      if (!opacityPoll.ok) failures.push(`brand-new/${stage.kind}: transcript region opacity settled at ${opacityPoll.value}, expected >0.95 (brand-new Session has nothing to dim).`);
      else findings.push(`brand-new/${stage.kind}: transcript region opacity settled at ${opacityPoll.value} (not dimmed), as expected.`);
      const state = await readNoticeState(cdp);
      assertCentred(state, `brand-new/${stage.kind}`, failures);
      if (state.regionFound) {
        wideRegionWidth = state.regionRect.width;
        assertSizesAndColours(state, state.regionRect.width, `brand-new/${stage.kind}`, resolvedForeground, resolvedMuted, failures, findings);
      }
      if (stage.kind === 'prompt' && !state.buttonTexts.includes('Keep waiting')) failures.push(`brand-new/prompt: no "Keep waiting" button found (group buttons: ${JSON.stringify(state.buttonTexts)}).`);
      if (['prompt', 'extended'].includes(stage.kind) && !state.buttonTexts.includes('Cancel')) failures.push(`brand-new/${stage.kind}: no "Cancel" button found (group buttons: ${JSON.stringify(state.buttonTexts)}).`);
      if (stage.kind === 'waiting') jokeMessageText = await cdp.evaluate(`document.querySelector('[data-start-message]')?.textContent ?? null`);
      await cdp.screenshot(path.join(SHOTS_DIR, `01-brand-new-${stage.kind}.png`));
    }
    for (const stage of PLAIN_STAGES) {
      await setStartProgress(cdp, sessionAId, stage);
      await cdp.waitFor(`!!document.querySelector('[data-start-plain-text]')`, { timeoutMs: 10_000, label: `plain notice mounted for kind=${stage.kind}` });
      const state = await readNoticeState(cdp);
      assertCentred(state, `brand-new/${stage.kind}`, failures);
      const plainPx = fontSizePx(state.plain?.fontSize);
      if (plainPx !== 16) failures.push(`brand-new/${stage.kind}: plain text font-size is ${state.plain?.fontSize}, expected 16px (text-base).`);
      else findings.push(`brand-new/${stage.kind}: plain text font-size 16px (text-base), as specified for queued/memory-deferred.`);
      if (state.plain && state.plain.color !== resolvedMuted) failures.push(`brand-new/${stage.kind}: plain text colour is ${state.plain.color}, expected --muted-foreground ${resolvedMuted}.`);
      if (!state.buttonTexts.includes('Cancel')) failures.push(`brand-new/${stage.kind}: no "Cancel" button found (group buttons: ${JSON.stringify(state.buttonTexts)}).`);
      await cdp.screenshot(path.join(SHOTS_DIR, `01-brand-new-${stage.kind}.png`));
    }

    // ---- (5) Announcement: a fresh undefined->waiting start reads exactly, never the joke, and
    // a same-kind re-render produces zero DOM mutations (MutationObserver, not a timing poll) ----
    await setStartProgress(cdp, sessionAId, undefined);
    await sleep(6_500); // >6s: lets useClearedAnnouncement's own 6s auto-clear timer run out, so the fresh start below measures a genuinely clean first announcement, not a leftover one.
    const staleAnnouncement = await cdp.evaluate(`${ANNOUNCE}?.textContent || ''`);
    if (staleAnnouncement !== '') notExercised.push(`Announcement region still read "${staleAnnouncement}" after waiting 6.5s to auto-clear -- the fresh-start text assertion below may not be measuring a clean first announcement.`);
    const sessionName = await cdp.evaluate(`window.__refractStores.sessions.getState().sessions.find((s) => s.id === ${JSON.stringify(sessionAId)})?.name ?? null`);
    await setStartProgress(cdp, sessionAId, { kind: 'waiting', elapsedMs: 0 });
    const freshText = await cdp.waitFor(`${ANNOUNCE}?.textContent || null`, { timeoutMs: 10_000, label: 'fresh start announcement text set' });
    const expectedFreshText = sessionName ? `Starting agent: ${sessionName}` : null;
    if (!expectedFreshText) notExercised.push("Could not read Session A's own display name -- the exact fresh-start announcement text could not be asserted, only its presence.");
    else if (freshText !== expectedFreshText) failures.push(`Fresh undefined->waiting start announced "${freshText}", expected exactly "${expectedFreshText}".`);
    else findings.push(`Fresh undefined->waiting start announced exactly "${freshText}", as expected.`);
    if (jokeMessageText && freshText.includes(jokeMessageText)) failures.push(`Announcement text ("${freshText}") includes the joke message ("${jokeMessageText}") -- the joke must never be announced.`);
    else findings.push('Announcement text does not include the joke message, as specified.');

    await cdp.evaluate(`(() => {
      window.__672Mutations = 0;
      window.__672Observer = new MutationObserver(() => { window.__672Mutations++; });
      window.__672Observer.observe(${ANNOUNCE}, { childList: true, characterData: true, subtree: true });
      return true;
    })()`);
    await setStartProgress(cdp, sessionAId, { kind: 'waiting', elapsedMs: 3_000 });
    await sleep(400);
    await setStartProgress(cdp, sessionAId, { kind: 'waiting', elapsedMs: 7_000 });
    await sleep(400);
    const mutationCount = await cdp.evaluate(`(() => { window.__672Observer.disconnect(); return window.__672Mutations; })()`);
    if (mutationCount !== 0) failures.push(`Announcement region mutated ${mutationCount} time(s) (MutationObserver) across same-kind (waiting) elapsedMs ticks -- it must not re-announce (the #618 round-2 fix regressed).`);
    else findings.push('Announcement region recorded zero DOM mutations (MutationObserver) across same-kind elapsedMs ticks -- no re-announcement.');

    // ---- Clear: notice unmounts, "Ready..." reappears (brand-new Session) ----
    await setStartProgress(cdp, sessionAId, undefined);
    await cdp.waitFor(`!${GROUP}`, { timeoutMs: 10_000, label: 'notice unmounted after startProgress cleared' });
    const readyShown = await cdp.evaluate(`Array.from(${REGIONS}).some((r) => r.textContent.includes('Ready. Type a message to get started.'))`);
    if (!readyShown) failures.push('After startProgress cleared on a brand-new Session, "Ready. Type a message to get started." did not reappear.');
    else findings.push('The notice cleared and "Ready. Type a message to get started." reappeared once startProgress cleared (brand-new Session).');
    await cdp.screenshot(path.join(SHOTS_DIR, '02-brand-new-cleared-ready.png'));

    // ---- Build real history on Session A (a real send through the fake-omp session tape) ----
    await cdp.click(`document.querySelector('[aria-label="Message"]')`);
    await cdp.send('Input.insertText', { text: 'Reply with exactly the single word t672turn and nothing else.' });
    await cdp.clickByLabel('Send message');
    await cdp.waitFor(`Array.from(${REGIONS}).some((r) => /t672turn/.test(r.textContent))`, { timeoutMs: 60_000, label: 'Real turn settled (fake-omp reply contains sentinel)' });
    await cdp.waitFor(`window.__refractStores.sessions.getState().sessions.find((s) => s.id === ${JSON.stringify(sessionAId)})?.currentConversation !== null`, {
      timeoutMs: 30_000,
      label: 'Session A now has real history (currentConversation settled)'
    });
    findings.push('Session A sent and settled one real turn through the fake-omp session tape -- it now has real history (currentConversation set).');

    // ---- (2) Session with history: centred, dimmed ~40%, stays interactive ----
    await setStartProgress(cdp, sessionAId, { kind: 'waiting', elapsedMs: 0 });
    await cdp.waitFor(`!!${GROUP}`, { timeoutMs: 10_000, label: 'notice mounted over Session-with-history' });
    const dimPoll = await waitForRegionOpacity(cdp, (v) => v <= 0.45);
    if (!dimPoll.ok) failures.push(`history/waiting: transcript region opacity settled at ${dimPoll.value}, expected <=0.45 (~40%, dimmed behind the notice).`);
    else findings.push(`history/waiting: transcript region opacity settled at ${dimPoll.value} (~40%), dimmed behind the notice as specified.`);
    const historyState = await readNoticeState(cdp);
    assertCentred(historyState, 'history/waiting', failures);
    if (historyState.regionFound) assertSizesAndColours(historyState, historyState.regionRect.width, 'history/waiting', resolvedForeground, resolvedMuted, failures, findings);
    await cdp.screenshot(path.join(SHOTS_DIR, '03-history-dimmed.png'));

    // Gate-fix (UI round 1, item 7; corrected round 2, item 6): the dimmed history must stay
    // genuinely scrollable -- forced scrollable via a short viewport override so this is never a
    // silent no-op against a transcript too short to scroll anyway. The wheel point is proven
    // (via `elementFromPoint`) to land inside the transcript and OUTSIDE the notice's own box
    // before dispatching; `defaultScrollPosition="end"` means scrollTop already sits near its
    // max, so an upward wheel (`deltaY:-150`) is the direction guaranteed to show a clear,
    // unclamped decrease.
    await withDeviceMetrics(cdp, 900, 260, async () => {
      await cdp.waitFor(`!!${GROUP}`, { timeoutMs: 10_000, label: 'notice still mounted after short-viewport override' });
      const probe = await cdp.evaluate(`(() => {
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
      const before = await cdp.evaluate(`${REGION0}?.scrollTop ?? null`);
      if (before === null || !(before > 0)) {
        failures.push(`history/wheel: transcript scrollTop is ${before} before the wheel, expected >0 (defaultScrollPosition="end" in a forced-short viewport) so an upward wheel has somewhere to decrease from.`);
        return;
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: probe.x, y: probe.y, deltaX: 0, deltaY: -150 });
      await sleep(200);
      const after = await cdp.evaluate(`${REGION0}?.scrollTop ?? null`);
      if (after === null || !(after < before)) {
        failures.push(`history/wheel: a wheel (deltaY:-150) at a point confirmed inside the transcript and outside the notice did not decrease scrollTop (${before} -> ${after}) -- it must stay scrollable while dimmed.`);
      } else {
        findings.push(`history/wheel: a wheel at a point confirmed (elementFromPoint) inside the transcript and outside the notice decreased scrollTop (${before} -> ${after}), confirming it stays interactive while dimmed.`);
      }
      await focusLastTabbableOrSelf(cdp, REGION0);
      const focusedOpacity = await waitForRegionOpacity(cdp, (v) => v > 0.95, 2_000);
      if (!focusedOpacity.ok) failures.push(`history/focus: focusing the dimmed transcript region did not restore full opacity (settled at ${focusedOpacity.value}) -- focus-within:opacity-100 regressed.`);
      else findings.push(`history/focus: focusing the dimmed transcript region restored full opacity (${focusedOpacity.value}), as specified.`);

      // ---- Gate round 2 item 9 (corrected round 3, items 1/2): the OVERLAY itself (not the
      // inner wrapper -- see the peer-focus-within fix) hides while focus sits in the history,
      // and Tab from there reaches Keep waiting and reveals it again. `prompt` stage so the
      // button exists; `focusLastTabbableOrSelf` guarantees the NEXT Tab exits the history. ----
      await setStartProgress(cdp, sessionAId, { kind: 'prompt', elapsedMs: 20_000 });
      await cdp.waitFor(`!!${OVERLAY}`, { timeoutMs: 10_000, label: 'overlay mounted (prompt stage) for the focus-hide check' });
      await focusLastTabbableOrSelf(cdp, REGION0);
      const hiddenOpacityPoll = await waitForComputedOpacity(cdp, OVERLAY, (v) => v <= 0.05, 2_000);
      const hidden = await cdp.evaluate(`(() => {
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
        failures.push(`focus-hide: with focus inside the history, the overlay opacity settled at ${hiddenOpacityPoll.value} (expected <=0.05) and the wrapper read pointer-events ${hidden?.wrapperPointerEvents} (expected none) -- WCAG 2.4.11. Deliberately measuring opacity, not CSS \`visibility\` -- see Transcript.tsx's own comment for why \`visibility:hidden\` would break Tab reachability instead.`);
      } else if (!hidden.hitIsTranscript) {
        failures.push('focus-hide: the overlay is hidden but the transcript region centre is still not the elementFromPoint hit -- something else may be covering it.');
      } else {
        findings.push(`focus-hide: with focus inside the history, the overlay opacity settled at ${hiddenOpacityPoll.value} and the wrapper reads pointer-events none (hidden), and the transcript's own centre is reachable by elementFromPoint.`);
      }
      await dispatchTab(cdp);
      const afterTabOpacityPoll = await waitForComputedOpacity(cdp, OVERLAY, (v) => v >= 0.95, 2_000);
      const afterTab = await cdp.evaluate(`(() => {
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
      await cdp.evaluate(`document.activeElement?.blur()`);
    });

    await setStartProgress(cdp, sessionAId, undefined);
    await cdp.waitFor(`!${GROUP}`, { timeoutMs: 10_000, label: 'notice unmounted (Session with history)' });
    const clearedPoll = await waitForRegionOpacity(cdp, (v) => v > 0.95);
    if (!clearedPoll.ok) failures.push(`history/cleared: transcript region opacity settled at ${clearedPoll.value}, expected ~1 after startProgress cleared.`);
    else findings.push(`history/cleared: transcript region opacity returned to ${clearedPoll.value} once startProgress cleared.`);
    await cdp.screenshot(path.join(SHOTS_DIR, '04-history-cleared.png'));

    // ---- (3) Split pane: a real second Session, real openInSplit, measured narrower width;
    // forced under the narrow breakpoint if this run's own window did not land there naturally
    // (gate-fix UI round 1, item 9: never silently skip the compact-sizing code path) ----
    await cdp.click(`document.querySelector('[data-quick-create-session]')`);
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 30_000,
      label: 'Session B created, fake agent attached, composer enabled'
    });
    await cdp.evaluate(`window.__refractStores.split.getState().openInSplit(${JSON.stringify(sessionAId)}); true`);
    await cdp.waitFor(`${REGIONS}.length === 2`, { timeoutMs: 15_000, label: 'Split open: two Transcript regions rendered' });
    await setStartProgress(cdp, sessionAId, { kind: 'waiting', elapsedMs: 0 });
    await cdp.waitFor(`!!${GROUP}`, { timeoutMs: 10_000, label: 'notice mounted in the split pane' });
    let splitState = await readNoticeState(cdp);
    assertCentred(splitState, 'split/waiting', failures);
    if (splitState.regionFound && wideRegionWidth !== null && !(splitState.regionRect.width < wideRegionWidth)) {
      failures.push(`split/waiting: split pane width (${splitState.regionRect.width.toFixed(0)}px) is not narrower than the single-pane width (${wideRegionWidth.toFixed(0)}px) -- the split did not actually narrow this pane.`);
    } else if (splitState.regionFound && wideRegionWidth !== null) {
      findings.push(`split/waiting: split pane measured ${splitState.regionRect.width.toFixed(0)}px wide, narrower than the single-pane ${wideRegionWidth.toFixed(0)}px, as expected.`);
    }
    if (splitState.regionFound && splitState.regionRect.width >= NARROW_BREAKPOINT_PX) {
      findings.push(`split/waiting: this run's own split pane measured ${splitState.regionRect.width.toFixed(0)}px (>=640px, the wide regime) -- forcing the window narrower to exercise the compact-sizing code path too.`);
      await withDeviceMetrics(cdp, 950, 800, async () => {
        await cdp.waitFor(`!!${GROUP}`, { timeoutMs: 10_000, label: 'notice still mounted after narrowing the window' });
        splitState = await readNoticeState(cdp);
        if (splitState.regionFound) assertSizesAndColours(splitState, splitState.regionRect.width, 'split/waiting (forced narrow)', resolvedForeground, resolvedMuted, failures, findings);
        else failures.push('split/waiting (forced narrow): no Transcript region found to measure after narrowing the window.');
        await cdp.screenshot(path.join(SHOTS_DIR, '05-split-pane-forced-narrow.png'));
      });
    } else if (splitState.regionFound) {
      assertSizesAndColours(splitState, splitState.regionRect.width, 'split/waiting', resolvedForeground, resolvedMuted, failures, findings);
      await cdp.screenshot(path.join(SHOTS_DIR, '05-split-pane.png'));
    }

    // ---- (4) Reduced motion: the emoji's bob collapses to (near-)zero duration ----
    const beforeMotionState = await readNoticeState(cdp);
    const normalDurationMs = animationDurationMs(beforeMotionState.emoji?.animationDuration);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(200);
    const reducedState = await readNoticeState(cdp);
    const reducedDurationMs = animationDurationMs(reducedState.emoji?.animationDuration);
    if (normalDurationMs !== null && normalDurationMs <= 1) notExercised.push(`Normal (non-reduced-motion) emoji animation-duration was already ${beforeMotionState.emoji?.animationDuration} -- could not confirm reduced-motion actually changed anything.`);
    if (reducedDurationMs === null || reducedDurationMs > 1) failures.push(`With prefers-reduced-motion:reduce, emoji animation-duration is ${reducedState.emoji?.animationDuration} (${reducedDurationMs}ms), expected <=1ms (collapsed by the global reduced-motion rule).`);
    else findings.push(`With prefers-reduced-motion:reduce, emoji animation-duration collapsed to ${reducedState.emoji?.animationDuration} (<=1ms), down from ${beforeMotionState.emoji?.animationDuration} normally.`);
    await cdp.screenshot(path.join(SHOTS_DIR, '06-reduced-motion.png'));
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });

    // ---- (6) Themes: a failed theme.set is a FAILURE now, not notExercised. Driven at the
    // `prompt` stage (not `waiting`) so the guidance text and buttons exist alongside the joke.
    // Gate round 2 item 7: contrast is measured against the panel's own WORST-CASE effective
    // background -- `--foreground` at 40% opacity (the brightest plausible thing visible
    // through the dimmed history) composited UNDER the panel's own real `bg-background/90` (its
    // genuine alpha, read from the live element, not assumed) -- in every theme, for the
    // message, counter, guidance text AND every button label. A regression-proof self-check
    // (forcing the panel transparent and re-measuring) confirms this would actually catch
    // `bg-background/90` being removed. ----
    await setStartProgress(cdp, sessionAId, { kind: 'prompt', elapsedMs: 20_000 });
    await cdp.waitFor(`!!document.querySelector('[data-start-guidance]')`, { timeoutMs: 10_000, label: 'prompt-stage notice (guidance text) mounted for the theme loop' });
    const dimBeforeThemes = await readNoticeState(cdp);
    if (!dimBeforeThemes.regionFound || !(dimBeforeThemes.regionOpacity <= 0.45)) {
      failures.push(`theme-contrast: transcript region opacity is ${dimBeforeThemes.regionFound ? dimBeforeThemes.regionOpacity : 'unknown (region not found)'}, expected <=0.45 -- the panel should be backing a dimmed history here, not measuring against an undimmed/missing one.`);
    }
    for (const theme of THEMES) {
      if (theme.id !== 'dark') {
        const result = await cdp.evaluate(`window.refract.theme.set(${JSON.stringify(theme.id)}).then((r) => r.ok)`);
        if (result !== true) {
          failures.push(`theme.set(${theme.id}) did not return ok -- cannot verify ${theme.name}.`);
          continue;
        }
        await cdp.waitFor(`document.documentElement.classList.contains(${JSON.stringify(`theme-${theme.id}`)})`, { timeoutMs: 10_000, label: `${theme.name} theme applied` });
      }
      await cdp.screenshot(path.join(SHOTS_DIR, `07-theme-${theme.id}.png`));
      const themeState = await readNoticeState(cdp);
      const panelRaw = await cdp.evaluate(`(() => { const el = ${GROUP}; return el ? getComputedStyle(el).backgroundColor : null; })()`);
      const panel = parseRgba(panelRaw);
      const backgroundRgb = parseRgba(await resolveCssVarColor(cdp, '--background', 'background-color'));
      const foregroundRgb = parseRgba(await resolveCssVarColor(cdp, '--foreground', 'background-color'));
      const buttonColours = await cdp.evaluate(`${GROUP} ? Array.from(${GROUP}.querySelectorAll('button')).map((b) => ({ text: b.textContent.trim(), color: getComputedStyle(b).color })) : []`);
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
      // Self-validation (item 7: "removing bg-background/90 must make it fail"): force the
      // panel transparent, remeasure against the bare worst-case backdrop, and confirm at least
      // one colour reads worse or failing -- proving the panel is genuinely improving contrast.
      await cdp.evaluate(`(() => { const el = ${GROUP}; if (el) el.style.backgroundColor = 'transparent'; return true; })()`);
      const bareCss = rgbToCss(worstCaseBackdrop);
      const hadWorseOrFailing = pairs.some(([, colour]) => {
        const withPanel = contrastRatio(colour, panelEffectiveCss);
        const withoutPanel = contrastRatio(colour, bareCss);
        return withPanel !== null && withoutPanel !== null && (withoutPanel < withPanel - 0.05 || withoutPanel < 4.5);
      });
      await cdp.evaluate(`(() => { const el = ${GROUP}; if (el) el.style.removeProperty('background-color'); return true; })()`);
      if (!hadWorseOrFailing) failures.push(`${theme.name}: removing bg-background/90 did not read worse/failing for any measured colour -- this contrast check would not catch that regression.`);
      else findings.push(`${theme.name}: removing bg-background/90 (temporary fault injection) reads a worse or failing contrast for at least one colour, confirming this check would catch a regression.`);
    }
    await cdp.evaluate(`window.refract.theme.set('dark')`);

    // ---- A genuinely short (600px tall) window: Keep waiting/Cancel reachable the user's way
    // (a real wheel scroll, elementFromPoint hit-testing, not just rect-in-bounds math), forced
    // via Emulation.setDeviceMetricsOverride (gate round 1 item 12 / round 2 item 8: never
    // silently skip, and prove the check has teeth) ----
    await withDeviceMetrics(cdp, 900, 600, async () => {
      await cdp.waitFor(`!!${GROUP}`, { timeoutMs: 10_000, label: 'notice still mounted in the 600px-tall window' });
      const overflowCheck = await cdp.evaluate(`(() => { const el = ${OVERLAY}; return el ? { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } : null; })()`);
      if (!overflowCheck || !(overflowCheck.scrollHeight > overflowCheck.clientHeight)) {
        failures.push(`short-window: overlay scrollHeight (${overflowCheck?.scrollHeight}) is not greater than clientHeight (${overflowCheck?.clientHeight}) -- it did not genuinely overflow this 600px-tall window.`);
        return;
      }
      findings.push(`short-window: overlay genuinely overflows (scrollHeight ${overflowCheck.scrollHeight} > clientHeight ${overflowCheck.clientHeight}).`);
      async function scrollOverlayToEndViaWheel() {
        const centre = await cdp.evaluate(`(() => { const el = ${OVERLAY}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        if (!centre) return false;
        for (let i = 0; i < 20; i++) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: centre.x, y: centre.y, deltaX: 0, deltaY: 200 });
          await sleep(80);
        }
        return true;
      }
      const buttonHitExpr = `Array.from(${GROUP}.querySelectorAll('button')).map((b) => { const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { text: b.textContent.trim(), hitsSelf: hit === b || (!!hit && b.contains(hit)) }; })`;
      if (!(await scrollOverlayToEndViaWheel())) failures.push('short-window: no overlay element found to dispatch wheel events at.');
      const buttonHits = await cdp.evaluate(`${GROUP} ? (${buttonHitExpr}) : []`);
      if (buttonHits.length === 0) failures.push('short-window: no buttons found in the Agent start group at the prompt stage (expected Keep waiting and Cancel).');
      for (const b of buttonHits) {
        if (b.hitsSelf) findings.push(`short-window: "${b.text}" button is the real elementFromPoint hit at its own centre after a real wheel scroll, confirming it is genuinely reachable.`);
        else failures.push(`short-window: "${b.text}" button is NOT the elementFromPoint hit at its own centre after a real wheel scroll to the overlay's end -- not genuinely reachable.`);
      }
      await cdp.screenshot(path.join(SHOTS_DIR, '08-short-window-prompt.png'));

      // Self-validation (item 8: "removing overflow-y-auto must make it fail"): force the
      // overlay non-scrollable, repeat the same procedure, and confirm at least one button
      // becomes unreachable -- proving this check has teeth, not just measuring rect math.
      await cdp.evaluate(`(() => { const el = ${OVERLAY}; if (el) { el.dataset.verify672OldOverflow = el.style.overflowY || ''; el.style.overflowY = 'hidden'; el.scrollTop = 0; } return true; })()`);
      await sleep(150);
      await scrollOverlayToEndViaWheel();
      const noScrollHits = await cdp.evaluate(`${GROUP} ? (${buttonHitExpr}).map((h) => h.hitsSelf) : []`);
      await cdp.evaluate(`(() => { const el = ${OVERLAY}; if (el) { el.style.overflowY = el.dataset.verify672OldOverflow; delete el.dataset.verify672OldOverflow; } return true; })()`);
      if (noScrollHits.length > 0 && noScrollHits.every(Boolean)) {
        failures.push('short-window: forcing overflow-y:hidden still reached every button -- this check would not catch overflow-y-auto being removed.');
      } else {
        findings.push('short-window: forcing overflow-y:hidden (temporary fault injection) made at least one button unreachable, confirming this check would catch a regression.');
      }
    });
    await setStartProgress(cdp, sessionAId, undefined);

    const report = { gitHead: gitHeadSha, dirty, exeSha256: exeHash, findings, failures, notExercised, exitCode: failures.length > 0 ? 1 : 0 };
    writeFileSync(path.join(SHOTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`\n=== ${LOG}: FAILURES (always fail the run) ===`);
    if (failures.length === 0) console.log('(none)');
    for (const f of failures) console.log(`- ${f}`);
    console.log(`\n=== ${LOG}: FINDINGS ===`);
    for (const f of findings) console.log(`- ${f}`);
    console.log(`\n=== ${LOG}: NOT EXERCISED (genuine skips only) ===`);
    if (notExercised.length === 0) console.log('(none)');
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
  console.error(`${LOG}: unhandled error:`, err?.stack ?? err);
  process.exitCode = 1;
});
