// Shared selectors and small assertion helpers for verify-700-todo-pin.mjs (issue #700/#701
// slice (a) live check), split out to stay under the #806 600-line soft cap.
import { sleep } from './verify-tauri-cdp.mjs';

export const TODO_PILL_SELECTOR =
  `Array.from(document.querySelectorAll('[data-slot="readout-chip"]')).find((el) => (el.querySelector('span.sr-only')?.textContent ?? '').startsWith('Todo:'))`;
export const PANEL_SELECTOR = `document.querySelector('[data-slot="pinned-todo-panel"]')`;
export const STOP_BUTTON_SELECTOR = `document.querySelector('[aria-label="Stop"]')`;
export const SCROLLER_SELECTOR = `document.querySelector('[data-slot="message-scroller-viewport"]')`;

/** Reads the pill's own live state without assuming it is present (it is intentionally absent
 * once there is no plan, or once `sessionReadout['todo-progress']` is turned off). */
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

/** Reads the panel's own current rendered state: header text, whether it is collapsed (the
 * scrolling list is simply absent from the DOM while collapsed, per `PinnedTodoPanel.tsx`'s own
 * `{!collapsed && (...)}` guard), every task row's own text/status-derived class, and the
 * Collapse/Unpin buttons' own `aria-expanded`/presence. */
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

/** The transcript's own real scrollable viewport (gate round 1 fix, Main E1: `[role="log"]`
 * itself never scrolls -- the library's own inner `Viewport` does). */
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

/** The first user message row's own `getBoundingClientRect().top` -- a second, independent
 * "did the transcript visually move" signal alongside `scrollTop` (gate round 1, Main E1). */
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

/** Gate round 1 (Main E7): move the pointer to a neutral spot and wait out any stray tooltip or
 * hover card before a screenshot that must be clean -- used for every theme shot, not only the
 * narrow-width ones. `.finish()` throws `InvalidStateError` on an animation with an infinite
 * target effect end (self-caught live-check failure, a looping spinner); caught per-animation
 * since it has no "final" state to settle to anyway.
 * Gate round 6 fixes (#700, Main MEDIUM 4): a hardcoded `(700, 50)` neutral point could sit
 * OUTSIDE a narrow (360px) viewport, landing on nothing (or something with its own tooltip);
 * clamped to the CURRENT viewport instead. A keyboard-focused Popover/Tooltip survives a pointer
 * move alone -- blur the active element and press Escape too. The stray-overlay wait no longer
 * swallows its own timeout (a `.catch(() => {})` let a screenshot with a visible hover card
 * silently pass) -- it now throws, which `main()`'s own outer catch records as a fatal
 * `ok:false` run-crashed step. `activeElement` is logged every call for the next failure's own
 * diagnosis.
 * Gate round 7 fix (self-caught live-check failure, "Stuart Hopwood" profile-name tooltip still
 * visible in a theme screenshot): a single CDP `mouseMoved` teleports the pointer with no
 * intermediate path, unlike a real mouse -- genuinely fires `pointerleave` on whatever was last
 * hovered/focused only if the browser treats the jump as leaving it, which is not reliable for
 * a CDP-synthesised click at an earlier coordinate. Two real moves (an extreme corner, then the
 * actual neutral point) force two distinct transitions. The stray-overlay check also now
 * matches `[data-slot="tooltip-content"]` directly (`tooltip.tsx`'s own render marker), not
 * only `[role="tooltip"]`, which Radix does not guarantee here. */
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

/** Gate round 6 fix (#700, Main MEDIUM 8): an E1/E4 "did not move" read taken the instant after
 * a click/dispatch can beat a correction that lands one or two frames later, same pattern as
 * `verify-941-stage-naming-helpers.mjs:152`'s own single-frame wait (doubled here). */
export async function waitTwoFrames(cdp) {
  await cdp.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
}
