// Keyboard hand-offs for the terminal panel, kept pure so they run without a browser (spec 144 T037).

/** True when no control holds the keyboard, as after the focused tab or button unmounted. */
export function focusStranded(doc: { activeElement: unknown; body: unknown }): boolean {
  return doc.activeElement === null || doc.activeElement === doc.body
}

/** Hands the keyboard to the terminal; with none mounted (the last tab just closed) it goes to `fallback`. */
export function returnFocus(toTerminal: () => boolean, fallback: () => void): void {
  if (!toTerminal()) fallback()
}

interface KeyLike {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
}

/**
 * The keys that open the context menu. xterm would send Shift+F10 to the shell and swallow it, so the view hands
 * these two back to the browser, which then raises the `contextmenu` event the menu listens for.
 */
export function opensContextMenu(event: KeyLike): boolean {
  if (event.key === 'ContextMenu') return true
  return event.key === 'F10' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
}
