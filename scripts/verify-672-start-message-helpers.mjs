// Shared constants and pure/CDP helpers for `verify-672-start-message.mjs` (issue #672, #806 file-size
// split: extracted once the gate-round-2 rewrites pushed the main script past the 600-line soft cap).
// `setupLaunch`/`teardownLaunch`/`quickCreateSessionId` are the one exception to "nothing here owns process lifecycle" -- moved here for the same reason; they still own launch/cleanup exactly as before.
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

// `dark` is the app's own default (asserted implicitly by every earlier screenshot); the other
// two are driven explicitly.
export const THEMES = [
  { id: 'dark', name: 'Dark' },
  { id: 'obsidian', name: 'Obsidian' },
  { id: 'dark-high-contrast', name: 'Dark (high contrast)' }
];

// Button-text groups used to assert Keep waiting/Cancel reachability once each kind is reached
// for real (`isJokeStage`'s own grouping in SessionStartNotice.tsx): `prompt`/`extended` show
// both; `waiting` shows neither (no decision to make yet, nothing to cancel being offered).
export const PROMPT_STAGE_BUTTONS = ['Keep waiting', 'Cancel'];

// The sizing rule under test (SessionStartNotice.tsx's own `@min-[40rem]`): below 40rem (640px)
// of container width the compact sizes apply (`text-xl`/`text-[40px]`); at or above it the large
// sizes apply (`text-2xl`/`text-5xl`). Mirrors the component's own Tailwind classes so a drift in
// either place shows up as a mismatch here, not two independent hardcoded numbers.
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

/** Accepts CSS `animation-duration` in either plain decimal form ("2.4s") or the exponential
 *  notation a browser can report for a very small value ("1e-05s") -- WebView2/Chromium's own
 *  `getComputedStyle().animationDuration` serialisation is not guaranteed to avoid exponential
 *  form once a collapsed reduced-motion duration lands near zero, and the previous
 *  `[\d.]+`-only character class could not match the `e-05` part at all, so it returned `null`
 *  for a value that WAS correctly collapsed (a harness parsing gap, found live 2026-10-18:
 *  reported "1e-05s", 0.01ms, well under the <=1ms bar, but read as `null` and failed). */
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
// Gate-fix: this WebView2's Chromium serialises oklch()-sourced computed colours as oklab(...), never rgb() -- same OKLab matrices as check-theme-contrast.mjs (Bjorn Ottosson).
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
// Parses alpha too (plain `rgb()` has none); falls back to `parseOklabLike` (gate-fix above) -- this WebView2 never returns `--background`/`--foreground` as `rgb()`.
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
/** Plain "source over" alpha compositing (straight sRGB component blend, the same model CSS
 *  itself uses for a translucent layer over an opaque one): `fg` carries its own alpha, `bg` is
 *  treated as opaque. */
export function blendOver(fg, bg) {
  return { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
}
export function rgbToCss({ r, g, b }) {
  return `rgb(${r}, ${g}, ${b})`;
}
/** A real Tab key press (not a programmatic `.focus()`), so "Tab reaches Keep waiting/Cancel"
 *  exercises the browser's own sequential focus navigation, not just a DOM query. CDP modifier
 *  bitmask: Shift = 8. */
export async function dispatchTab(cdp, { shift = false } = {}) {
  const modifiers = shift ? 8 : 0;
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab', modifiers });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab', modifiers });
}

/** Gate round 3 item 2: a region can have real focusable descendants (tool rows, links) after
 *  its own `tabIndex=0` focus stop -- focusing the region itself does not guarantee the VERY
 *  NEXT Tab exits it. Focuses the LAST tabbable descendant instead (or the region itself if it
 *  has none), so the next real Tab is guaranteed to land on the overlay's own first button. */
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

/** Classifies the CURRENTLY MOUNTED notice (if any) into a `startProgress.kind` purely from the
 *  DOM. Gate-fix (confirmed live, bg_791/bg_794/bg_801 runs, then confirmed in code):
 *  `window.refract.sessions.list()` deliberately NEVER includes `startProgress` at all --
 *  `session/agent/mod.rs`'s own `insert_termination_and_progress_fields` doc comment says so in
 *  plain words: "`summary_fields` (registry-only `sessions.list` rows) deliberately does not
 *  call this: no live agent computes a crash's tail detection for a Session nobody has opened
 *  this run." `startProgress` is ONLY ever pushed via the live `session:status` event, which
 *  only updates the renderer's own in-memory store -- never fetched back out through this IPC
 *  method. Reading `sessions.list()` for it (the previous version of this file) could never
 *  succeed, regardless of how long it polled. The component renders faithfully from that same
 *  live store, so the DOM is the one reliable place this script can read it from without the
 *  dev-only `window.__refractStores` seam (the ORIGINAL bug this whole rewrite exists to avoid).
 *  Callers must ensure only ONE Session's own notice can be mounted at a time when calling this
 *  -- true for every caller here (split mode is never active while any of them run). */
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

