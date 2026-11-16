// Shared constants and CDP helpers for `verify-672-start-message.mjs` (#806 file-size split).
// `setupLaunch`/`teardownLaunch`/`quickCreateSessionId` also own process lifecycle.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CdpSession, getFreePort, waitForCdpTarget, isTargetOwningPort, stopLauncher, launchViaJobObject } from './verify-tauri-cdp.mjs';
import { makeScratchRepo, safeRmSync, buildAndCopyExeFresh, sha256OfFile } from './verify-tauri-scratch-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const GROUP = `document.querySelector('[aria-label="Agent start"]')`;
export const REGIONS = `document.querySelectorAll('[aria-label="Transcript"]')`;
export const REGION0 = `${REGIONS}[0]`;
export const ANNOUNCE = `document.querySelector('[data-start-announcement]')`;
export const OVERLAY = `document.querySelector('[data-start-overlay]')`;

// `dark` is the app default; the other two are driven explicitly.
export const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' }
];

// Button groups per kind (`isJokeStage` in SessionStartNotice.tsx): `waiting` offers no decision yet.
export const PROMPT_STAGE_BUTTONS = ['Keep waiting', 'Cancel'];

// Mirrors SessionStartNotice.tsx's `@min-[40rem]` breakpoint (compact below 640px, large at/above) so drift shows as a mismatch.
export const NARROW_BREAKPOINT_PX = 640;
export function expectedSizesForWidth(widthPx) {
  return widthPx >= NARROW_BREAKPOINT_PX
    ? { messagePx: 24, emojiPx: 48, label: 'wide (text-2xl/text-5xl)' }
    : { messagePx: 20, emojiPx: 40, label: 'narrow (text-xl/text-[40px])' };
}

export function fontSizePx(cssFontSize) {
  const match = /^([\d.]+)px$/.exec(cssFontSize ?? '');
  return match ? Number(match[1]) : null;
}

/** Accepts decimal or exponential ("1e-05s") `animation-duration`: Chromium can serialise a collapsed
 *  reduced-motion duration in exponential form. */
export function animationDurationMs(cssDuration) {
  const match = /^(-?\d*\.?\d+(?:[eE][+-]?\d+)?)(m?s)$/.exec(cssDuration ?? '');
  if (!match) return null;
  return match[2] === 'ms' ? Number(match[1]) : Number(match[1]) * 1000;
}

// WCAG relative-luminance/contrast-ratio math (same formula `theme-contrast-pairs.mjs` uses).
function srgbToLinear(c) {
  const cs = c / 255;
  return cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}
function relativeLuminance([r, g, b]) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
// This WebView2 serialises oklch()-sourced computed colours as oklab(...), never rgb(); same OKLab matrices as check-theme-contrast.mjs.
function oklabToLinearSrgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b, m_ = L - 0.1055613458 * a - 0.0638541728 * b, s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
}
function linearToSrgb255(c) {
  const clamped = Math.min(1, Math.max(0, c));
  return Math.round((clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055) * 255);
}
const OKLCH_RE = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)(%)?)?\s*\)$/i;
const OKLAB_RE = /^oklab\(\s*([\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s*\/\s*([\d.]+)(%)?)?\s*\)$/i;
function parseOklabLike(str) {
  const s = (str ?? '').trim(), lch = OKLCH_RE.exec(s), lab = lch ? null : OKLAB_RE.exec(s);
  if (!lch && !lab) return null;
  const [, lStr, p2, p3, al, pct] = lch ?? lab, hRad = lch ? (Number(p3) * Math.PI) / 180 : 0;
  const a = lch ? Number(p2) * Math.cos(hRad) : Number(p2), b = lch ? Number(p2) * Math.sin(hRad) : Number(p3);
  const [r, g, bl] = oklabToLinearSrgb(Number(lStr), a, b).map(linearToSrgb255);
  return { r, g, b: bl, a: al === undefined ? 1 : pct ? Number(al) / 100 : Number(al) };
}
// Parses alpha too; falls back to `parseOklabLike` since this WebView2 never returns these tokens as `rgb()`.
export function parseRgba(colorString) {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(colorString ?? '');
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] !== undefined ? Number(m[4]) : 1 };
  return parseOklabLike(colorString);
}
export function contrastRatio(fg, bg) {
  const rgbFg = parseRgba(fg), rgbBg = parseRgba(bg);
  if (!rgbFg || !rgbBg) return null;
  const lFg = relativeLuminance([rgbFg.r, rgbFg.g, rgbFg.b]), lBg = relativeLuminance([rgbBg.r, rgbBg.g, rgbBg.b]);
  const lighter = Math.max(lFg, lBg), darker = Math.min(lFg, lBg);
  return (lighter + 0.05) / (darker + 0.05);
}
/** Source-over alpha compositing of `fg` (with alpha) on an opaque `bg`. */
export function blendOver(fg, bg) {
  return { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
}
export function rgbToCss({ r, g, b }) {
  return `rgb(${r}, ${g}, ${b})`;
}
/** A real Tab press (not `.focus()`) so focus uses the browser's sequential navigation. CDP Shift = 8. */
export async function dispatchTab(cdp, { shift = false } = {}) {
  const modifiers = shift ? 8 : 0;
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab', modifiers });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab', modifiers });
}

