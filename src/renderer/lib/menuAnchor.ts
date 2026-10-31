const MIRRORED_STYLES = [
  'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontFamily', 'fontSize', 'fontWeight',
  'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'textIndent', 'tabSize', 'wordSpacing'
] as const

export interface MenuPoint {
  x: number
  y: number
}

/** Viewport point just under the caret of a text field, found by laying the text before it out in an offscreen mirror. */
function caretPoint(field: HTMLInputElement | HTMLTextAreaElement): MenuPoint | null {
  const caret = field.selectionEnd
  if (caret == null) return null
  const rect = field.getBoundingClientRect()
  const style = getComputedStyle(field)
  const mirror = document.createElement('div')
  mirror.setAttribute('aria-hidden', 'true')
  for (const name of MIRRORED_STYLES) mirror.style[name] = style[name]
  const multiline = field instanceof HTMLTextAreaElement
  mirror.style.cssText += `;position:fixed;visibility:hidden;top:0;left:-9999px;overflow:hidden;white-space:${multiline ? 'pre-wrap' : 'pre'};overflow-wrap:break-word`
  mirror.textContent = field.value.slice(0, caret)
  const marker = document.createElement('span')
  marker.textContent = '\u200b'
  mirror.append(marker)
  document.body.append(mirror)
  try {
    const lineHeight = Number.parseFloat(style.lineHeight) || marker.offsetHeight
    const x = rect.left + marker.offsetLeft - field.scrollLeft
    const y = rect.top + marker.offsetTop - field.scrollTop + lineHeight
    return {
      x: Math.min(Math.max(x, rect.left), rect.right),
      y: Math.min(Math.max(y, rect.top), rect.bottom)
    }
  } finally {
    mirror.remove()
  }
}

/** Where a keyboard-opened menu (Shift+F10, Menu key) anchors: the caret in a text field, else the element's bottom-left corner. */
export function keyboardMenuAnchor(target: Element): MenuPoint {
  if (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type !== 'checkbox' && target.type !== 'radio')) {
    const point = caretPoint(target)
    if (point) return point
  }
  const rect = target.getBoundingClientRect()
  return { x: rect.left, y: rect.bottom }
}