/** Polls the REAL `startProgress.kind` (set by the Rust start-queue's own timers/IPC handlers,
 *  never written by this script), reading it via `readVisibleStartKind` (the DOM), until it
 *  matches `kind`, or throws with the last-seen value. Also confirms `sessionId`'s own row
 *  reports `aria-current` before trusting a read -- a mounted notice this script is not yet
 *  looking at the right pane for is treated as "not yet", not a false positive/negative. */
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

/** Classifies a `waitForStartProgressKind` timeout as the known #985 absence (last read
 *  genuinely had no `kind` at all -- `{}`/`{"note":...}`) versus any other, unexpected failure
 *  shape (a DEFINED other kind, or a message this was never thrown from) -- callers downgrade
 *  ONLY the former to `notExercised`, the latter is always a real failure. Shared by every
 *  caller that needs this distinction (`memory-deferred`'s own catch), so the parse logic lives
 *  in one place. */
export function parseWaitTimeoutAbsence(err) {
  const lastReadMatch = /last read was (.+)$/.exec(err?.message ?? '');
  let lastRead;
  try { lastRead = lastReadMatch ? JSON.parse(lastReadMatch[1]) : undefined; } catch { lastRead = undefined; }
  const isKnownAbsence = /^waitForStartProgressKind\(/.test(err?.message ?? '') && lastRead !== undefined && !('kind' in lastRead);
  return { isKnownAbsence, lastRead };
}

/** Classifies the CURRENT moment (not a thrown error) as the known #985 absence: the DOM
 *  classifier reports no `kind` at all AND the composer is already enabled -- the Session's own
 *  startProgress resolved away before this check ran, not a stale read. Shared by every
 *  post-`waiting`-confirmed check that can race this (the short-viewport dim check, the theme
 *  sweep, the wheel-probe). Best-effort: a failed sub-read becomes `null`/`false`, never throws
 *  itself, so a caller already inside error handling never faces a second exception. */
export async function classifyPossibleAbsence(cdp) {
  const classifierRead = await readVisibleStartKind(cdp).catch(() => null);
  const composerEnabledNow = await cdp
    .evaluate(`(() => { const el = document.querySelector('[aria-label="Message"]'); return !!el && !el.disabled; })()`)
    .catch(() => null);
  return { isKnownAbsence: classifierRead?.kind === undefined && composerEnabledNow === true, classifierRead, composerEnabledNow };
}

/** Shared by `ctrlClickSessionRow`/`clickSessionRow`: scrolls a Session row (`data-session-open`,
 *  SessionRow.tsx) into view and confirms (`elementFromPoint`) the computed click point
 *  genuinely hits it before dispatching -- a bare `getBoundingClientRect()` can be stale if the
 *  Session list scrolled since the row was last visible (gate-fix, confirmed live, bg_832/
 *  bg_840: the dispatched click then lands wherever that point now is, not the intended row,
 *  and whatever the click was supposed to do silently never happens). */
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

/** Real Ctrl+click (`Input.dispatchMouseEvent` modifiers bitmask: Ctrl = 2) on a Session row's
 *  own open button -- the exact modifier combination `onClick`'s own `event.ctrlKey` branch
 *  checks, which calls the real `openInSplit(session.id)` -- not a direct store call. */
export async function ctrlClickSessionRow(cdp, sessionId) {
  return clickSessionRowCore(cdp, sessionId, 2, 'ctrlClickSessionRow');
}

/** A real plain click (no modifier) on a Session row's own open button -- the exact production
 *  path `onClick`'s `replaceFocused(session.id)` branch takes (re-focusing a Session after
 *  something else, e.g. creating another Session, replaced it in the single pane). */
export async function clickSessionRow(cdp, sessionId) {
  return clickSessionRowCore(cdp, sessionId, 0, 'clickSessionRow');
}

/** A real `stopAgent` + `recover` round trip (`window.refract.sessions.*`, the same bridge
 *  methods ChatPane.tsx's own Stop/Retry buttons call) -- re-enters the REAL start-queue flow a
 *  second time on a Session that already has real history, so `waiting`/`prompt`/`extended` can
 *  be observed on a Session this script already proved `hasHistory` for. Safe against the
 *  restarted process's own fresh `get_state` reporting `messageCount:0` (every fixture's tape
 *  replays from its own line 1 on each new child process): `sync_from_state.rs` only ever
 *  PATCHES `current_conversation` when `message_count > 0`, never clears it, so the Session's
 *  real history persists across this restart untouched (confirmed by reading that guard, not
 *  assumed).
 *
 *  Gate-fix (HIGH, test delta on c5756d7): `recover()`'s own returned Promise does not settle
 *  until `agent.start()` fully finishes -- ready or failure (`sessions_agent.rs:404` ->
 *  `launch.rs:202`'s `wait_ready`). Awaiting it directly here used to block this whole function
 *  for the ENTIRE real start (60-180s), overrunning CdpSession's own request timeout well
 *  before that -- every `waiting`/`prompt` poll AFTER this call then ran against a start that
 *  had already finished (or a thrown timeout), never the live transition it meant to observe.
 *  Fired without awaiting its own resolution instead (stashed on `window`, polled for later by
 *  nothing in this script -- no caller here needs the eventual outcome, only the live
 *  transition `waitForStartProgressKind` polls for separately): this function now returns as
 *  soon as the call is DISPATCHED, not once the whole start settles. */
export async function restartAgent(cdp, sessionId) {
  const stopped = await cdp.evaluate(`window.refract.sessions.stopAgent(${JSON.stringify(sessionId)})`);
  if (!stopped?.ok) throw new Error(`restartAgent(${sessionId}): stopAgent failed: ${JSON.stringify(stopped)}`);
  // Gate-fix (confirmed live, bg_831): `stopAgent()`'s own client-visible resolution can arrive
  // a tick before the registry's `status` field actually reads 'stopped' -- firing `recover()`
  // immediately after risked it rejecting a precondition check silently (never awaited), with
  // no visible startProgress ever appearing at all. Polls `sessions.list()`'s own real `status`
  // field (unlike startProgress, always included) until it reads 'stopped' first.
  await cdp.waitFor(
    `window.refract.sessions.list().then((r) => r.ok && r.value.find((s) => s.id === ${JSON.stringify(sessionId)})?.status === 'stopped')`,
    { timeoutMs: 10_000, label: `restartAgent(${sessionId}): status reads 'stopped' before recover()` }
  );
  await cdp.evaluate(`(() => {
    window.__672RecoverResult = window.refract.sessions.recover(${JSON.stringify(sessionId)});
    return true;
  })()`);
}

/** Generic version of `waitForRegionOpacity` for an arbitrary selector expression (the overlay's
 *  own `transition-opacity duration-150` means a single read right after dispatching focus/Tab
 *  can land mid-fade; polls instead). */
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

/** Gate-fix (UI round 1): polls the computed opacity of `${REGION0}` until `predicate` is true or
 *  `timeoutMs` elapses, rather than a single read right after the mount `waitFor` -- a real
 *  settle may lag the mount by a frame even with the transition removed. */
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

/** Gate-fix (UI round 1, items 9/12): forces a real layout change via CDP's `Emulation` domain
 *  (confirmed usable over this WebView2 CDP endpoint by several earlier verify-5xx scripts) so a
 *  size-dependent check is never skipped just because this run's own window happened to land in
 *  the other regime. Always clears the override afterward, even if `fn` throws. */
export async function withDeviceMetrics(cdp, width, height, fn) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false });
  // Gate-fix (2026-10-18, found live under real memory pressure): the override itself is
  // applied by CDP immediately, but the renderer's own reflow (container queries, flex wrap)
  // can lag it -- the previous fixed `sleep(300)` alone let at least one geometry read
  // (`elementFromPoint` probe) land mid-reflow, hitting neither the expected region nor the
  // notice. Poll `clientWidth`/`clientHeight` against the requested size first (same
  // poll-with-a-timeout convention as `waitForRegionOpacity`/`waitForComputedOpacity` below,
  // not a fixed sleep), THEN keep the original settle sleep for layout that depends on the
  // viewport but is not the viewport itself.
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