/** Focuses the region's LAST tabbable descendant (or the region), since the region's own focus
 *  stop doesn't guarantee the next Tab exits it; the next Tab then lands on the overlay's first button. */
export async function focusLastTabbableOrSelf(cdp, regionExpr) {
  return cdp.evaluate(`(() => {
    const region = ${regionExpr};
    if (!region) return false;
    const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const candidates = Array.from(region.querySelectorAll(selector));
    (candidates[candidates.length - 1] || region).focus();
    return true;
  })()`);
}

/** Classifies the mounted notice into a `startProgress.kind` from the DOM. Reads the DOM, not
 *  `sessions.list()`, because the user-visible render path (`SessionStartNotice.tsx`) is what's
 *  under test. Assumes only ONE Session's notice is mounted (no split mode). */
export async function readVisibleStartKind(cdp) {
  return cdp.evaluate(`(() => {
    const group = ${GROUP};
    if (!group) return { kind: undefined };
    const buttons = Array.from(group.querySelectorAll('button')).map((b) => b.textContent.trim());
    const counterEl = group.querySelector('[data-start-counter]');
    const counterMatch = counterEl ? counterEl.textContent.match(/\\d+/) : null;
    const elapsedMs = counterMatch ? Number(counterMatch[0]) * 1000 : null;
    if (group.querySelector('[data-start-message]')) {
      if (buttons.includes('Keep waiting')) return { kind: 'prompt', elapsedMs };
      if (buttons.includes('Cancel')) return { kind: 'extended', elapsedMs };
      return { kind: 'waiting', elapsedMs };
    }
    const plainEl = group.querySelector('[data-start-plain-text]');
    if (plainEl) {
      const text = plainEl.textContent;
      if (text === 'Waiting to start…') return { kind: 'queued' };
      if (text === 'Starting agent… waiting for memory to free up') return { kind: 'memory-deferred' };
      return { kind: 'unknown-plain', text };
    }
    return { kind: 'mounting' }; // group exists but neither path has rendered its own content yet (one frame, at most)
  })()`);
}

/** Polls the real `startProgress.kind` via `readVisibleStartKind` until it matches, or throws with the
 *  last value. Waits for `sessionId`'s row to be `aria-current` so a notice on another pane isn't misread. */
export async function waitForStartProgressKind(cdp, sessionId, kind, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const focused = await cdp.evaluate(`document.querySelector('[data-session-open=${JSON.stringify(sessionId)}]')?.getAttribute('aria-current') === 'true'`);
    if (focused) {
      last = await readVisibleStartKind(cdp);
      if (last?.kind === kind) return last;
    } else {
      last = { kind: undefined, note: 'Session row is not yet the focused pane (aria-current)' };
    }
    await sleep(150);
  }
  throw new Error(`waitForStartProgressKind(${sessionId}, ${kind}): timed out after ${timeoutMs}ms, last read was ${JSON.stringify(last)}`);
}

/** Classifies a `waitForStartProgressKind` timeout as the known #985 absence (last read had no
 *  `kind`) versus a real failure; callers downgrade only the former to `notExercised`. */
