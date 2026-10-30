// Shared selectors and assertion helpers for verify-700-todo-pin.mjs.
import { sleep } from './verify-tauri-cdp.mjs';

export const TODO_PILL_SELECTOR =
  `Array.from(document.querySelectorAll('[data-slot="readout-chip"]')).find((el) => (el.querySelector('span.sr-only')?.textContent ?? '').startsWith('Todo:'))`;
export const PANEL_SELECTOR = `document.querySelector('[data-slot="pinned-todo-panel"]')`;
export const STOP_BUTTON_SELECTOR = `document.querySelector('[aria-label="Stop"]')`;
export const SCROLLER_SELECTOR = `document.querySelector('[data-slot="message-scroller-viewport"]')`;

/** Reads the pill's live state; it is absent once there is no plan or the readout is off. */
export async function readPill(cdp) {
  return cdp.evaluate(`(() => {
    const el = ${TODO_PILL_SELECTOR};
    if (!el) return null;
    return {
      ariaPressed: el.getAttribute('aria-pressed'),
      ariaControls: el.getAttribute('aria-controls'),
      ariaLabel: el.getAttribute('aria-label'),
      visibleText: (el.querySelector('span[aria-hidden]')?.textContent ?? '').trim()
    };
  })()`);
}

/** Reads the panel's rendered state; the list is absent from the DOM while collapsed. */
export async function readPanel(cdp) {
  return cdp.evaluate(`(() => {
    const panel = ${PANEL_SELECTOR};
    if (!panel) return null;
    const header = panel.querySelector(':scope > div.flex.h-6 > span')?.textContent?.trim() ?? null;
    const collapseBtn = panel.querySelector('[aria-label="Todo list details"]');
    const unpinBtn = panel.querySelector('[aria-label="Unpin todo list"]');
    const list = panel.querySelector('div.overflow-y-auto');
    const rows = list
      ? Array.from(list.querySelectorAll('li')).map((li) => ({
          text: li.textContent.trim(),
          current: li.getAttribute('data-current-task') === 'true',
          lineThrough: !!li.querySelector('.line-through'),
          hasBlockedLine: /Blocked:/.test(li.textContent)
        }))
      : null;
    const phaseHeaders = Array.from(panel.querySelectorAll('div.py-1 > div')).map((d) => d.textContent.trim());
    return {
      tagName: panel.tagName,
      id: panel.id,
      ariaLabel: panel.getAttribute('aria-label'),
      header,
      collapsed: collapseBtn ? collapseBtn.getAttribute('aria-expanded') === 'false' : null,
      collapseAriaControls: collapseBtn ? collapseBtn.getAttribute('aria-controls') : null,
      listId: list ? list.id : null,
      listTabIndex: list ? list.getAttribute('tabindex') : null,
      hasUnpinButton: !!unpinBtn,
      rows,
      phaseHeaders
    };
  })()`);
}

export async function clickCollapseButton(cdp) {
  await cdp.click(`(${PANEL_SELECTOR}).querySelector('[aria-label="Todo list details"]')`);
}

export async function clickUnpinButton(cdp) {
  await cdp.click(`(${PANEL_SELECTOR}).querySelector('[aria-label="Unpin todo list"]')`);
}

export async function clickTodoPill(cdp) {
  await cdp.click(TODO_PILL_SELECTOR);
}

/** `[role="log"]` itself never scrolls; the library's inner Viewport does. */
export async function readScrollerScrollTop(cdp) {
  return cdp.evaluate(`(${SCROLLER_SELECTOR})?.scrollTop ?? null`);
}

export async function readScrollerMetrics(cdp) {
  return cdp.evaluate(`(() => {
    const el = ${SCROLLER_SELECTOR};
    if (!el) return null;
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  })()`);
}

/** First message row's top: a second "did the transcript move" signal alongside `scrollTop`. */
export async function readFirstMessageTop(cdp) {
  return cdp.evaluate(`(() => {
    const el = document.querySelector('[data-slot="message-scroller-viewport"] [role="log"] *');
    const row = Array.from(document.querySelectorAll('[role="log"] *')).find((n) => (n.textContent ?? '').includes('plan and build the thing'));
    return row ? row.getBoundingClientRect().top : null;
  })()`);
}

export async function readUpNextVisible(cdp) {
  return cdp.evaluate(`Array.from(document.querySelectorAll('span')).some((el) => el.textContent.trim() === 'Up next')`);
}

export async function readStillRunning(cdp) {
  return cdp.evaluate(`!!(${STOP_BUTTON_SELECTOR})`);
}

/** Clears stray tooltips/hover cards before a screenshot. Two pointer moves (corner, then a point
 * clamped to the viewport) are needed because one CDP teleport does not reliably fire
 * `pointerleave`; blur + Escape handle keyboard-focused popovers; `finish()` throws on infinite
 * animations, so it is caught per animation. The overlay wait throws rather than swallowing. */
export async function settleForScreenshot(cdp) {
  const { width } = await cdp.evaluate(`({ width: window.innerWidth })`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  await sleep(100);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: width - 20, y: 450 });
  await cdp.evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' });
  await cdp.waitFor(`!document.querySelector('[role="tooltip"]') && !document.querySelector('[data-slot="tooltip-content"]') && !document.querySelector('[data-slot="hover-card-content"]')`, { timeoutMs: 3_000, label: 'stray tooltip/hover card closed before screenshot' });
  await cdp.evaluate(`document.getAnimations().forEach((a) => { try { a.finish() } catch (e) {} })`);
  const activeElement = await cdp.evaluate(`(() => { const el = document.activeElement; return el ? { tag: el.tagName, ariaLabel: el.getAttribute('aria-label') } : null; })()`);
  console.log(`verify-700: settleForScreenshot activeElement`, JSON.stringify(activeElement));
}

/** A read taken right after a click can beat a correction that lands a frame or two later. */
export async function waitTwoFrames(cdp) {
  await cdp.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
}
