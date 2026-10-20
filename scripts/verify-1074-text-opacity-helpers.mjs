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
