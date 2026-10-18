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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LOG = 'verify-672';
const SHOTS_DIR =
  process.env.REFRACT_672_SHOTS_DIR || path.join(tmpdir(), 'refract-672-start-message-shots', new Date().toISOString().replace(/[:.]/g, '-'));

const GROUP = `document.querySelector('[aria-label="Agent start"]')`;
const REGIONS = `document.querySelectorAll('[aria-label="Transcript"]')`;
const REGION0 = `${REGIONS}[0]`;
const ANNOUNCE = `document.querySelector('[data-start-announcement]')`;
const OVERLAY = `document.querySelector('[data-start-overlay]')`;

// `dark` is the app's own default (asserted implicitly by every earlier screenshot); the other
// two are driven explicitly.
const THEMES = [
  { id: 'dark', name: 'Dark' },
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

// WCAG relative-luminance/contrast-ratio math (same formula `theme-contrast-pairs.mjs` uses),
// applied here to the gate-round-1 panel: `bg-background/90` composited over whatever sits
// behind it reads very close to solid `--background` (blending X at 90% over anything pulls the
// result strongly toward X), so resolving `--background` itself is a defensible, conservative
// stand-in for "the panel's own effective background colour" without a pixel-level compositing
// read this harness cannot do.
function srgbToLinear(c) {
  const cs = c / 255;
  return cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}
function relativeLuminance([r, g, b]) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
function parseRgb(rgbString) {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(rgbString ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function contrastRatio(fg, bg) {
  const rgbFg = parseRgb(fg), rgbBg = parseRgb(bg);
  if (!rgbFg || !rgbBg) return null;
  const lFg = relativeLuminance(rgbFg), lBg = relativeLuminance(rgbBg);
  const lighter = Math.max(lFg, lBg), darker = Math.min(lFg, lBg);
  return (lighter + 0.05) / (darker + 0.05);
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

/** Gate-fix (UI round 1): polls the computed opacity of `${REGION0}` until `predicate` is true or
 *  `timeoutMs` elapses, rather than a single read right after the mount `waitFor` -- a real
 *  settle may lag the mount by a frame even with the transition removed. */
async function waitForRegionOpacity(cdp, predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(`(() => { const r = ${REGION0}; return r ? Number(getComputedStyle(r).opacity) : null; })()`);
    if (last !== null && predicate(last)) return { value: last, ok: true };
    await sleep(100);
  }
  return { value: last, ok: false };
}

/** Gate-fix (UI round 1, items 9/12): forces a real layout change via CDP's `Emulation` domain
 *  (confirmed usable over this WebView2 CDP endpoint by several earlier verify-5xx scripts) so a
 *  size-dependent check is never skipped just because this run's own window happened to land in
 *  the other regime. Always clears the override afterward, even if `fn` throws. */
async function withDeviceMetrics(cdp, width, height, fn) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false });
  await sleep(300);
  try {
    return await fn();
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(300);
  }
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
    return {
      present: true,
      regionFound: true,
      groupRect: { x: groupRect.x, y: groupRect.y, width: groupRect.width, height: groupRect.height },
      regionRect: { x: regionRect.x, y: regionRect.y, width: regionRect.width, height: regionRect.height },
      buttonTexts,
      emoji: styleOf(group.querySelector('[data-start-emoji]')),
      message: styleOf(group.querySelector('[data-start-message]')),
      counter: styleOf(group.querySelector('[data-start-counter]')),
      guidance: styleOf(group.querySelector('[data-start-guidance]')),
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

/** Asserts `message`/`counter` sizing and colour against `expectedSizesForWidth(widthPx)` --
 *  shared by the brand-new, history and split checks so the three read identically. */
function assertSizesAndColours(state, widthPx, label, resolvedForeground, resolvedMuted, failures, findings) {
  const expected = expectedSizesForWidth(widthPx);
  const emojiPx = fontSizePx(state.emoji?.fontSize);
  const messagePx = fontSizePx(state.message?.fontSize);
  if (emojiPx !== expected.emojiPx) failures.push(`${label}: emoji font-size is ${state.emoji?.fontSize}, expected ${expected.emojiPx}px (${expected.label}, measured width ${widthPx}px).`);
  else findings.push(`${label}: emoji font-size ${emojiPx}px matches ${expected.label}.`);
  if (messagePx !== expected.messagePx) failures.push(`${label}: message font-size is ${state.message?.fontSize}, expected ${expected.messagePx}px (${expected.label}, measured width ${widthPx}px).`);
  else findings.push(`${label}: message font-size ${messagePx}px matches ${expected.label}.`);
  if (state.message?.color !== resolvedForeground) failures.push(`${label}: message colour is ${state.message?.color}, expected --foreground ${resolvedForeground} (not muted).`);
  else findings.push(`${label}: message colour matches --foreground exactly (not muted).`);
  if (!state.counter) failures.push(`${label}: [data-start-counter] is missing (expected the elapsed-seconds counter).`);
  else {
    const counterPx = fontSizePx(state.counter.fontSize);
    if (counterPx !== 12) failures.push(`${label}: seconds counter font-size is ${state.counter.fontSize}, expected 12px (text-xs).`);
    else findings.push(`${label}: seconds counter font-size 12px (text-xs), as specified.`);
    if (state.counter.color !== resolvedMuted) failures.push(`${label}: seconds counter colour is ${state.counter.color}, expected --muted-foreground ${resolvedMuted}.`);
    else findings.push(`${label}: seconds counter colour matches --muted-foreground.`);
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

    // Gate-fix (UI round 1, item 7): the dimmed history must stay genuinely scrollable (a real
    // wheel event) and restore full opacity on focus -- forced scrollable via a short viewport
    // override so this is never a silent no-op against a transcript too short to scroll anyway.
    await withDeviceMetrics(cdp, 900, 260, async () => {
      await cdp.waitFor(`!!${GROUP}`, { timeoutMs: 10_000, label: 'notice still mounted after short-viewport override' });
      const rect = await cdp.evaluate(`(() => { const r = ${REGION0}; if (!r) return null; const rr = r.getBoundingClientRect(); return { x: rr.x + rr.width / 2, y: rr.y + rr.height / 2 }; })()`);
      if (!rect) {
        failures.push('history/wheel: no Transcript region found to dispatch a wheel event at.');
        return;
      }
      const before = await cdp.evaluate(`${REGION0}?.scrollTop ?? null`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY: 150 });
      await sleep(200);
      const after = await cdp.evaluate(`${REGION0}?.scrollTop ?? null`);
      if (before === null || after === null || before === after) {
        failures.push(`history/wheel: a wheel over the dimmed history did not change scrollTop (${before} -> ${after}) -- it must stay scrollable while dimmed (gate-fix UI round 1).`);
      } else {
        findings.push(`history/wheel: a wheel over the dimmed history scrolled it (scrollTop ${before} -> ${after}), confirming it stays interactive while dimmed.`);
      }
      await cdp.evaluate(`${REGION0}?.focus()`);
      const focusedOpacity = await waitForRegionOpacity(cdp, (v) => v > 0.95, 2_000);
      if (!focusedOpacity.ok) failures.push(`history/focus: focusing the dimmed transcript region did not restore full opacity (settled at ${focusedOpacity.value}) -- focus-within:opacity-100 regressed.`);
      else findings.push(`history/focus: focusing the dimmed transcript region restored full opacity (${focusedOpacity.value}), as specified.`);
      await cdp.evaluate(`${REGION0}?.blur()`);
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
    // `prompt` stage (not `waiting`) so the guidance text and buttons exist alongside the joke,
    // and the panel-backed contrast (message/counter/guidance over the `bg-background/90` panel,
    // gate round 1 item 2) is asserted in every theme, not only screenshotted ----
    await setStartProgress(cdp, sessionAId, { kind: 'prompt', elapsedMs: 20_000 });
    await cdp.waitFor(`!!document.querySelector('[data-start-guidance]')`, { timeoutMs: 10_000, label: 'prompt-stage notice (guidance text) mounted for the theme loop' });
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
      const panelBg = await resolveCssVarColor(cdp, '--background', 'background-color');
      const pairs = [
        ['message', themeState.message?.color],
        ['counter', themeState.counter?.color],
        ['guidance', themeState.guidance?.color]
      ];
      for (const [name, colour] of pairs) {
        const ratio = contrastRatio(colour, panelBg);
        if (ratio === null) failures.push(`${theme.name}: could not compute a contrast ratio for ${name} (${colour}) over the panel background (${panelBg}).`);
        else if (ratio < 4.5) failures.push(`${theme.name}: ${name} colour ${colour} over the panel background ${panelBg} contrasts ${ratio.toFixed(2)}:1, expected >=4.5:1.`);
        else findings.push(`${theme.name}: ${name} colour contrasts ${ratio.toFixed(2)}:1 over the panel background, >=4.5:1.`);
      }
    }
    await cdp.evaluate(`window.refract.theme.set('dark')`);

    // ---- A genuinely short (600px tall) window: Keep waiting/Cancel reachable, forced via
    // Emulation.setDeviceMetricsOverride (gate-fix UI round 1, item 12: never silently skip) ----
    await withDeviceMetrics(cdp, 900, 600, async () => {
      await cdp.waitFor(`!!${GROUP}`, { timeoutMs: 10_000, label: 'notice still mounted in the 600px-tall window' });
      await cdp.evaluate(`(() => { const el = ${OVERLAY}; if (el) el.scrollTop = el.scrollHeight; return true; })()`);
      await sleep(150);
      const buttonRects = await cdp.evaluate(`(() => {
        const group = ${GROUP};
        if (!group) return [];
        return Array.from(group.querySelectorAll('button')).map((b) => { const r = b.getBoundingClientRect(); return { text: b.textContent.trim(), x: r.x, y: r.y, width: r.width, height: r.height }; });
      })()`);
      if (buttonRects.length === 0) failures.push('short-window: no buttons found in the Agent start group at the prompt stage (expected Keep waiting and Cancel).');
      for (const b of buttonRects) {
        const within = b.y >= 0 && b.y + b.height <= 600 && b.x >= 0 && b.x + b.width <= 900;
        if (within) findings.push(`short-window: "${b.text}" button reaches inside the 600px-tall viewport (y ${b.y.toFixed(0)}..${(b.y + b.height).toFixed(0)}) after scrolling the overlay to its end.`);
        else failures.push(`short-window: "${b.text}" button is not reachable inside the 600px-tall viewport even after scrolling the overlay to its end (rect y ${b.y.toFixed(0)}..${(b.y + b.height).toFixed(0)}, x ${b.x.toFixed(0)}..${(b.x + b.width).toFixed(0)}).`);
      }
      await cdp.screenshot(path.join(SHOTS_DIR, '08-short-window-prompt.png'));
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
