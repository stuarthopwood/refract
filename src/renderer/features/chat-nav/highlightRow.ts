export const NAV_HIGHLIGHT_ATTRIBUTE = 'data-nav-highlight'
export const NAV_HIGHLIGHT_MS = 800

const timers = new WeakMap<Element, number>()

/** Marks a row for the brief landing outline (`globals.css`); the outline is a shape, not colour
 * alone, and the fade is skipped under reduced motion. Re-flashing restarts the timer. */
export function flashRowHighlight(row: HTMLElement): void {
  const pending = timers.get(row)
  if (pending !== undefined) clearTimeout(pending)
  row.removeAttribute(NAV_HIGHLIGHT_ATTRIBUTE)
  // Reading layout restarts the CSS animation when the same row is flashed twice in a row.
  void row.offsetWidth
  row.setAttribute(NAV_HIGHLIGHT_ATTRIBUTE, '')
  timers.set(
    row,
    window.setTimeout(() => {
      row.removeAttribute(NAV_HIGHLIGHT_ATTRIBUTE)
      timers.delete(row)
    }, NAV_HIGHLIGHT_MS)
  )
}
