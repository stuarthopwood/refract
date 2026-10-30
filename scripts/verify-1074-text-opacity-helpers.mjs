// CDP-interaction helpers for verify-1074-text-opacity.mjs, split out to stay under the #806 file-size cap.
import { waitTwoFrames } from './verify-700-todo-pin-helpers.mjs';

export const SEND_BUTTON_FINDER = `document.querySelector('button[aria-label="Send message"]')`;
export const HEADER_FINDER = `document.querySelector('header .truncate.text-sm.font-medium')`;
export const CHAT_PROSE_FINDER = `document.querySelector('.text-chat-foreground')`;
export const BADGE_FINDER = `document.querySelector('[data-slot="badge"][data-variant="secondary"]')`;

/** Reads every currently-rendered element this check needs in one round trip. */
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

/** Session count badge on the Manage sessions screen; only mounted while that screen is open, so read separately. */
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

/** Captures a screenshot PNG (base64) without a rect; the caller measures the element after capture so the rect matches the painted pixels. */
export async function capturePngBase64(cdp) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  return data;
}

/** Decodes a captured screenshot in-page via an offscreen `<canvas>` (no Node PNG decoder needed); returns flat RGBA bytes for the CSS-pixel rect. */
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

/** Brightest pixel in an RGBA region; themes are dark, so it is a reliable proxy for a glyph's solid interior rather than a blended edge. */
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

/** Scrolls the transcript up with a trusted CDP `mouseWheel` event: the vendored scroller re-snaps plain
 * `scrollTop`/`scrollIntoView` writes to the bottom unless a real wheel/pointer/key gesture precedes them.
 * Retries because scrollHeight/clientHeight can read equal for a frame or two while content-visibility settles;
 * returns false if no scrollable ancestor is ever found. */
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

// `taskTextColor` per theme (`src/shared/mermaidThemeData.ts`), hardcoded since a .mjs script cannot import TS.
// Mermaid's per-mount scoping re-serializes colours in `themeCSS` to `rgb(r, g, b)`, so the check converts the hex first.
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

// Journey labels must stay solid: match the sibling-selector rule text rather than a bare rgb substring.
// Mermaid's scoping prefixes every selector with a per-render `#mermaid-<reactId> `, so the regex accepts any id.
// Dark (high contrast) cannot be discriminated: its textColor and taskTextColor are both #ffffff, so the rule text
// matches even if the override never fired. Timeline likely shares this path but is not verified (no fixture fence).
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
  const escapedRgb = expectedTaskRgb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Both comma-joined selectors share one declaration block, so `{color:...}` follows only the second.
  const rulePattern = new RegExp(`#mermaid-\\S+ \\.task~switch \\.label,#mermaid-\\S+ \\.journey-section~switch \\.label\\{color:${escapedRgb}`);
  const expectedRuleDescription = `#mermaid-<id> .task~switch .label,#mermaid-<id> .journey-section~switch .label{color:${expectedTaskRgb}`;
  if (!rulePattern.test(journeySvgText)) {
    failures.push(`${theme.name}: real rendered Journey SVG is missing the narrow rule \`${expectedRuleDescription}\` -- labels may still be using the softened textColor, or the selector/declaration format drifted from the confirmed-live shape.`);
  } else if (theme.id === 'dark-high-contrast') {
    findings.push(`${theme.name}: real rendered Journey SVG contains the exact rule \`${expectedRuleDescription}\` -- but this theme's own \`textColor\`/\`taskTextColor\` are BOTH the identical solid #ffffff (FR-023's "stays solid" exception), so this assertion cannot discriminate whether the sibling-selector override actually fired here or Mermaid's unmodified default \`.label\` rule already matched by coincidence -- not meaningful live proof for this one theme.`);
  } else {
    findings.push(`${theme.name}: real rendered Journey SVG contains the exact rule \`${expectedRuleDescription}\` -- task/section labels stay solid on their coloured fillType fill, proving the override genuinely fired, not merely a coincidental default match.`);
  }
}
