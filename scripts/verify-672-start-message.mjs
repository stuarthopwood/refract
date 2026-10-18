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
// divider dragging) opens a genuine second pane, so the "normal-width pane" vs "split pane"
// comparison is a real measured container width in each case, not an assumed window size.
//
// Checks, in order: (1) a brand-new Session (no history): centred, not dimmed, large sizing
// (text-2xl/text-5xl), foreground colour, across all five `startProgress.kind` values, Keep
// waiting/Cancel reachable on `prompt`/`extended`/`queued`/`memory-deferred`, then clears to
// "Ready..." once `startProgress` clears; (2) the SAME Session after a real send/settle (now has
// history): centred, dimmed to ~40% opacity and non-interactive behind the notice, clears back to
// full opacity and interactive when `startProgress` clears; (3) a second pane via a real split:
// the narrower pane's own measured container width decides which sizing regime this script
// expects (a generic width-to-size rule, not a hardcoded split assumption) -- confirms the
// responsive rule actually responds to real layout, narrower than the single-pane case; (4)
// `prefers-reduced-motion` leaves the emoji's bob animation at (near-)zero duration; (5) the
// dedicated announcement live region (`data-start-announcement`, added by this PR for this check)
// does not re-announce across a same-kind re-render (the regression #618 round 2 already fixed
// once; this proves #672's refactor did not reopen it) and never contains the joke text itself;
// (6) Dark, Obsidian, and Dark (high contrast).
//
// NOT exercised: a genuinely short (600px tall) native window -- this harness has no confirmed
// native window-resize API over this WebView2 CDP endpoint, so "never pushed off-screen on a
// short window" is reported as not exercised rather than faked.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, launchViaJobObject, resolveCssVarColor, sleep } from './verify-tauri-cdp.mjs';
import { gitHead, buildLauncher, makeScratchRepo, buildAndCopyExeFresh, safeRmSync, requireSharedCargoTarget } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-672';
// #946: requires the shared CARGO_TARGET_DIR; refuses rather than falling back to a worktree-local src-tauri/target.
const BUILD_OUTPUT_DIR = requireSharedCargoTarget(REPO_ROOT);
const SHOTS_DIR =
  process.env.REFRACT_672_SHOTS_DIR || path.join(tmpdir(), 'refract-672-start-message-shots', new Date().toISOString().replace(/[:.]/g, '-'));

const GROUP = `document.querySelector('[aria-label="Agent start"]')`;
const REGIONS = `document.querySelectorAll('[aria-label="Transcript"]')`;
const ANNOUNCE = `document.querySelector('[data-start-announcement]')`;

const THEMES = [
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' }
];

// The joke-stage kinds (SessionStartNotice.tsx's own `isJokeStage`) and the plain-text kinds,
// each with a `showControls` kind mixed in so Keep waiting/Cancel reachability gets checked too.
const JOKE_STAGES = [
  { kind: 'waiting', elapsedMs: 0 },
  { kind: 'prompt', elapsedMs: 15_000 },
  { kind: 'extended', elapsedMs: 45_000 }
];
const PLAIN_STAGES = [
  { kind: 'queued', elapsedMs: 0 },
  { kind: 'memory-deferred', elapsedMs: 0 }
];

// The sizing rule under test (SessionStartNotice.tsx's own `@min-[40rem]`): below 40rem (640px)
// of container width the compact sizes apply (`text-xl`/`text-[40px]`); at or above it the large
// sizes apply (`text-2xl`/`text-5xl`). Mirrors the component's own Tailwind classes so a drift in
// either place shows up as a mismatch here, not two independent hardcoded numbers.
const NARROW_BREAKPOINT_PX = 640;
function expectedSizesForWidth(widthPx) {
  return widthPx >= NARROW_BREAKPOINT_PX
    ? { messagePx: 24, emojiPx: 48, label: 'wide (text-2xl/text-5xl)' }
    : { messagePx: 20, emojiPx: 40, label: 'narrow (text-xl/text-[40px])' };
}

function fontSizePx(cssFontSize) {
  const match = /^([\d.]+)px$/.exec(cssFontSize ?? '');
  return match ? Number(match[1]) : null;
}

