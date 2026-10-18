// Shared constants and pure/CDP helpers for `verify-672-start-message.mjs` (issue #672, #806
// file-size split: extracted once the gate-round-2 contrast/wheel/short-window rewrites pushed
// the main script past the 600-line soft cap, the same reason `verify-947-938-helpers.mjs` and
// `verify-560-helpers.mjs` exist for their own scripts). Nothing here owns process lifecycle
// (launch/build/cleanup) -- that stays in the main script, matching the existing convention.

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

// The joke-stage kinds (SessionStartNotice.tsx's own `isJokeStage`) and the plain-text kinds,
// each with a `showControls` kind mixed in so Keep waiting/Cancel reachability gets checked too.
export const JOKE_STAGES = [
  { kind: 'waiting', elapsedMs: 0 },
  { kind: 'prompt', elapsedMs: 15_000 },
  { kind: 'extended', elapsedMs: 45_000 }
];
export const PLAIN_STAGES = [
  { kind: 'queued', elapsedMs: 0 },
  { kind: 'memory-deferred', elapsedMs: 0 }
];

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

export function animationDurationMs(cssDuration) {
  const match = /^([\d.]+)(m?s)$/.exec(cssDuration ?? '');
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
export function parseRgb(rgbString) {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(rgbString ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function contrastRatio(fg, bg) {
  const rgbFg = parseRgb(fg), rgbBg = parseRgb(bg);
  if (!rgbFg || !rgbBg) return null;
  const lFg = relativeLuminance(rgbFg), lBg = relativeLuminance(rgbBg);
  const lighter = Math.max(lFg, lBg), darker = Math.min(lFg, lBg);
  return (lighter + 0.05) / (darker + 0.05);
}
/** Gate round 2 item 7: parses alpha too (`parseRgb` above only reads r/g/b), so the panel's own
 *  `bg-background/90` can be composited rather than approximated as opaque. */
export function parseRgba(rgbaString) {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(rgbaString ?? '');
  return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] !== undefined ? Number(m[4]) : 1 } : null;
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

export async function setStartProgress(cdp, sessionId, startProgress) {
  const value = startProgress === undefined ? 'undefined' : JSON.stringify(startProgress);
  const ok = await cdp.evaluate(`(() => {
    const store = window.__refractStores.sessions;
    const sessions = store.getState().sessions.map((s) => s.id === ${JSON.stringify(sessionId)} ? { ...s, startProgress: ${value} } : s);
    store.setState({ sessions });
    return true;
  })()`);
  if (!ok) throw new Error(`setStartProgress(${sessionId}): store update did not return true`);
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
export async function readNoticeState(cdp) {
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
