/** `focus()` is silently ignored while a list is still measuring, so success is judged by where focus landed, letting the caller retry. */
export function focusTook(el: HTMLElement): boolean {
  el.focus()
  return el.ownerDocument.activeElement === el
}
