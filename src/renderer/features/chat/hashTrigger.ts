// Where a composer `#` picker may open, decided only from the text before the caret (#1789).

export interface HashTrigger {
  /** Index of the `#` in the draft. */
  start: number
  /** What was typed after it; never contains whitespace or another `#`. */
  query: string
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** A backtick run closes the code span opened by the previous run of the same length. */
function endsInsideInlineCode(paragraph: string): boolean {
  let open = 0
  let i = 0
  while (i < paragraph.length) {
    if (paragraph[i] !== '`') {
      i++
      continue
    }
    let j = i
    while (paragraph[j] === '`') j++
    const run = j - i
    if (open === 0) open = run
    else if (open === run) open = 0
    i = j
  }
  return open > 0
}

/** True when the end of `before` is inside a fenced block or an inline code span. */
function endsInsideCode(before: string): boolean {
  let fence: { char: string; length: number } | null = null
  let paragraph = ''
  const lines = before.split('\n')
  for (const [index, line] of lines.entries()) {
    const isLast = index === lines.length - 1
    const match = FENCE_LINE.exec(line)
    if (fence) {
      // A closing fence uses the same character, is at least as long, and has no info string.
      const closes = match && match[1]![0] === fence.char && match[1]!.length >= fence.length && match[2]!.trim() === ''
      if (closes) fence = null
      continue
    }
    if (match && !(match[1]![0] === '`' && match[2]!.includes('`'))) {
      fence = { char: match[1]![0]!, length: match[1]!.length }
      paragraph = ''
      continue
    }
    if (line.trim() === '' && !isLast) {
      paragraph = ''
      continue
    }
    paragraph += `${line}\n`
  }
  if (fence) return true
  return endsInsideInlineCode(paragraph.endsWith('\n') ? paragraph.slice(0, -1) : paragraph)
}

/** The `#query` the caret is at the end of, or null when no picker should be open. */
export function parseHashTrigger(text: string, selectionStart: number, selectionEnd: number): HashTrigger | null {
  if (selectionStart !== selectionEnd || selectionStart > text.length) return null
  const before = text.slice(0, selectionStart)
  let start = before.length
  while (start > 0 && !/\s/.test(before[start - 1]!)) start--
  const token = before.slice(start)
  if (!token.startsWith('#') || token.indexOf('#', 1) !== -1) return null
  if (endsInsideCode(before.slice(0, start) + '#')) return null
  return { start, query: token.slice(1) }
}

/** Replaces the typed `#query` with `#<number> `; the caret belongs just after the inserted space. */
export function applyHashPick(text: string, trigger: HashTrigger, caret: number, number: number): { text: string; caret: number } {
  const insert = `#${number} `
  return { text: text.slice(0, trigger.start) + insert + text.slice(caret), caret: trigger.start + insert.length }
}
