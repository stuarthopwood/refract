export interface ComposerEdit {
  from: number
  to: number
  insert: string
  selStart: number
  selEnd: number
}

const INDENT = '  '
const FENCE = /^\s*(```|~~~)/
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/

interface Line {
  start: number
  end: number
  text: string
  inFence: boolean
}

function splitLines(value: string): Line[] {
  const lines: Line[] = []
  let start = 0
  let open = false
  for (const text of value.split('\n')) {
    const isFence = FENCE.test(text)
    lines.push({ start, end: start + text.length, text, inFence: open && !isFence })
    if (isFence) open = !open
    start += text.length + 1
  }
  return lines
}

function lineIndexAt(lines: Line[], pos: number): number {
  const found = lines.findIndex((line) => pos <= line.end)
  return found === -1 ? lines.length - 1 : found
}

function lineDelta(line: Line, outdent: boolean): number {
  if (!outdent) return line.inFence ? 1 : INDENT.length
  if (line.text.startsWith('\t')) return -1
  return -Math.min(INDENT.length, /^ */.exec(line.text)![0].length)
}

/** Trims the shared prefix and suffix so the textarea sees (and undoes) only the characters that really changed. */
function minimalEdit(value: string, from: number, to: number, insert: string, selStart: number, selEnd: number): ComposerEdit | null {
  const old = value.slice(from, to)
  let head = 0
  while (head < old.length && head < insert.length && old[head] === insert[head]) head++
  let tail = 0
  while (tail < old.length - head && tail < insert.length - head && old[old.length - 1 - tail] === insert[insert.length - 1 - tail]) tail++
  if (old.length === insert.length && head === old.length) return null
  return { from: from + head, to: to - tail, insert: insert.slice(head, insert.length - tail), selStart, selEnd }
}

/** Tab and Shift+Tab: the two-space indent of every touched line, or a tab inside a fenced code block. */
export function planIndent(value: string, selStart: number, selEnd: number, outdent: boolean): ComposerEdit | null {
  const lines = splitLines(value)
  const first = lineIndexAt(lines, selStart)
  if (!outdent && selStart === selEnd && lines[first]!.inFence) {
    return { from: selStart, to: selStart, insert: '\t', selStart: selStart + 1, selEnd: selStart + 1 }
  }
  let last = lineIndexAt(lines, selEnd)
  if (selEnd > selStart && selEnd === lines[last]!.start && last > first) last--
  let total = 0
  let firstDelta = 0
  const rebuilt: string[] = []
  for (let i = first; i <= last; i++) {
    const line = lines[i]!
    const delta = lineDelta(line, outdent)
    if (i === first) firstDelta = delta
    total += delta
    rebuilt.push(delta > 0 ? (line.inFence ? '\t' : INDENT) + line.text : line.text.slice(-delta))
  }
  const from = lines[first]!.start
  const to = lines[last]!.end
  const newStart = Math.max(from, selStart + firstDelta)
  const newEnd = selStart === selEnd ? newStart : Math.max(newStart, selEnd + total)
  return minimalEdit(value, from, to, rebuilt.join('\n'), newStart, newEnd)
}

/** Shift+Enter on a markdown list line: continue the list, or end it on an empty item. Null keeps the native newline. */
export function planListContinuation(value: string, selStart: number, selEnd: number): ComposerEdit | null {
  if (selStart !== selEnd) return null
  const lines = splitLines(value)
  const line = lines[lineIndexAt(lines, selStart)]!
  if (line.inFence) return null
  const match = LIST_ITEM.exec(line.text)
  if (!match) return null
  const { 1: indent = '', 2: marker = '', 3: gap = '', 4: task, 5: content = '' } = match
  const markerEnd = line.start + indent.length + marker.length + gap.length + (task?.length ?? 0)
  if (selStart < markerEnd) return null
  if (content.trim() === '') return { from: line.start, to: line.end, insert: '', selStart: line.start, selEnd: line.start }
  const numbered = /^(\d+)([.)])$/.exec(marker)
  const nextMarker = numbered ? `${Number(numbered[1]) + 1}${numbered[2]}` : marker
  const insert = `\n${indent}${nextMarker}${gap}${task ? '[ ] ' : ''}`
  return { from: selStart, to: selStart, insert, selStart: selStart + insert.length, selEnd: selStart + insert.length }
}

/** Goes through `execCommand` so one edit is one native undo step; the controlled textarea gets a normal `input` event. */
export function applyEdit(textarea: HTMLTextAreaElement, edit: ComposerEdit): void {
  textarea.setSelectionRange(edit.from, edit.to)
  if (edit.insert === '') document.execCommand('delete')
  else document.execCommand('insertText', false, edit.insert)
  textarea.setSelectionRange(edit.selStart, edit.selEnd)
}
