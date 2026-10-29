// Pure, DOM-free search over message text for chat Find (spec 041, #753). The caller decides which
// text each message contributes (rendered text when its row is mounted, source text otherwise) and
// passes it in through `getMessage`; this file only matches, chunks and caps.

export const MATCH_CAP = 500
export const SEARCH_CHUNK_SIZE = 200
const SNIPPET_BEFORE_CHARS = 36
const SNIPPET_AFTER_CHARS = 72

export interface TextSpan {
  start: number
  end: number
}

export interface MatchSnippet {
  before: string
  match: string
  after: string
}

/** `rendered`: read from the mounted row's DOM text. `source`: the transcript item's text. */
export type TextOrigin = 'rendered' | 'source'

export interface SearchMessage {
  id: string
  text: string
  origin: TextOrigin
}

/** Every match inside one message; `spans[i]` and `snippets[i]` describe the i-th match. */
export interface MessageMatchGroup {
  id: string
  origin: TextOrigin
  spans: TextSpan[]
  snippets: MatchSnippet[]
}

export interface SearchOutcome {
  groups: MessageMatchGroup[]
  total: number
  /** True when matches beyond `MATCH_CAP` exist and were dropped. */
  capped: boolean
}

/** Lower-cased copy of each source message's text, so typing does not re-lower-case the whole
 * transcript on every query. An entry is replaced when its text changes (a streaming reply). */
export class LowerCaseCache {
  private readonly entries = new Map<string, { text: string; lower: string }>()

  get(id: string, text: string): string {
    const hit = this.entries.get(id)
    if (hit && hit.text === text) return hit.lower
    const lower = text.toLowerCase()
    this.entries.set(id, { text, lower })
    return lower
  }

  clear(): void {
    this.entries.clear()
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Non-overlapping spans of `needle` in `text`, left to right, at most `limit` of them. */
export function findSpans(text: string, needle: string, matchCase: boolean, lowered?: string, limit = Number.POSITIVE_INFINITY): TextSpan[] {
  if (needle === '' || limit <= 0) return []
  const spans: TextSpan[] = []
  const haystack = matchCase ? text : (lowered ?? text.toLowerCase())
  if (!matchCase && haystack.length !== text.length) {
    // Some characters change length when lower-cased, which would shift every later offset.
    const pattern = new RegExp(escapeRegExp(needle), 'giu')
    for (let hit = pattern.exec(text); hit && spans.length < limit; hit = pattern.exec(text)) {
      spans.push({ start: hit.index, end: hit.index + hit[0].length })
    }
    return spans
  }
  const target = matchCase ? needle : needle.toLowerCase()
  let from = 0
  while (spans.length < limit) {
    const at = haystack.indexOf(target, from)
    if (at < 0) break
    spans.push({ start: at, end: at + target.length })
    from = at + target.length
  }
  return spans
}

function flatten(value: string): string {
  return value.replace(/\s+/g, ' ')
}

export function buildSnippet(text: string, span: TextSpan): MatchSnippet {
  const from = Math.max(0, span.start - SNIPPET_BEFORE_CHARS)
  const to = Math.min(text.length, span.end + SNIPPET_AFTER_CHARS)
  const before = flatten(text.slice(from, span.start)).trimStart()
  const after = flatten(text.slice(span.end, to)).trimEnd()
  return {
    before: from > 0 ? `…${before}` : before,
    match: flatten(text.slice(span.start, span.end)),
    after: to < text.length ? `${after}…` : after
  }
}

/** The matches of `query` in one message, or `null` when it has none. */
export function matchMessage(
  message: SearchMessage,
  query: string,
  matchCase: boolean,
  cache?: LowerCaseCache,
  limit?: number
): MessageMatchGroup | null {
  const lowered = !matchCase && message.origin === 'source' ? cache?.get(message.id, message.text) : undefined
  const spans = findSpans(message.text, query, matchCase, lowered, limit)
  if (spans.length === 0) return null
  return { id: message.id, origin: message.origin, spans, snippets: spans.map((span) => buildSnippet(message.text, span)) }
}

export interface SearchOptions {
  count: number
  /** The text message `index` contributes, or `null` to skip it. Called lazily, one chunk at a time. */
  getMessage(index: number): SearchMessage | null
  query: string
  matchCase: boolean
  cache?: LowerCaseCache
  signal: AbortSignal
  cap?: number
  chunkSize?: number
  /** Lets the event loop breathe between chunks; defaults to a macrotask. */
  yieldToEventLoop?(): Promise<void>
}

const defaultYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Searches messages in order, `chunkSize` at a time, yielding between chunks and stopping early
 * once `cap` matches are collected. Resolves `null` when `signal` aborts (a newer query started). */
export async function searchMessages(options: SearchOptions): Promise<SearchOutcome | null> {
  const { count, getMessage, query, matchCase, cache, signal, cap = MATCH_CAP, chunkSize = SEARCH_CHUNK_SIZE } = options
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultYield
  const groups: MessageMatchGroup[] = []
  let total = 0
  if (query === '') return { groups, total, capped: false }
  for (let start = 0; start < count; start += chunkSize) {
    if (signal.aborted) return null
    const end = Math.min(count, start + chunkSize)
    for (let index = start; index < end; index += 1) {
      const message = getMessage(index)
      if (!message) continue
      const group = matchMessage(message, query, matchCase, cache, cap - total + 1)
      if (!group) continue
      const room = cap - total
      if (group.spans.length > room) {
        group.spans.length = room
        group.snippets.length = room
        if (room > 0) groups.push(group)
        return { groups, total: cap, capped: true }
      }
      groups.push(group)
      total += group.spans.length
    }
    if (end < count) {
      await yieldToEventLoop()
      if (signal.aborted) return null
    }
  }
  return { groups, total, capped: false }
}