export function parseWaitTimeoutAbsence(err) {
  const lastReadMatch = /last read was (.+)$/.exec(err?.message ?? '');
  let lastRead;
  try { lastRead = lastReadMatch ? JSON.parse(lastReadMatch[1]) : undefined; } catch { lastRead = undefined; }
  const isKnownAbsence = /^waitForStartProgressKind\(/.test(err?.message ?? '') && lastRead !== undefined && !('kind' in lastRead);
  return { isKnownAbsence, lastRead };
}

/** True when the DOM shows no `kind` and the composer is enabled: startProgress resolved away (#985),
 *  not a stale read. Best-effort: sub-read failures become `null`/`false` so callers in error
 *  handling never see a second exception. */
export async function classifyPossibleAbsence(cdp) {
  const classifierRead = await readVisibleStartKind(cdp).catch(() => null);
  const composerEnabledNow = await cdp
    .evaluate(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`)
    .catch(() => null);
  return { isKnownAbsence: classifierRead?.kind === undefined && composerEnabledNow === true, classifierRead, composerEnabledNow };
}

/** Scrolls a Session row into view and confirms via `elementFromPoint` that the click point hits it:
 *  a bare rect can be stale after the list scrolls, sending the click elsewhere silently. */
async function clickSessionRowCore(cdp, sessionId, modifiers, label) {
  const rect = await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-session-open=${JSON.stringify(sessionId)}]');
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hitsSelf: hit === el || (!!hit && el.contains(hit)) };
  })()`);
  if (!rect) throw new Error(`${label}(${sessionId}): no [data-session-open] row found.`);
  if (!rect.hitsSelf) throw new Error(`${label}(${sessionId}): elementFromPoint at (${rect.x}, ${rect.y}) after scrollIntoView did not hit the row -- something else is covering it.`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1, modifiers });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1, modifiers });
}

/** Real Ctrl+click (CDP Ctrl = 2) so `onClick`'s `ctrlKey` branch calls the real `openInSplit`. */
export async function ctrlClickSessionRow(cdp, sessionId) {
  return clickSessionRowCore(cdp, sessionId, 2, 'ctrlClickSessionRow');
}

/** Real plain click, taking `onClick`'s `replaceFocused(session.id)` branch to re-focus a Session. */
export async function clickSessionRow(cdp, sessionId) {
  return clickSessionRowCore(cdp, sessionId, 0, 'clickSessionRow');
}

/** `stopAgent` + `recover` round trip that re-enters the real start-queue flow on a Session that
 *  already has history. History survives because `sync_from_state.rs` only patches
 *  `current_conversation` when `message_count > 0`. `recover()` is NOT awaited: its promise
 *  settles only after the whole 60-180s start, overrunning the CDP timeout and missing the live
 *  transition `waitForStartProgressKind` polls for; this returns once the call is dispatched. */
export async function restartAgent(cdp, sessionId) {
  const stopped = await cdp.evaluate(`window.refract.sessions.stopAgent(${JSON.stringify(sessionId)})`);
  if (!stopped?.ok) throw new Error(`restartAgent(${sessionId}): stopAgent failed: ${JSON.stringify(stopped)}`);
  // `stopAgent()` can resolve a tick before the registry status reads 'stopped'; recovering
  // early silently rejects a precondition, so poll `sessions.list()` status first.
  await cdp.waitFor(
    `window.refract.sessions.list().then((r) => r.ok && r.value.find((s) => s.id === ${JSON.stringify(sessionId)})?.status === 'stopped')`,
    { timeoutMs: 10_000, label: `restartAgent(${sessionId}): status reads 'stopped' before recover()` }
  );
  await cdp.evaluate(`(() => {
    window.__672RecoverResult = window.refract.sessions.recover(${JSON.stringify(sessionId)});
    return true;
  })()`);
}

/** Polls computed opacity of an arbitrary selector: the overlay's `transition-opacity` can leave a single read mid-fade. */
export async function waitForComputedOpacity(cdp, selectorExpr, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(`(() => { const el = ${selectorExpr}; return el ? Number(getComputedStyle(el).opacity) : null; })()`);
    if (last !== null && predicate(last)) return { value: last, ok: true };
    await sleep(50);
  }
  return { value: last, ok: false };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `${REGION0}` opacity until `predicate` holds; a settle can lag the mount by a frame. */
export async function waitForRegionOpacity(cdp, predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(`(() => { const r = ${REGION0}; return r ? Number(getComputedStyle(r).opacity) : null; })()`);
    if (last !== null && predicate(last)) return { value: last, ok: true };
    await sleep(100);
  }
  return { value: last, ok: false };
}

/** Polls the `${REGION0}` blur radius in px (0 when no blur filter); the 150ms filter transition can leave a single read mid-way. */
export async function waitForRegionBlur(cdp, predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(`(() => { const r = ${REGION0}; if (!r) return null; const m = /blur\\(([\\d.]+)px\\)/.exec(getComputedStyle(r).filter); return m ? Number(m[1]) : 0; })()`);
    if (last !== null && predicate(last)) return { value: last, ok: true };
    await sleep(100);
  }
  return { value: last, ok: false };
}

