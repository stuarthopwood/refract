// DOM side of chat Find (spec 041, #753): reads rendered row text and turns match spans into Ranges.
import { findSpans, type TextSpan } from './findMatcher'
import { MESSAGE_ROW_SELECTOR } from '../messageRow'

const SKIPPED_TEXT_PARENTS =
  'button, svg, script, style, [aria-hidden="true"], .sr-only, [data-slot="message-header"], [data-slot="message-footer"], [role="group"][aria-label="Attached files"], [data-search-skip]'

export function getPane(sessionId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-session-pane="${CSS.escape(sessionId)}"]`)
}

/** Every mounted message row in the pane, by message id. */
export function mountedRows(pane: HTMLElement): Map<string, HTMLElement> {
  const rows = new Map<string, HTMLElement>()
  for (const row of pane.querySelectorAll<HTMLElement>(MESSAGE_ROW_SELECTOR)) {
    const id = row.dataset.messageId
    if (id) rows.set(id, row)
  }
  return rows
}

export interface RowText {
  text: string
  nodes: Text[]
  starts: number[]
}

/** The searchable text of a rendered row, with the text nodes it came from for Range building. */
export function collectRowText(row: HTMLElement): RowText {
  const root = row.querySelector<HTMLElement>('[data-slot="message-content"]') ?? row
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(SKIPPED_TEXT_PARENTS) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  })
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = (node as Text).data
    if (data === '') continue
    nodes.push(node as Text)
    starts.push(text.length)
    text += data
  }
  return { text, nodes, starts }
}

function locate(rowText: RowText, offset: number, preferEnd: boolean): { node: Text; offset: number } | null {
  const { nodes, starts } = rowText
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]
    const start = starts[i]
    if (!node || start === undefined) continue
    const length = node.data.length
    const local = offset - start
    if (local < 0) continue
    if (local < length || (preferEnd && local === length)) return { node, offset: local }
  }
  return null
}

export function rangeForSpan(rowText: RowText, span: TextSpan): Range | null {
  const from = locate(rowText, span.start, false)
  const to = locate(rowText, span.end, true)
  if (!from || !to) return null
  const range = document.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  return range
}

/** One Range per match of `query` in the row's rendered text, in order. */
export function renderedRanges(row: HTMLElement, query: string, matchCase: boolean): Range[] {
  const rowText = collectRowText(row)
  const ranges: Range[] = []
  for (const span of findSpans(rowText.text, query, matchCase)) {
    const range = rangeForSpan(rowText, span)
    if (range) ranges.push(range)
  }
  return ranges
}
