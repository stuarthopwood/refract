// Shared selectors and small assertion helpers for verify-700-todo-pin.mjs (issue #700/#701
// slice (a) live check), split out to stay under the #806 600-line soft cap.

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
    const phaseHeaders = Array.from(panel.querySelectorAll('div.py-0\\\\.5 > div')).map((d) => d.textContent.trim());
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