function animationDurationMs(cssDuration) {
  const match = /^([\d.]+)(m?s)$/.exec(cssDuration ?? '');
  if (!match) return null;
  return match[2] === 'ms' ? Number(match[1]) : Number(match[1]) * 1000;
}

async function setStartProgress(cdp, sessionId, startProgress) {
  const value = startProgress === undefined ? 'undefined' : JSON.stringify(startProgress);
  const ok = await cdp.evaluate(`(() => {
    const store = window.__refractStores.sessions;
    const sessions = store.getState().sessions.map((s) => s.id === ${JSON.stringify(sessionId)} ? { ...s, startProgress: ${value} } : s);
    store.setState({ sessions });
    return true;
  })()`);
  if (!ok) throw new Error(`setStartProgress(${sessionId}): store update did not return true`);
}

/** Reads the notice's own geometry/styles plus whichever Transcript region actually contains it,
 *  found by bounding-box containment of the notice's own centre point (correct regardless of
 *  pane index, not an assumed array position). */
async function readNoticeState(cdp) {
  return cdp.evaluate(`(() => {
    const group = ${GROUP};
    if (!group) return { present: false };
    const groupRect = group.getBoundingClientRect();
    const cx = groupRect.x + groupRect.width / 2, cy = groupRect.y + groupRect.height / 2;
    const region = Array.from(${REGIONS}).find((r) => {
      const rr = r.getBoundingClientRect();
      return cx >= rr.x && cx <= rr.x + rr.width && cy >= rr.y && cy <= rr.y + rr.height;
    });
    const styleOf = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { fontSize: cs.fontSize, color: cs.color, animationDuration: cs.animationDuration };
    };
    const buttonTexts = Array.from(group.querySelectorAll('button')).map((b) => b.textContent.trim());
    if (!region) return { present: true, regionFound: false, buttonTexts };
    const regionRect = region.getBoundingClientRect();
    const regionStyle = getComputedStyle(region);
    return {
      present: true,
      regionFound: true,
      groupRect: { x: groupRect.x, y: groupRect.y, width: groupRect.width, height: groupRect.height },
      regionRect: { x: regionRect.x, y: regionRect.y, width: regionRect.width, height: regionRect.height },
      regionOpacity: Number(regionStyle.opacity),
      regionPointerEvents: regionStyle.pointerEvents,
      buttonTexts,
      emoji: styleOf(group.querySelector('[data-start-emoji]')),
      message: styleOf(group.querySelector('[data-start-message]')),
      counter: styleOf(group.querySelector('[data-start-counter]')),
      plain: styleOf(group.querySelector('[data-start-plain-text]'))
    };
  })()`);
}