/** Forces a layout size via CDP `Emulation` so a size-dependent check never skips for the window's
 *  default regime. Always clears the override, even if `fn` throws. */
export async function withDeviceMetrics(cdp, width, height, fn) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false });
  // The override applies at once but reflow (container queries, flex wrap) lags; poll
  // `clientWidth`/`clientHeight` first, then keep the settle sleep for viewport-dependent layout.
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const settled = await cdp.evaluate(`document.documentElement.clientWidth === ${width} && document.documentElement.clientHeight === ${height}`);
    if (settled) break;
    await sleep(50);
  }
  await sleep(300);
  try {
    return await fn();
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(300);
  }
}

/** Reads the notice's geometry/styles plus the Transcript region containing it, found by rect overlap (pane-index independent). */
export async function readNoticeState(cdp) {
  return cdp.evaluate(`(() => {
    const group = ${GROUP};
    if (!group) return { present: false };
    const groupRect = group.getBoundingClientRect();
    // Gate-fix: overlap, not centre-containment -- an overflowing notice (\`items-center-safe\` pins it to the region's own top) can have its centre fall outside the region even though it's genuinely that region's own notice.
    const region = Array.from(${REGIONS}).find((r) => {
      const rr = r.getBoundingClientRect();
      return rr.x < groupRect.x + groupRect.width && rr.x + rr.width > groupRect.x && rr.y < groupRect.y + groupRect.height && rr.y + rr.height > groupRect.y;
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
      regionOpacity: Number(getComputedStyle(region).opacity),
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

export function assertCentred(state, label, failures) {
  if (!state.regionFound) {
    failures.push(`${label}: notice rendered but no owning Transcript region was found (geometry check skipped).`);
    return;
  }
  const g = state.groupRect, r = state.regionRect;
  const gcx = g.x + g.width / 2, gcy = g.y + g.height / 2, rcx = r.x + r.width / 2, rcy = r.y + r.height / 2;
  const tolX = Math.max(24, r.width * 0.08), tolY = Math.max(24, r.height * 0.08);
  if (Math.abs(gcx - rcx) > tolX) failures.push(`${label}: notice is not horizontally centred (cx ${gcx.toFixed(1)} vs region ${rcx.toFixed(1)}, tolerance ${tolX.toFixed(0)}).`);
  // `items-center-safe` (Transcript.tsx) pins overflowing content to the top, so only assert vertical centring when the notice fits.
  if (g.height <= r.height && Math.abs(gcy - rcy) > tolY) failures.push(`${label}: notice is not vertically centred (cy ${gcy.toFixed(1)} vs region ${rcy.toFixed(1)}, tolerance ${tolY.toFixed(0)}).`);
}

/** Asserts message/counter sizing and colour against `expectedSizesForWidth(widthPx)`. */
export function assertSizesAndColours(state, widthPx, label, resolvedForeground, resolvedMuted, failures, findings) {
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
/** `REFRACT_672_REUSE_EXE`: if set, hashes and reuses that exe instead of a fresh `tauri build --debug`.
 *  The caller must confirm it matches the head under test; this only hashes it. */
export function resolveExePath(exeDir, buildOutputDir, repoRoot, label) {
  const reuseExe = process.env.REFRACT_672_REUSE_EXE;
  if (reuseExe) {
    if (!existsSync(reuseExe)) throw new Error(`${label}: REFRACT_672_REUSE_EXE=${reuseExe} does not exist.`);
    const hash = sha256OfFile(reuseExe);
    console.log(`${label}: reusing existing exe at ${reuseExe} (sha256 ${hash.slice(0, 12)}…) -- no new build (REFRACT_672_REUSE_EXE set).`);
    return { dest: reuseExe, hash };
  }
  return buildAndCopyExeFresh(exeDir, buildOutputDir, repoRoot, { label });
}
/** One scratch Tauri launch, readiness screen through "scratch repository added"; session choreography is the caller's. */
export async function setupLaunch(exePath, launcherExe, launchLabel, extraEnv, pathPrepend) {
  // The `try` covers every mkdtemp and the launch so a throw can't leak what was already created;
  // the `catch` only cleans up variables that were actually set.
  let dataDir, importSourceDir, repoDir, launchDir, child;
  let cdp;
  try {
    dataDir = mkdtempSync(path.join(tmpdir(), `refract-672-${launchLabel}-data-`));
    importSourceDir = mkdtempSync(path.join(tmpdir(), `refract-672-${launchLabel}-import-`));
    repoDir = makeScratchRepo(mkdtempSync(path.join(tmpdir(), `refract-672-${launchLabel}-repo-`)), `verify-672-start-message-${launchLabel}`);
    launchDir = mkdtempSync(path.join(tmpdir(), `refract-672-${launchLabel}-launch-`));
    writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, approvalMode: 'auto' }));
    const webview2DataDir = path.join(launchDir, 'webview2-data');
    mkdirSync(webview2DataDir, { recursive: true });
    const pidFile = path.join(launchDir, 'target.pid');
    const port = await getFreePort();
    const env = {
      ...process.env,
      ...extraEnv,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: webview2DataDir,
      REFRACT_DATA_DIR: dataDir,
      REFRACT_IMPORT_SOURCE_DIR: importSourceDir,
      REFRACT_FAKE_OMP_SCRIPT: path.join(__dirname, 'verify-tauri-fake-omp.mjs'),
      REFRACT_FAKE_OMP_NODE: process.execPath,
      REFRACT_FAKE_OMP_DEBUG_LOG: extraEnv.REFRACT_FAKE_OMP_DEBUG_LOG ?? path.join(launchDir, 'fake-omp-invocations.log')
    };
    if (pathPrepend) env.PATH = `${pathPrepend};${process.env.PATH}`;
    const launched = await launchViaJobObject(launcherExe, pidFile, exePath, [], { cwd: launchDir, env });
    child = launched.child;
    const targetPid = launched.targetPid;

    const wsUrl = await waitForCdpTarget(port, { timeoutMs: 60_000 });
    cdp = await CdpSession.connect(wsUrl);
    if (!isTargetOwningPort(port, targetPid)) {
      throw new Error(`verify-672: CDP target on port ${port} (${launchLabel}) is not owned by the process this run launched (pid ${targetPid})`);
    }

    await cdp.waitFor(`!!document.querySelector('[data-readiness-primary]')`, { timeoutMs: 30_000, label: `${launchLabel}: Readiness screen mounted` });
    await cdp.waitFor(
      `(() => { const b = document.querySelector('[data-readiness-primary]'); return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; })()`,
      { timeoutMs: 30_000, label: `${launchLabel}: Readiness green (fake omp)` }
    );
    await cdp.openLocalFolderDialog();
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add project', { inDialog: true });
    await cdp.waitFor(`!!document.querySelector('[data-quick-create-session]')`, { timeoutMs: 30_000, label: `${launchLabel}: Scratch repository added, quick-create button visible` });

    // Confirm the fake-omp shim ran, not a real omp.exe from the system PATH (#985): its debug log's
    // first line (`pid=... argv=... cwd=...`) exists only if the shim was spawned.
    const debugLogPath = env.REFRACT_FAKE_OMP_DEBUG_LOG;
    if (!existsSync(debugLogPath)) {
      throw new Error(`${launchLabel}: fake-omp debug log ${debugLogPath} does not exist -- the real omp.exe was spawned instead of the shim (PATH shim missing or not prepended).`);
    }
    const debugLogFirstLine = readFileSync(debugLogPath, 'utf8').split('\n')[0];
    if (!debugLogFirstLine.startsWith('pid=')) {
      throw new Error(`${launchLabel}: fake-omp debug log ${debugLogPath} exists but its first line ("${debugLogFirstLine}") does not match the expected marker -- not confirmed as the shim.`);
    }
    console.log(`${launchLabel}: shim confirmed (${debugLogFirstLine})`);

    return { cdp, child, dataDir, importSourceDir, repoDir, launchDir };
  } catch (err) {
    if (cdp) cdp.close();
    if (child) await stopLauncher(child).catch(() => {});
    if (dataDir) await safeRmSync(dataDir);
    if (importSourceDir) await safeRmSync(importSourceDir);
    if (repoDir) await safeRmSync(repoDir);
    if (launchDir) await safeRmSync(launchDir);
    throw err;
  }
}

export async function teardownLaunch(launch) {
  if (!launch) return;
  if (launch.cdp) launch.cdp.close();
  if (launch.child) await stopLauncher(launch.child).catch(() => {});
  await safeRmSync(launch.dataDir);
  await safeRmSync(launch.importSourceDir);
  await safeRmSync(launch.repoDir);
  await safeRmSync(launch.launchDir);
}

/** Quick-creates a Session via the real UI button and returns `{id, name}` once it appears in
 *  `sessions.list()` (diff-based: a composer-enabled snapshot passes trivially when an earlier
 *  Session is already ready). Used to hold the start queue's 2 concurrent slots
 *  (`MAX_CONCURRENT_STARTS`, start_queue.rs:36) so a 3rd Session queues. */
export async function quickCreateSessionId(cdp, label) {
  const before = await cdp.evaluate(`window.refract.sessions.list().then((r) => r.ok ? r.value.map((s) => s.id) : [])`);
  await cdp.click(`document.querySelector('[data-quick-create-session]')`);
  const created = await cdp.waitFor(
    `window.refract.sessions.list().then((r) => { if (!r.ok) return null; const before = ${JSON.stringify(before)}; const found = r.value.find((s) => !before.includes(s.id)); return found ? { id: found.id, name: found.name } : null; })`,
    { timeoutMs: 10_000, label: `${label}: Session created (id visible in sessions.list())` }
  );
  if (!created) throw new Error(`${label}: could not identify the newly created Session id.`);
  // RepositoryGroup.tsx's quick-create guard silently no-ops a click before the previous create has
  // settled, and the list update isn't provably the same step. Wait for this row's
  // `aria-current="true"` (the last side effect of a create) before a caller clicks again.
  await cdp.waitFor(
    `document.querySelector('[data-session-open=${JSON.stringify(created.id)}]')?.getAttribute('aria-current') === 'true'`,
    { timeoutMs: 10_000, label: `${label}: Session's own row reports aria-current (focused, quick-create guard clear)` }
  );
  return created;
}

