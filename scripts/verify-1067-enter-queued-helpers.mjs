// Shared process/CDP helpers for verify-1067-enter-queued.mjs (issue #1067 live check), split
// out to stay under the #806 600-line soft cap (same pattern `verify-700-todo-pin-helpers.mjs`
// and `verify-1077-agent-goal-helpers.mjs` use for their own main scripts).
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

/** Screenshot hygiene: move the pointer to a neutral point inside the viewport, blur, press
 * Escape, then fail loudly if a tooltip or hover card is still open -- same pattern every other
 * verify-*.mjs script in this repo follows (e.g. `verify-700-todo-pin-helpers.mjs`). */
export async function settleForScreenshot(cdp) {
  const { width } = await cdp.evaluate(`({ width: window.innerWidth })`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: width - 20, y: 450 });
  await cdp.evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.waitFor(
    `!document.querySelector('[role="tooltip"]') && !document.querySelector('[data-slot="tooltip-content"]') && !document.querySelector('[data-slot="hover-card-content"]')`,
    { timeoutMs: 3_000, label: 'stray tooltip/hover card closed before screenshot' }
  );
}

export async function pressShiftEnter(cdp) {
  // `text`/`unmodifiedText` (same fields `CdpSession.pressEnter` sets) are what makes Chromium
  // treat this as a real keystroke that inserts a character -- a bare keyDown/keyUp pair with
  // no `text` reaches the textarea's own `onKeyDown` but inserts nothing, since the component
  // deliberately never calls `preventDefault` for Shift+Enter (it relies on the browser's own
  // native "Enter inserts a newline in a textarea" behaviour, same as a real keystroke would).
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 8, windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 8, windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
}

/** Reads the composer's own queued-message chips in render order: display text, which queue it
 * belongs to (a follow-up chip always renders a "Send now" button; a steering chip renders the
 * quiet "Sending at the next step" label instead, never both). */
export function readChips(cdp) {
  return cdp.evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('section[data-slot="queued-panel"] ul[aria-label="Queued message list"] > li'));
    return items.map((li) => {
      const text = li.querySelector('span.truncate')?.textContent ?? null;
      const sendBtn = li.querySelector('[data-chip-action="send"]');
      const steeringLabel = li.querySelector('span.text-muted-foreground');
      return {
        text,
        queue: sendBtn ? 'followUp' : (steeringLabel ? 'steering' : 'unknown'),
        sendBusy: sendBtn ? sendBtn.getAttribute('aria-busy') === 'true' : null
      };
    });
  })()`);
}

/** The composer's own hint while blank: a genuinely VISIBLE span whose exact trimmed text
 * matches `expectedText` (not inside any `.sr-only` ancestor, which carries the same text for
 * screen readers via a separate element -- `closest` tells the two apart without depending on
 * the hint overlay's own class list, which could drift independently of this check), plus every
 * id the textarea's `aria-describedby` names and each one's own sr-only text -- the real
 * screen-reader-reachable path issue #533 established. */
export function readHint(cdp, expectedText) {
  return cdp.evaluate(`(() => {
    const textarea = document.querySelector('[aria-label="Message"]');
    const describedBy = (textarea?.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    const describedByText = describedBy.map((id) => (document.getElementById(id)?.textContent ?? null)).filter((t) => t !== null && t !== '');
    const visibleMatch = Array.from(document.querySelectorAll('span')).find((el) => el.textContent.trim() === ${JSON.stringify(expectedText)} && !el.closest('.sr-only'));
    const visibleLead = visibleMatch ? visibleMatch.textContent.trim() : null;
    return { describedBy, describedByText, visibleLead, value: textarea?.value ?? null };
  })()`);
}

export function debugLogContent(logPath) {
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

export function countRecvLinesContaining(content, needle) {
  return content.split('\n').filter((line) => line.includes('RECV') && line.includes(needle)).length;
}