function assertCentred(state, label, failures) {
  if (!state.regionFound) {
    failures.push(`${label}: notice rendered but no owning Transcript region was found (geometry check skipped).`);
    return;
  }
  const g = state.groupRect, r = state.regionRect;
  const gcx = g.x + g.width / 2, gcy = g.y + g.height / 2;
  const rcx = r.x + r.width / 2, rcy = r.y + r.height / 2;
  const tolX = Math.max(24, r.width * 0.08);
  const tolY = Math.max(24, r.height * 0.08);
  if (Math.abs(gcx - rcx) > tolX || Math.abs(gcy - rcy) > tolY) {
    failures.push(
      `${label}: notice centre (${gcx.toFixed(1)}, ${gcy.toFixed(1)}) is not centred in its transcript region (${rcx.toFixed(1)}, ${rcy.toFixed(1)}), region ${r.width.toFixed(0)}x${r.height.toFixed(0)} (tolerance ${tolX.toFixed(0)}x${tolY.toFixed(0)}).`
    );
  }
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
  let dirty = 'unknown';
  try {
    dataDir = mkdtempSync(path.join(tmpdir(), 'refract-672-data-'));
    importSourceDir = mkdtempSync(path.join(tmpdir(), 'refract-672-import-'));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), 'refract-672-repo-')), 'verify-672-start-message');
    exeDir = mkdtempSync(path.join(tmpdir(), 'refract-672-exe-'));
    launcherDir = mkdtempSync(path.join(tmpdir(), 'refract-672-launcher-'));
    mkdirSync(SHOTS_DIR, { recursive: true });
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, approvalMode: 'auto' }));
    const port = await getFreePort();
    gitHeadSha = gitHead(REPO_ROOT);
    const gitStatusResult = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    const dirtyLines = gitStatusResult.status === 0 ? gitStatusResult.stdout.split('\n').filter(Boolean) : null;
    dirty = dirtyLines === null ? 'unknown' : dirtyLines.length ? dirtyLines : false;

    console.log(`${LOG}: git HEAD ${gitHeadSha}${dirtyLines && dirtyLines.length ? ` (DIRTY: ${dirtyLines.length} path(s))` : ''}`);
    console.log(`${LOG}: shots dir ${SHOTS_DIR}`);

    const built = buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, { label: LOG });
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
      const state = await readNoticeState(cdp);
      assertCentred(state, `brand-new/${stage.kind}`, failures);
      if (state.regionFound) {
        if (!(state.regionOpacity > 0.95)) failures.push(`brand-new/${stage.kind}: transcript region opacity is ${state.regionOpacity}, expected ~1 (brand-new Session has nothing to dim).`);
        if (state.regionPointerEvents === 'none') failures.push(`brand-new/${stage.kind}: transcript region pointer-events is 'none', expected interactive (brand-new Session has nothing to dim).`);
        wideRegionWidth = state.regionRect.width;
      }
      const expected = expectedSizesForWidth(state.regionFound ? state.regionRect.width : 9999);
      const emojiPx = fontSizePx(state.emoji?.fontSize);
      const messagePx = fontSizePx(state.message?.fontSize);
      if (emojiPx !== expected.emojiPx) failures.push(`brand-new/${stage.kind}: emoji font-size is ${state.emoji?.fontSize}, expected ${expected.emojiPx}px (${expected.label}).`);
      else findings.push(`brand-new/${stage.kind}: emoji font-size ${emojiPx}px matches ${expected.label}.`);
      if (messagePx !== expected.messagePx) failures.push(`brand-new/${stage.kind}: message font-size is ${state.message?.fontSize}, expected ${expected.messagePx}px (${expected.label}).`);
      else findings.push(`brand-new/${stage.kind}: message font-size ${messagePx}px matches ${expected.label}.`);
      if (state.message?.color !== resolvedForeground) failures.push(`brand-new/${stage.kind}: message colour is ${state.message?.color}, expected --foreground ${resolvedForeground} (not muted).`);
      else findings.push(`brand-new/${stage.kind}: message colour matches --foreground exactly (not muted).`);
      if (state.counter && state.counter.color !== resolvedMuted) failures.push(`brand-new/${stage.kind}: seconds counter colour is ${state.counter.color}, expected --muted-foreground ${resolvedMuted}.`);
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

    // ---- (5) Announcement: a same-kind re-render must not re-announce, and never carries the joke ----
    await setStartProgress(cdp, sessionAId, { kind: 'waiting', elapsedMs: 0 });
    const firstText = await cdp.waitFor(`${ANNOUNCE}?.textContent || null`, { timeoutMs: 10_000, label: 'start announcement text set' });
    if (jokeMessageText && firstText.includes(jokeMessageText)) {
      failures.push(`Announcement region text ("${firstText}") includes the joke message ("${jokeMessageText}") -- the joke must never be announced.`);
    } else {
      findings.push(`Announcement region text ("${firstText}") does not include the joke message, as specified.`);
    }
    await setStartProgress(cdp, sessionAId, { kind: 'waiting', elapsedMs: 7_000 });
    let sawBlank = false;
    const pollDeadline = Date.now() + 1_200;
    while (Date.now() < pollDeadline) {
      const text = await cdp.evaluate(`${ANNOUNCE}?.textContent || ''`);
      if (text === '') sawBlank = true;
      else if (text !== firstText) failures.push(`Announcement region changed from "${firstText}" to "${text}" on a same-kind re-render (elapsedMs tick) -- it must not re-announce.`);
      await sleep(50);
    }
    if (sawBlank) failures.push('Announcement region went blank (a fresh announce() call) on a same-kind re-render -- the #618 round-2 "only announce once" fix regressed.');
    else findings.push('Announcement region never went blank across a same-kind (waiting) re-render -- no re-announcement, matching #618\'s existing "announce once per transition" rule.');

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

    // ---- (2) Session with history: centred, dimmed ~40% + non-interactive behind the notice ----
    await setStartProgress(cdp, sessionAId, { kind: 'waiting', elapsedMs: 0 });
    await cdp.waitFor(`!!${GROUP}`, { timeoutMs: 10_000, label: 'notice mounted over Session-with-history' });
    const historyState = await readNoticeState(cdp);
    assertCentred(historyState, 'history/waiting', failures);
    if (historyState.regionFound) {
      if (historyState.regionOpacity < 0.35 || historyState.regionOpacity > 0.45) failures.push(`history/waiting: transcript region opacity is ${historyState.regionOpacity}, expected ~0.4 (dimmed behind the notice).`);
      else findings.push(`history/waiting: transcript region opacity is ${historyState.regionOpacity} (~40%), dimmed behind the notice as specified.`);
      if (historyState.regionPointerEvents !== 'none') failures.push(`history/waiting: transcript region pointer-events is "${historyState.regionPointerEvents}", expected "none" (non-interactive while the notice shows).`);
      else findings.push('history/waiting: transcript region is pointer-events:none (non-interactive) while the notice shows.');
    }
    const historyExpected = expectedSizesForWidth(historyState.regionFound ? historyState.regionRect.width : 9999);
    const historyMessagePx = fontSizePx(historyState.message?.fontSize);
    const historyEmojiPx = fontSizePx(historyState.emoji?.fontSize);
    if (historyMessagePx !== historyExpected.messagePx) failures.push(`history/waiting: message font-size is ${historyState.message?.fontSize}, expected ${historyExpected.messagePx}px (${historyExpected.label}).`);
    if (historyEmojiPx !== historyExpected.emojiPx) failures.push(`history/waiting: emoji font-size is ${historyState.emoji?.fontSize}, expected ${historyExpected.emojiPx}px (${historyExpected.label}).`);
    if (historyState.message?.color !== resolvedForeground) failures.push(`history/waiting: message colour is ${historyState.message?.color}, expected --foreground ${resolvedForeground}.`);
    await cdp.screenshot(path.join(SHOTS_DIR, '03-history-dimmed.png'));

    await setStartProgress(cdp, sessionAId, undefined);
    await cdp.waitFor(`!${GROUP}`, { timeoutMs: 10_000, label: 'notice unmounted (Session with history)' });
    const clearedOpacity = await cdp.evaluate(`(() => { const r = ${REGIONS}[0]; return r ? Number(getComputedStyle(r).opacity) : null; })()`);
    const clearedPointerEvents = await cdp.evaluate(`(() => { const r = ${REGIONS}[0]; return r ? getComputedStyle(r).pointerEvents : null; })()`);
    if (clearedOpacity === null || clearedOpacity < 0.95) failures.push(`history/cleared: transcript region opacity is ${clearedOpacity}, expected ~1 after startProgress cleared.`);
    else findings.push('history/cleared: transcript region opacity returned to ~1 once startProgress cleared.');
    if (clearedPointerEvents === 'none') failures.push('history/cleared: transcript region is still pointer-events:none after startProgress cleared.');
    else findings.push('history/cleared: transcript region is interactive again once startProgress cleared.');
    await cdp.screenshot(path.join(SHOTS_DIR, '04-history-cleared.png'));

    // ---- (3) Split pane: a real second Session, real openInSplit, measured narrower width ----
    await cdp.click(`document.querySelector('[data-quick-create-session]')`);
    await cdp.waitFor(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`, {
      timeoutMs: 30_000,
      label: 'Session B created, fake agent attached, composer enabled'
    });
    await cdp.evaluate(`window.__refractStores.split.getState().openInSplit(${JSON.stringify(sessionAId)}); true`);
    await cdp.waitFor(`${REGIONS}.length === 2`, { timeoutMs: 15_000, label: 'Split open: two Transcript regions rendered' });
    await setStartProgress(cdp, sessionAId, { kind: 'waiting', elapsedMs: 0 });
    await cdp.waitFor(`!!${GROUP}`, { timeoutMs: 10_000, label: 'notice mounted in the split pane' });
    const splitState = await readNoticeState(cdp);
    assertCentred(splitState, 'split/waiting', failures);
    if (splitState.regionFound && wideRegionWidth !== null) {
      if (!(splitState.regionRect.width < wideRegionWidth)) {
        failures.push(`split/waiting: split pane width (${splitState.regionRect.width.toFixed(0)}px) is not narrower than the single-pane width (${wideRegionWidth.toFixed(0)}px) -- the split did not actually narrow this pane.`);
      } else {
        findings.push(`split/waiting: split pane measured ${splitState.regionRect.width.toFixed(0)}px wide, narrower than the single-pane ${wideRegionWidth.toFixed(0)}px, as expected.`);
      }
    }
    const splitExpected = expectedSizesForWidth(splitState.regionFound ? splitState.regionRect.width : 9999);
    const splitMessagePx = fontSizePx(splitState.message?.fontSize);
    const splitEmojiPx = fontSizePx(splitState.emoji?.fontSize);
    if (splitMessagePx !== splitExpected.messagePx) failures.push(`split/waiting: message font-size is ${splitState.message?.fontSize} at a measured width of ${splitState.regionFound ? splitState.regionRect.width : 'unknown'}, expected ${splitExpected.messagePx}px (${splitExpected.label}).`);
    else findings.push(`split/waiting: message font-size ${splitMessagePx}px matches ${splitExpected.label} for the measured split-pane width ${splitState.regionFound ? splitState.regionRect.width.toFixed(0) : 'unknown'}px.`);
    if (splitEmojiPx !== splitExpected.emojiPx) failures.push(`split/waiting: emoji font-size is ${splitState.emoji?.fontSize}, expected ${splitExpected.emojiPx}px (${splitExpected.label}).`);
    await cdp.screenshot(path.join(SHOTS_DIR, '05-split-pane.png'));

    // ---- (4) Reduced motion: the emoji's bob collapses to (near-)zero duration ----
    const normalDurationMs = animationDurationMs(splitState.emoji?.animationDuration);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(200);
    const reducedState = await readNoticeState(cdp);
    const reducedDurationMs = animationDurationMs(reducedState.emoji?.animationDuration);
    if (normalDurationMs !== null && normalDurationMs <= 1) notExercised.push(`Normal (non-reduced-motion) emoji animation-duration was already ${splitState.emoji?.animationDuration} -- could not confirm reduced-motion actually changed anything.`);
    if (reducedDurationMs === null || reducedDurationMs > 1) failures.push(`With prefers-reduced-motion:reduce, emoji animation-duration is ${reducedState.emoji?.animationDuration} (${reducedDurationMs}ms), expected <=1ms (collapsed by the global reduced-motion rule).`);
    else findings.push(`With prefers-reduced-motion:reduce, emoji animation-duration collapsed to ${reducedState.emoji?.animationDuration} (<=1ms), down from ${splitState.emoji?.animationDuration} normally.`);
    await cdp.screenshot(path.join(SHOTS_DIR, '06-reduced-motion.png'));
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });

    // ---- (6) Theme screenshots (Dark already captured above in every shot) ----
    for (const theme of THEMES) {
      const result = await cdp.evaluate(`window.refract.theme.set(${JSON.stringify(theme.id)}).then((r) => r.ok)`);
      if (result !== true) {
        notExercised.push(`theme.set(${theme.id}) did not return ok -- ${theme.name} screenshot skipped.`);
        continue;
      }
      await cdp.waitFor(`document.documentElement.classList.contains(${JSON.stringify(`theme-${theme.id}`)})`, { timeoutMs: 10_000, label: `${theme.name} theme applied` });
      await cdp.screenshot(path.join(SHOTS_DIR, `07-theme-${theme.id}.png`));
      findings.push(`${theme.name} theme screenshot captured with the notice visible (split pane, waiting stage).`);
    }
    await cdp.evaluate(`window.refract.theme.set('dark')`);
    await setStartProgress(cdp, sessionAId, undefined);

    notExercised.push('A genuinely short (600px tall) native window was not driven: this harness has no confirmed native window-resize API over this WebView2 CDP endpoint.');

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
