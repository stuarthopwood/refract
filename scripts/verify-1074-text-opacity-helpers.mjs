// Shared CDP-interaction helpers for verify-1074-text-opacity.mjs, split out to stay under the
// #806 file-size ratchet's own 600-line soft cap (same "pure-logic, behaviour-preserving
// extraction" pattern `theme-contrast-pairs.mjs`/`mermaidThemeData.ts`/`verify-551-helpers.mjs`
// already use for exactly this situation -- a baseline entry may never be RAISED, so legitimate
// growth moves out into its own module instead).
import { waitTwoFrames } from './verify-700-todo-pin-helpers.mjs';

export const SEND_BUTTON_FINDER = `document.querySelector('button[aria-label="Send message"]')`;
export const HEADER_FINDER = `document.querySelector('header .truncate.text-sm.font-medium')`;
export const CHAT_PROSE_FINDER = `document.querySelector('.text-chat-foreground')`;
export const BADGE_FINDER = `document.querySelector('[data-slot="badge"][data-variant="secondary"]')`;

/** Reads every REAL, currently-rendered element this check needs in one round trip (never a
 * hidden probe alone -- see verify-1074-text-opacity.mjs's own header comment for which
 * component each belongs to). */
export async function readRealColours(cdp) {
  return cdp.evaluate(`(() => {
    const header = ${HEADER_FINDER};
    const footer = document.querySelector('footer');
    const chatProse = ${CHAT_PROSE_FINDER};
    const send = ${SEND_BUTTON_FINDER};
    return {
      header: header ? getComputedStyle(header).color : null,
      muted: footer ? getComputedStyle(footer).color : null,
      chat: chatProse ? getComputedStyle(chatProse).color : null,
      sendBackground: send ? getComputedStyle(send).backgroundColor : null,
      sendForeground: send ? getComputedStyle(send).color : null
    };
  })()`);
}

/** Session count badge on the Manage sessions screen (`ManageSessionsScreen.tsx`,
 * `data-slot="badge" data-variant="secondary"`) -- only mounted while that screen is open, so
 * read separately from `readRealColours` above (the chat-view elements). */
export async function readBadgeColour(cdp) {
  return cdp.evaluate(`(() => { const b = ${BADGE_FINDER}; return b ? getComputedStyle(b).color : null; })()`);
}

export async function openSettingsAppearance(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Settings"]')`);
  await cdp.waitFor(`!!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 15_000, label: 'Settings screen opened' });
  await cdp.click(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find((el) => el.textContent.trim() === 'Appearance')`);
  await cdp.waitFor(`!!document.querySelector('[role="radiogroup"]')`, { timeoutMs: 10_000, label: 'Appearance section mounted (theme picker radiogroup)' });
}

export async function closeSettingsBackToChat(cdp) {
  await cdp.click(`document.querySelector('[aria-label="Back to chat"]')`);
  await cdp.waitFor(`!document.querySelector('[aria-label="Back to chat"]')`, { timeoutMs: 10_000, label: 'Settings closed, back in chat' });
}

/** Captures a real `Page.captureScreenshot` PNG (base64) with no rect baked in yet -- split out
 * from the old single `samplePixelRegion` (gate-fix, Code/Test Medium: the caller now measures
 * the chat-prose element's own `getBoundingClientRect()` AFTER this capture completes, not
 * before, so the rect it samples against reflects the exact moment the pixels were actually
 * painted, never a stale pre-capture measurement a theme-switch repaint could have shifted). */
export async function capturePngBase64(cdp) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  return data;
}

/** Decodes an already-captured screenshot (see `capturePngBase64` above) entirely inside the
 * page via an offscreen `<canvas>` (`drawImage` + `getImageData`), so no Node-side PNG decoder
 * dependency is needed -- the same technique `verify-1050-command-pill-helpers.mjs`'s own
 * (module-private) `capturePixelRegion` uses. Returns a flat RGBA byte array for the given
 * CSS-pixel rect. */