/** Shared `queued`/`memory-deferred` check: both render the same plain-text path, centred, not dimmed;
 *  `sessionId` ensures the notice read belongs to that Session, not a previously focused pane. */
export async function assertFocusedPlainStageNotice(cdp, { sessionId, kind, expectedText, muted, failures, findings, screenshotPath }) {
  const focused = await cdp.evaluate(`document.querySelector('[data-session-open=${JSON.stringify(sessionId)}]')?.getAttribute('aria-current') === 'true'`);
  if (!focused) failures.push(`${kind}: Session ${sessionId} is not the focused pane (aria-current) -- the notice asserted below may not actually be its own.`);
  else findings.push(`${kind}: Session ${sessionId} is confirmed the focused pane (aria-current) -- the notice asserted below is its own.`);
  await cdp.waitFor(`!!document.querySelector('[data-start-plain-text]')`, { timeoutMs: 10_000, label: `${kind}: plain-text notice mounted` });
  const state = await readNoticeState(cdp);
  assertCentred(state, kind, failures);
  const opacity = await waitForRegionOpacity(cdp, (v) => v > 0.95, 2_000);
  if (!opacity.ok) failures.push(`${kind}: transcript region opacity settled at ${opacity.value}, expected >0.95 (brand-new Session has nothing to dim).`);
  else findings.push(`${kind}: transcript region opacity settled at ${opacity.value} (not dimmed), as expected for a brand-new Session.`);
  const blur = await waitForRegionBlur(cdp, (v) => v === 0, 2_000);
  if (!blur.ok) failures.push(`${kind}: transcript region blur radius settled at ${blur.value}px, expected 0 (brand-new Session has no history to blur).`);
  else findings.push(`${kind}: transcript region blur radius settled at ${blur.value}px (not blurred), as expected for a brand-new Session.`);
  const text = await cdp.evaluate(`document.querySelector('[data-start-plain-text]')?.textContent ?? null`);
  if (text !== expectedText) failures.push(`${kind}: plain text reads "${text}", expected exactly "${expectedText}" (describeStartProgress).`);
  else findings.push(`${kind}: plain text reads exactly "${text}", as specified.`);
  const plainPx = fontSizePx(state.plain?.fontSize);
  if (plainPx !== 16) failures.push(`${kind}: plain text font-size is ${state.plain?.fontSize}, expected 16px (text-base).`);
  else findings.push(`${kind}: plain text font-size 16px (text-base), as specified.`);
  if (state.plain && state.plain.color !== muted) failures.push(`${kind}: plain text colour is ${state.plain.color}, expected --muted-foreground ${muted}.`);
  else findings.push(`${kind}: plain text colour matches --muted-foreground.`);
  if (!state.buttonTexts.includes('Cancel')) failures.push(`${kind}: no "Cancel" button found (group buttons: ${JSON.stringify(state.buttonTexts)}).`);
  else findings.push(`${kind}: "Cancel" button present, as specified.`);
  if (screenshotPath) await cdp.screenshot(screenshotPath);
}
