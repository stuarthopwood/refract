// #1170: a small line tokenizer for the composer's live Markdown styling. Not a Markdown parser:
// it splits a draft into consecutive segments whose concatenated text is EXACTLY the draft, each
// tagged with a style kind, so a mirror layer can colour them without changing any character.
// Line-start rules (headings, lists, quotes, fences) plus inline code, bold and italic.

export type MdKind = 'plain' | 'marker' | 'heading' | 'quote' | 'listMarker' | 'bold' | 'italic' | 'code'

export interface MdSegment {
  text: string
  kind: MdKind
}

/** Above this length the draft is left plain (a pasted wall of text is not worth re-tokenising per keystroke). */
export const MAX_STYLED_DRAFT_LENGTH = 20_000

const FENCE = /^( {0,3})(`{3,}|~{3,})/
const HEADING = /^( {0,3})(#{1,6})([ \t]+)([^\n]*)$/
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])([ \t]+)(\[[ xX]\](?=[ \t]))?/
const QUOTE = /^( {0,3}(?:>[ \t]?)+)/

function pushInline(out: MdSegment[], text: string, base: MdKind): void {
  let plainStart = 0
  let i = 0
  const flush = (end: number): void => {
    if (end > plainStart) out.push({ text: text.slice(plainStart, end), kind: base })
  }
  const emit = (start: number, openLen: number, end: number, closeLen: number, kind: MdKind): void => {
    flush(start)
    out.push({ text: text.slice(start, start + openLen), kind: 'marker' })
    out.push({ text: text.slice(start + openLen, end), kind })
    out.push({ text: text.slice(end, end + closeLen), kind: 'marker' })
    i = end + closeLen
    plainStart = i
  }
  while (i < text.length) {
    const ch = text[i]
    if (ch === '`') {
      let run = 1
      while (text[i + run] === '`') run++
      const ticks = '`'.repeat(run)
      let close = text.indexOf(ticks, i + run)
      while (close !== -1 && text[close + run] === '`') close = text.indexOf(ticks, close + run + 1)
      if (close > i + run) emit(i, run, close, run, 'code')
      else i += run
    } else if (ch === '*' && text[i + 1] === '*') {
      const close = text.indexOf('**', i + 2)
      const inner = close === -1 ? '' : text.slice(i + 2, close)
      if (inner && !/^\s|\s$/.test(inner) && !inner.includes('`')) emit(i, 2, close, 2, 'bold')
      else i += 2
    } else if (ch === '*' && text[i + 1] !== undefined && !/\s/.test(text[i + 1]!)) {
      const close = text.indexOf('*', i + 1)
      const inner = close === -1 ? '' : text.slice(i + 1, close)
      if (inner && !/\s$/.test(inner) && !inner.includes('`') && text[close + 1] !== '*') emit(i, 1, close, 1, 'italic')
      else i += 1
    } else {
      i += 1
    }
  }
  flush(text.length)
}

/** Returns the open fence's opening run, or null when no fence is open after this line. */
function pushLine(out: MdSegment[], line: string, fence: string | null): string | null {
  if (fence) {
    out.push({ text: line, kind: 'code' })
    const close = FENCE.exec(line)?.[2]
    return close && close[0] === fence[0] && close.length >= fence.length && line.trim() === close ? null : fence
  }
  const open = FENCE.exec(line)?.[2]
  if (open) {
    out.push({ text: line, kind: 'code' })
    return open
  }
  const heading = HEADING.exec(line)
  if (heading) {
    const markerEnd = heading[1]!.length + heading[2]!.length + heading[3]!.length
    out.push({ text: line.slice(0, markerEnd), kind: 'marker' })
    if (line.length > markerEnd) out.push({ text: line.slice(markerEnd), kind: 'heading' })
    return null
  }
  const quote = QUOTE.exec(line)
  if (quote) {
    out.push({ text: quote[1]!, kind: 'marker' })
    pushInline(out, line.slice(quote[1]!.length), 'quote')
    return null
  }
  const list = LIST.exec(line)
  if (list) {
    const lead = list[1]!.length
    const markerLen = list[2]!.length
    const gapLen = list[3]!.length
    const boxLen = list[4]?.length ?? 0
    if (lead > 0) out.push({ text: line.slice(0, lead), kind: 'plain' })
    out.push({ text: line.slice(lead, lead + markerLen), kind: 'listMarker' })
    out.push({ text: line.slice(lead + markerLen, lead + markerLen + gapLen), kind: 'plain' })
    if (boxLen > 0) out.push({ text: line.slice(lead + markerLen + gapLen, lead + markerLen + gapLen + boxLen), kind: 'listMarker' })
    pushInline(out, line.slice(lead + markerLen + gapLen + boxLen), 'plain')
    return null
  }
  pushInline(out, line, 'plain')
  return null
}

/** Segments whose concatenation equals `text`, or `null` when nothing in it needs styling. */
export function tokenizeMarkdownDraft(text: string): MdSegment[] | null {
  if (!text || text.length > MAX_STYLED_DRAFT_LENGTH) return null
  const out: MdSegment[] = []
  let fence: string | null = null
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    fence = pushLine(out, line, fence)
    if (index < lines.length - 1) out.push({ text: '\n', kind: 'plain' })
  })
  const merged: MdSegment[] = []
  for (const seg of out) {
    if (seg.text === '') continue
    const last = merged[merged.length - 1]
    if (last && last.kind === seg.kind) last.text += seg.text
    else merged.push({ ...seg })
  }
  return merged.some((seg) => seg.kind !== 'plain') ? merged : null
}
