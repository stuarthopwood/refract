// Shared CDP helpers for verify-1067-enter-queued.mjs (split out for the #806 file-size cap).
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export function spawnSync_(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}

/** Moves the pointer away, blurs, presses Escape, and fails if a tooltip/hover card is still open. */
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
  // `text` is what makes Chromium insert a newline: the component never calls preventDefault for
  // Shift+Enter and relies on the textarea's native behaviour.
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 8, windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 8, windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
}

/** Reads the queued-message chips in render order; a follow-up chip has "Send now", a steering chip a label. */
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

/** Reads the visible blank-composer hint; `closest('.sr-only')` separates it from the screen-reader copy (#533). */
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