export async function decodePixelRegion(cdp, pngBase64, rect) {
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  return cdp.evaluate(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(${x}, ${y}, ${w}, ${h}).data;
      resolve(Array.from(d));
    };
    img.onerror = reject;
    img.src = 'data:image/png;base64,${pngBase64}';
  })`);
}

/** The single brightest (most fully-inked, least anti-aliased) pixel in a sampled RGBA region --
 * every theme here is dark-toned, so the chat text is always lighter than its own background,
 * making "brightest" a reliable proxy for "a glyph's own solid interior", not a blended edge. */
export function brightestPixel(rgba) {
  let best = null;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const sum = r + g + b;
    if (!best || sum > best.sum) best = { r, g, b, sum };
  }
  return best;
}

/** The transcript's vendored message-scroller (`Transcript.tsx`) sticks to the bottom and
 * silently re-snaps any plain `scrollTop`/`scrollIntoView` write straight back to the end --
 * its own `handleViewportScroll` only disengages follow-bottom when it sees the scroll move up
 * AND `useScrollGestureTracking().isRecentGesture()` is true, which ONLY a real `wheel`/
 * pointer/touch/key DOM event sets (confirmed live: a `scrollIntoView` call measurably moved
 * `scrollTop` to its OWN requested value for one frame, then the vendored scroller snapped it
 * straight back to `scrollHeight - clientHeight` by the time this script's own two-frame
 * settle read it back). CDP's `Input.dispatchMouseEvent` `mouseWheel` type dispatches a
 * trusted wheel event the real `onWheel` listener sees, so the resulting scroll-up genuinely
 * sticks instead of being fought. Returns false (caller fails loudly) if no scrollable
 * ancestor is found at all even after retrying (the scrollable transcript container's own
 * `scrollHeight`/`clientHeight` can transiently read equal for a frame or two right after the
 * Manage-sessions-closed navigation settles -- `Transcript.tsx`'s own "landing" effect comment
 * describes the same still-settling `content-visibility:auto` window). */
export async function scrollTranscriptToShow(cdp, finderExpr) {
  let viewportCentre = null;
  for (let attempt = 0; attempt < 10 && !viewportCentre; attempt++) {
    if (attempt > 0) await waitTwoFrames(cdp);
    viewportCentre = await cdp.evaluate(`(() => {
      const el = ${finderExpr};
      if (!el) return null;
      let anc = el.parentElement;
      while (anc) {
        const cs = getComputedStyle(anc);
        if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && anc.scrollHeight > anc.clientHeight) {
          const r = anc.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        anc = anc.parentElement;
      }
      return null;
    })()`);
  }
  if (!viewportCentre) return false;
  for (let i = 0; i < 8; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: viewportCentre.x, y: viewportCentre.y, deltaX: 0, deltaY: -2000 });
    await waitTwoFrames(cdp);
  }
  return true;
}

// `taskTextColor` per theme (`src/shared/mermaidThemeData.ts`) -- Journey/Gantt's own "solid on
// a coloured task-bar fill" FR-023 exception token. Hardcoded here, not imported, the same way
// verify-1039-amber-retune.mjs's own `MERMAID_NODE_TEXT` is (no cross-file TS import from a
// plain .mjs script). Gate round 3 fix (Main, #1074 follow-up, item 1): Mermaid's own per-mount
// stylesheet scoping re-serializes every colour value in our custom `themeCSS` string to
// `rgb(r, g, b)` notation before embedding it (confirmed live: a real decoded Journey SVG), so
// the real check below converts this hex literal to that form first, rather than searching for
// the hex text verbatim (which never matches post-scoping).
export const JOURNEY_TASK_TEXT_COLOUR = {
  dark: '#fafafa',
  'dark-high-contrast': '#ffffff',
  obsidian: '#F8FAFC',
  'nordic-frost': '#eff7fb',
  'cyber-amber': '#fafafa'
};

export function hexToRgbString(hex) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

// ---- Journey diagram labels stay solid (gate round 3 fix, Main's follow-up, item 1):
// the fixture's second mermaid fence (`997-notice-severity.jsonl`, extended this round)
// renders a Journey diagram; its task/section labels render via Mermaid's own default
// foreignObject path (confirmed by reading node_modules/mermaid's own journeyDiagram
// source directly -- see mermaidTheme.ts's own comment on the fix), so the embedded
// `<style>` block this file's getMermaidThemeCSS generates is what actually governs
// them. Journey's own task/section fills (`fillType0`-`fillType7`) are fixed literal
// hex values (NOT derived from `primaryColor`/`secondaryColor` -- see that interface
// comment's own correction), so the expected colour below is this theme's own solid
// `taskTextColor` literal, not a computed one.
// Narrowed (gate round 3, Test review: evidence-honesty HIGH) to match the actual CSS
// RULE TEXT this file's own sibling-selector override emits -- `.task~switch
// .label{color:rgb(...)` -- not merely "this rgb string appears somewhere in the SVG",
// which could coincidentally match an unrelated element. Gate-fix (live debug, prior
// run): Mermaid's own per-mount stylesheet scoping re-serializes every colour value to
// `rgb(r, g, b)` notation and strips the space around `~` (confirmed live: a real
// decoded SVG showed the exact rule `.task~switch .label{color:rgb(250, 250, 250)
// !important}` for Dark's `#fafafa`) -- searching for the plain hex literal verbatim,
// as the gitGraph/flowchart checks elsewhere in this file do against THEIR OWN
// already-hex `themeVariables` strings, never matches here; this one checks the
// narrowed `rgb()` rule-text form instead.
// Dark (high contrast) CANNOT be discriminated by this assertion: FR-023's "stays
// solid" exception means its own `textColor` and `taskTextColor` are both the
// identical literal `#ffffff`, so the expected rule text is present whether the
// sibling-selector override fired or Mermaid's unmodified default `.label` rule simply
// matched by coincidence -- handled explicitly below, not claimed as proof there.
// Timeline shares the identical renderer code path (its own `textPlacement` also
// defaults to `'fo'`, and its svgDraw source emits the identical `task`/
// `journey-section` class names -- confirmed by reading node_modules/mermaid's own
// timeline-definition source directly), so this selector likely reaches it too -- NOT
// separately verified: this fixture has no Timeline fence, and #1108's scope stays
// Gantt-only, so Timeline coverage here is an inferred likelihood, not a proven fact.
// ----
export async function assertJourneyLabelsSolid(cdp, theme, findings, failures) {
  const mermaidImgs = await cdp.evaluate(`Array.from(document.querySelectorAll('img[role="img"]')).map((el) => el.getAttribute('src'))`);
  if (!Array.isArray(mermaidImgs) || mermaidImgs.length < 2 || !mermaidImgs[1]) {
    failures.push(`${theme.name}: expected 2 real rendered Mermaid diagrams (flowchart then journey), found ${Array.isArray(mermaidImgs) ? mermaidImgs.length : 0}.`);
    return;
  }
  const journeySrc = mermaidImgs[1];
  if (!journeySrc.startsWith('data:image/svg+xml')) {
    failures.push(`${theme.name}: second Mermaid diagram (journey) has no real data: URI src (got ${JSON.stringify(journeySrc)}).`);
    return;
  }
  const journeySvgText = decodeURIComponent(journeySrc.slice(journeySrc.indexOf(',') + 1));
  const expectedTaskRgb = hexToRgbString(JOURNEY_TASK_TEXT_COLOUR[theme.id]);
  const expectedRule = `.task~switch .label{color:${expectedTaskRgb}`;
  if (!journeySvgText.includes(expectedRule)) {
    failures.push(`${theme.name}: real rendered Journey SVG is missing the narrow rule \`${expectedRule}\` -- labels may still be using the softened textColor, or the selector/declaration format drifted from the confirmed-live shape.`);
  } else if (theme.id === 'dark-high-contrast') {
    findings.push(`${theme.name}: real rendered Journey SVG contains the exact rule \`${expectedRule}\` -- but this theme's own \`textColor\`/\`taskTextColor\` are BOTH the identical solid #ffffff (FR-023's "stays solid" exception), so this assertion cannot discriminate whether the sibling-selector override actually fired here or Mermaid's unmodified default \`.label\` rule already matched by coincidence -- not meaningful live proof for this one theme.`);
  } else {
    findings.push(`${theme.name}: real rendered Journey SVG contains the exact rule \`${expectedRule}\` -- task/section labels stay solid on their coloured fillType fill, proving the override genuinely fired, not merely a coincidental default match.`);
  }
}