/** Reads the notice's own geometry/styles plus whichever Transcript region actually contains it,
 *  found by rect OVERLAP with the notice's own bounding box (correct regardless of pane index,
 *  not an assumed array position). */
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
/** `REFRACT_672_REUSE_EXE` (slot-move gate-fix, 2026-10-18): if set, hashes and reuses that exe
 *  directly instead of a fresh `tauri build --debug` -- lets this script keep iterating on
 *  ITSELF alone (no product-code change) without needing the shared build slot back each time.
 *  The caller is responsible for confirming the pointed-at exe really does match the committed
 *  head under test; this function only hashes it, never verifies that itself. */
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
/** One scratch Tauri launch: readiness screen through "scratch repository added". Everything
 *  after this (which Sessions get created, in what order) is the caller's own job -- the two
 *  launches below need different session choreography, not just different env vars. */
export async function setupLaunch(exePath, launcherExe, launchLabel, extraEnv, pathPrepend) {
  // Item 5 gate-fix (LOW, test delta on c5756d7): the `try` now covers every mkdtemp call and
  // the launch itself too, not just the steps after it -- a throw from any of THOSE used to
  // leak whatever had already been created (the failed attempt's own scratch folders, or a
  // spawned child with no `cdp` to close) with nothing in scope to clean it up. Each variable
  // starts `undefined`; the `catch` below only removes/stops what actually got created.
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
    await cdp.click(`document.querySelector('[data-readiness-primary]')`);
    await cdp.waitFor(`!!document.querySelector('[role="dialog"] input')`, { timeoutMs: 15_000, label: `${launchLabel}: Add repository dialog open` });
    await cdp.click(`document.querySelector('[role="dialog"] input')`);
    await cdp.send('Input.insertText', { text: repoDir });
    await cdp.clickByText('Add repository', { inDialog: true });
    await cdp.waitFor(`!!document.querySelector('[data-quick-create-session]')`, { timeoutMs: 30_000, label: `${launchLabel}: Scratch repository added, quick-create button visible` });

    // Gate-fix (2026-10-18, issue #985 root cause): confirm the fake-omp shim actually ran,
    // not the real omp.exe resolved from an un-prepended system PATH -- every live run before
    // this fix silently launched the real one (ready in 1-2s, explaining the 0s elapsedMs
    // placeholder reads, no real prompt/extended transition, and the vanishing notice
    // regardless of REFRACT_FAKE_OMP_READY_DELAY_MS). The fake-omp script's own debug log
    // writes its first line (`pid=... argv=... cwd=...`) before anything else; its mere
    // existence with that prefix proves the shim, not the real binary, was spawned.
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

/** Quick-creates a Session via the real UI button and returns `{id, name}` as soon as it
 *  appears in `window.refract.sessions.list()` -- diff-based polling, not a single composer-
 *  enabled snapshot (gate-fix, confirmed live, bg_814 run: a single snapshot check trivially
 *  passes immediately whenever an EARLIER Session is already ready/focused, before the new
 *  one's own async create() has even finished -- removed the earlier `quickCreateSessionAndWaitReady`
 *  entirely rather than leave a known-broken helper unused). Used to create several concurrent
 *  starts quickly (issue #672 gate-fix: exercising the real `queued` startProgress.kind needs
 *  two Sessions already holding the Rust start-queue's own 2 concurrent slots,
 *  `MAX_CONCURRENT_STARTS`, `src-tauri/src/session/start_queue.rs:36`, before a 3rd Session's
 *  own start ever queues). */
export async function quickCreateSessionId(cdp, label) {
  const before = await cdp.evaluate(`window.refract.sessions.list().then((r) => r.ok ? r.value.map((s) => s.id) : [])`);
  await cdp.click(`document.querySelector('[data-quick-create-session]')`);
  const created = await cdp.waitFor(
    `window.refract.sessions.list().then((r) => { if (!r.ok) return null; const before = ${JSON.stringify(before)}; const found = r.value.find((s) => !before.includes(s.id)); return found ? { id: found.id, name: found.name } : null; })`,
    { timeoutMs: 10_000, label: `${label}: Session created (id visible in sessions.list())` }
  );
  if (!created) throw new Error(`${label}: could not identify the newly created Session id.`);
  // Item 4 gate-fix (MEDIUM, test delta on c5756d7): `RepositoryGroup.tsx`'s own quick-create
  // guard (`creatingRepositoryIds.has(repository.id)`) silently no-ops a click that lands before
  // the PREVIOUS create's own async work has fully settled (confirmed by reading that guard, not
  // assumed) -- waiting only for the id to appear in `sessions.list()` can still race it, since
  // that list update and the guard's own clear are not provably the same step. Waiting for THIS
  // Session's own row to report `aria-current="true"` (set only once `replaceFocused`/
  // `targetSession` -- the LAST real side effect of a successful create -- has actually run)
  // gives a caller that creates several Sessions back-to-back (the real `queued`/
  // `memory-deferred` exercise below) a safe moment before clicking again.
  await cdp.waitFor(
    `document.querySelector('[data-session-open=${JSON.stringify(created.id)}]')?.getAttribute('aria-current') === 'true'`,
    { timeoutMs: 10_000, label: `${label}: Session's own row reports aria-current (focused, quick-create guard clear)` }
  );
  return created;
}

/** Shared by the real `queued`/`memory-deferred` exercise (main script, Launch 2): both kinds
 *  render the SAME plain-text path (`[data-start-plain-text]`), centred, not dimmed (each
 *  Session here is brand-new), muted-16px text, a Cancel button -- only the expected text
 *  differs. `sessionId` confirms the notice being read is genuinely this Session's own (its row
 *  reports `aria-current`), not a stale read of whichever pane happened to be focused before. */
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
