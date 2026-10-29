export interface EditState {
  value: string
  selectionStart: number
  selectionEnd: number
}

function lineRange(state: EditState): { start: number; end: number } {
  const start = state.value.lastIndexOf('\n', state.selectionStart - 1) + 1
  const nextBreak = state.value.indexOf('\n', state.selectionEnd)
  return { start, end: nextBreak === -1 ? state.value.length : nextBreak }
}

// Wraps the selection in `before`/`after`; with no selection inserts the markers around
// `placeholder` and selects it. Wrapping an already-wrapped selection unwraps it.
export function wrapSelection(state: EditState, before: string, after: string, placeholder: string): EditState {
  const { value, selectionStart, selectionEnd } = state
  const selected = value.slice(selectionStart, selectionEnd)
  if (
    selected.length >= before.length + after.length &&
    selected.startsWith(before) &&
    selected.endsWith(after)
  ) {
    const inner = selected.slice(before.length, selected.length - after.length)
    return {
      value: value.slice(0, selectionStart) + inner + value.slice(selectionEnd),
      selectionStart,
      selectionEnd: selectionStart + inner.length
    }
  }
  const text = selected || placeholder
  const next = value.slice(0, selectionStart) + before + text + after + value.slice(selectionEnd)
  return {
    value: next,
    selectionStart: selectionStart + before.length,
    selectionEnd: selectionStart + before.length + text.length
  }
}

// Inserts `prefix(index)` at the start of every line the selection touches; when every such line
// already matches `matcher`, removes the prefix instead.
export function prefixLines(state: EditState, prefix: (index: number) => string, matcher: RegExp): EditState {
  const { start, end } = lineRange(state)
  const lines = state.value.slice(start, end).split('\n')
  const allPrefixed = lines.every((line) => matcher.test(line))
  const next = lines.map((line, index) => (allPrefixed ? line.replace(matcher, '') : prefix(index) + line))
  const block = next.join('\n')
  return {
    value: state.value.slice(0, start) + block + state.value.slice(end),
    selectionStart: start,
    selectionEnd: start + block.length
  }
}

export const applyBold = (state: EditState): EditState => wrapSelection(state, '**', '**', 'bold text')
export const applyItalic = (state: EditState): EditState => wrapSelection(state, '_', '_', 'italic text')
export const applyHeading = (state: EditState): EditState => prefixLines(state, () => '### ', /^### /)
export const applyQuote = (state: EditState): EditState => prefixLines(state, () => '> ', /^> ?/)
export const applyBulletedList = (state: EditState): EditState => prefixLines(state, () => '- ', /^- (?!\[[ xX]\] )/)
export const applyNumberedList = (state: EditState): EditState =>
  prefixLines(state, (index) => `${index + 1}. `, /^\d+\. /)
export const applyTaskList = (state: EditState): EditState => prefixLines(state, () => '- [ ] ', /^- \[[ xX]\] /)

// A multi-line selection becomes a fenced block; anything else an inline code span.
export function applyCode(state: EditState): EditState {
  const selected = state.value.slice(state.selectionStart, state.selectionEnd)
  if (!selected.includes('\n')) return wrapSelection(state, '`', '`', 'code')
  const fenced = `\`\`\`\n${selected}\n\`\`\``
  return {
    value: state.value.slice(0, state.selectionStart) + fenced + state.value.slice(state.selectionEnd),
    selectionStart: state.selectionStart + 4,
    selectionEnd: state.selectionStart + 4 + selected.length
  }
}

// `[selection](url)` with `url` selected, ready to type over; with no selection `[link text](url)`
// with the text selected.
export function applyLink(state: EditState): EditState {
  const selected = state.value.slice(state.selectionStart, state.selectionEnd)
  const text = selected || 'link text'
  const url = 'url'
  const insert = `[${text}](${url})`
  const value = state.value.slice(0, state.selectionStart) + insert + state.value.slice(state.selectionEnd)
  if (selected) {
    const urlStart = state.selectionStart + text.length + 3
    return { value, selectionStart: urlStart, selectionEnd: urlStart + url.length }
  }
  return { value, selectionStart: state.selectionStart + 1, selectionEnd: state.selectionStart + 1 + text.length }
}
