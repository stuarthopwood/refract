import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EMPTY_TRANSCRIPT, useTranscriptStore } from '@/state'
import { EMPTY_CHAT_NAV, useChatNavStore } from '@/state/chat-nav-store'
import { NAV_HIGHLIGHT_ATTRIBUTE } from '../highlightRow'
import { jumpToMessage } from '../jumpToMessage'
import { collectRowText, getPane, mountedRows, renderedRanges } from './findDom'
import {
  LowerCaseCache,
  MATCH_CAP,
  searchMessages,
  type MatchSnippet,
  type MessageMatchGroup,
  type SearchMessage,
  type SearchOutcome
} from './findMatcher'
import { clearPane, paintPane } from './findPainter'
import { revealMatchWhenLanded } from './revealMatch'

const DEBOUNCE_MS = 150
const PAINT_THROTTLE_MS = 250

export interface FlatMatch {
  id: string
  ordinal: number
  kind: 'user' | 'agent'
  turnIndex: number
  snippet: MatchSnippet
}

interface Settled extends SearchOutcome {
  query: string
  matchCase: boolean
}

export interface ChatFind {
  matches: readonly FlatMatch[]
  cursor: number
  capped: boolean
  /** Polite live-region text; empty until a search for the current query has settled. */
  status: string
  next(): void
  previous(): void
  select(index: number): void
  /** Enter: waits for any pending or running search to settle, then steps (or, when that search
   * just jumped to its first match, stays there). */
  submit(backward: boolean): Promise<void>
}

type RunResult = 'jumped' | 'settled' | 'aborted'

const searchKeyOf = (query: string, matchCase: boolean) => `${query}\u0000${matchCase}`

/** The index of the first match at or after the topmost visible message, else the nearest before it. */
function startIndex(list: readonly FlatMatch[], sessionId: string): number {
  const entry = useChatNavStore.getState().bySession[sessionId] ?? EMPTY_CHAT_NAV
  const order = new Map(entry.index.map((message, position) => [message.id, position]))
  const anchor = (entry.view.currentMessageId !== null ? order.get(entry.view.currentMessageId) : undefined) ?? 0
  const at = list.findIndex((match) => (order.get(match.id) ?? 0) >= anchor)
  return at >= 0 ? at : list.length - 1
}

/** Rendered rows contribute their DOM text; windowed-out ones contribute transcript source text. */
function messageReader(sessionId: string, index: ReturnType<typeof navIndex>) {
  const items = useTranscriptStore.getState().bySession[sessionId]?.items ?? EMPTY_TRANSCRIPT.items
  const sourceText = new Map<string, string>()
  for (const item of items) if (item.kind === 'user' || item.kind === 'assistant-text') sourceText.set(item.id, item.text)
  const pane = getPane(sessionId)
  const rows = pane ? mountedRows(pane) : new Map<string, HTMLElement>()
  return (i: number): SearchMessage | null => {
    const nav = index[i]
    if (!nav) return null
    const row = rows.get(nav.id)
    if (row) {
      const text = collectRowText(row).text
      if (text !== '') return { id: nav.id, text, origin: 'rendered' }
    }
    const text = sourceText.get(nav.id)
    return text ? { id: nav.id, text, origin: 'source' } : null
  }
}

function navIndex(sessionId: string) {
  return (useChatNavStore.getState().bySession[sessionId] ?? EMPTY_CHAT_NAV).index
}

function flatten(groups: readonly MessageMatchGroup[], sessionId: string): FlatMatch[] {
  const byId = new Map(navIndex(sessionId).map((message) => [message.id, message]))
  const flat: FlatMatch[] = []
  for (const group of groups) {
    const nav = byId.get(group.id)
    group.spans.forEach((_span, ordinal) => {
      const snippet = group.snippets[ordinal]
      if (snippet) flat.push({ id: group.id, ordinal, kind: nav?.kind ?? 'agent', turnIndex: nav?.turnIndex ?? 0, snippet })
    })
  }
  return flat
}

/** True when a mounted row's rendered match count disagrees with a group counted from source text. */
function needsRecount(sessionId: string, groups: readonly MessageMatchGroup[], query: string, matchCase: boolean, capped: boolean): boolean {
  const pane = getPane(sessionId)
  if (!pane) return false
  const rows = mountedRows(pane)
  return groups.some((group, position) => {
    const row = rows.get(group.id)
    if (group.origin !== 'source' || row === undefined) return false
    // The last group of a capped search was truncated, so it may legitimately render more.
    const truncated = capped && position === groups.length - 1
    const rendered = renderedRanges(row, query, matchCase, group.spans.length + 1).length
    return truncated ? rendered < group.spans.length : rendered !== group.spans.length
  })
}

export function useChatFind(sessionId: string, query: string, matchCase: boolean): ChatFind {
  const navLength = useChatNavStore((state) => (state.bySession[sessionId] ?? EMPTY_CHAT_NAV).index.length)
  const [settled, setSettled] = useState<Settled | null>(null)
  const [cursor, setCursor] = useState(-1)
  const [recountTick, setRecountTick] = useState(0)
  const cache = useRef(new LowerCaseCache())
  const abort = useRef<AbortController | null>(null)
  const cancelReveal = useRef<(() => void) | null>(null)
  // Opening the bar with a remembered query must not move the chat, so the opening key counts as handled.
  const lastSearchKey = useRef<string | null>(query === '' ? null : searchKeyOf(query, matchCase))
  const activated = useRef(false)
  const matchesRef = useRef<readonly FlatMatch[]>([])
  const inflight = useRef<Promise<RunResult> | null>(null)
  const pendingRun = useRef<{ timer: number; run(): Promise<RunResult> } | null>(null)
  const latest = useRef({ query, matchCase })
  latest.current = { query, matchCase }

  const matches = useMemo(() => (settled ? flatten(settled.groups, sessionId) : []), [settled, sessionId])
  const current = matches[cursor]

  const goTo = useCallback(
    (list: readonly FlatMatch[], index: number, force = false) => {
      const match = list[index]
      if (!match) return
      const previousId = list[cursorRef.current]?.id
      activated.current = true
      setCursor(index)
      cursorRef.current = index
      cancelReveal.current?.()
      const pane = getPane(sessionId)
      const row = pane ? mountedRows(pane).get(match.id) : undefined
      const sameMessage = !force && previousId === match.id && row !== undefined
      if (!sameMessage) {
        row?.removeAttribute(NAV_HIGHLIGHT_ATTRIBUTE)
        jumpToMessage(sessionId, match.id, { announce: false })
      }
      cancelReveal.current = revealMatchWhenLanded({
        sessionId,
        messageId: match.id,
        ordinal: match.ordinal,
        query: latest.current.query,
        matchCase: latest.current.matchCase,
        immediate: sameMessage
      })
    },
    [sessionId]
  )
  const cursorRef = useRef(cursor)
  cursorRef.current = cursor

  useEffect(() => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    const searchKey = searchKeyOf(query, matchCase)
    const keyChanged = lastSearchKey.current !== searchKey
    async function search(): Promise<RunResult> {
      pendingRun.current = null
      const entry = useChatNavStore.getState().bySession[sessionId] ?? EMPTY_CHAT_NAV
      const anchorId = entry.view.currentMessageId
      const anchor = anchorId === null ? 0 : Math.max(0, entry.index.findIndex((message) => message.id === anchorId))
      const outcome = await searchMessages({
        count: navLength,
        getMessage: messageReader(sessionId, navIndex(sessionId)),
        query,
        matchCase,
        cache: cache.current,
        anchor,
        signal: controller.signal
      })
      if (!outcome) return 'aborted'
      const flat = flatten(outcome.groups, sessionId)
      matchesRef.current = flat
      setSettled({ ...outcome, query, matchCase })
      lastSearchKey.current = searchKey
      if (!keyChanged) {
        if (cursorRef.current >= flat.length) {
          cursorRef.current = flat.length - 1
          setCursor(flat.length - 1)
        }
        return 'settled'
      }
      activated.current = false
      cursorRef.current = -1
      setCursor(-1)
      if (flat.length === 0) return 'settled'
      goTo(flat, startIndex(flat, sessionId), true)
      return 'jumped'
    }
    function run(): Promise<RunResult> {
      const promise = search().finally(() => {
        if (inflight.current === promise) inflight.current = null
      })
      inflight.current = promise
      return promise
    }
    if (query === '') {
      lastSearchKey.current = null
      activated.current = false
      matchesRef.current = []
      setSettled(null)
      setCursor(-1)
      cursorRef.current = -1
      return
    }
    const timer = window.setTimeout(() => void run(), keyChanged ? DEBOUNCE_MS : 0)
    pendingRun.current = { timer, run }
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query, matchCase, navLength, recountTick, sessionId, goTo])

  // Painting: reads rendered text, so it follows rows mounting and unmounting as the user scrolls.
  useEffect(() => {
    if (!settled || settled.query !== query || settled.matchCase !== matchCase) {
      clearPane(sessionId)
      return
    }
    let throttle: number | undefined
    function paint() {
      throttle = undefined
      const pane = getPane(sessionId)
      if (!pane || !settled) return
      if (needsRecount(sessionId, settled.groups, query, matchCase, settled.capped)) {
        setSettled(null)
        setRecountTick((value) => value + 1)
        return
      }
      const rows = mountedRows(pane)
      const others: Range[] = []
      let currentRange: Range | null = null
      let budget = MATCH_CAP
      for (const group of settled.groups) {
        const row = rows.get(group.id)
        if (!row || budget <= 0) continue
        const ranges = renderedRanges(row, query, matchCase, budget)
        budget -= ranges.length
        ranges.forEach((range, ordinal) => {
          if (group.id === current?.id && ordinal === current.ordinal) currentRange = range
          else others.push(range)
        })
      }
      paintPane(sessionId, others, currentRange)
    }
    paint()
    const viewport = getPane(sessionId)?.querySelector('[data-slot="message-scroller-viewport"]')
    if (!viewport) return
    const observer = new MutationObserver(() => {
      if (throttle === undefined) throttle = window.setTimeout(paint, PAINT_THROTTLE_MS)
    })
    observer.observe(viewport, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      window.clearTimeout(throttle)
    }
  }, [settled, current, query, matchCase, sessionId])

  useEffect(
    () => () => {
      abort.current?.abort()
      cancelReveal.current?.()
      clearPane(sessionId)
    },
    [sessionId]
  )

  const step = useCallback(
    (delta: number) => {
      const list = matchesRef.current
      if (list.length === 0) return
      if (!activated.current) {
        // First step after opening or after typing: begin at the visible message, not at the oldest match.
        const start = startIndex(list, sessionId)
        goTo(list, delta > 0 ? start : (start - 1 + list.length) % list.length, true)
        return
      }
      goTo(list, (cursorRef.current + delta + list.length) % list.length)
    },
    [goTo, sessionId]
  )

  const submit = useCallback(
    async (backward: boolean) => {
      const pending = pendingRun.current
      let result: RunResult = 'settled'
      if (pending) {
        window.clearTimeout(pending.timer)
        result = await pending.run()
      } else if (inflight.current) {
        result = await inflight.current
      }
      if (result !== 'settled') return
      step(backward ? -1 : 1)
    },
    [step]
  )

  let status = ''
  if (settled && settled.query === query && settled.matchCase === matchCase) {
    const more = settled.capped ? '+' : ''
    if (matches.length === 0) status = 'No matches'
    else if (cursor < 0) status = `${matches.length}${more} ${matches.length === 1 && !settled.capped ? 'match' : 'matches'}`
    else status = `${Math.min(cursor, matches.length - 1) + 1} of ${matches.length}${more}`
  }

  return {
    matches,
    cursor,
    capped: settled?.capped ?? false,
    status,
    next: () => step(1),
    previous: () => step(-1),
    select: (index) => goTo(matches, index),
    submit
  }
}
