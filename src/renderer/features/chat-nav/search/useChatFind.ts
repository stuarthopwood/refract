import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EMPTY_TRANSCRIPT, useTranscriptStore } from '@/state'
import { EMPTY_CHAT_NAV, useChatNavStore } from '@/state/chat-nav-store'
import { NAV_HIGHLIGHT_ATTRIBUTE } from '../highlightRow'
import { jumpToMessage } from '../jumpToMessage'
import { collectRowText, getPane, mountedRows, renderedRanges } from './findDom'
import {
  LowerCaseCache,
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
  /** Runs a pending debounced search now (Enter pressed before it fired). */
  flush(): void
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
function needsRecount(sessionId: string, groups: readonly MessageMatchGroup[], query: string, matchCase: boolean): boolean {
  const pane = getPane(sessionId)
  if (!pane) return false
  const rows = mountedRows(pane)
  return groups.some((group) => {
    const row = rows.get(group.id)
    return group.origin === 'source' && row !== undefined && renderedRanges(row, query, matchCase).length !== group.spans.length
  })
}

export function useChatFind(sessionId: string, query: string, matchCase: boolean): ChatFind {
  const navLength = useChatNavStore((state) => (state.bySession[sessionId] ?? EMPTY_CHAT_NAV).index.length)
  const [settled, setSettled] = useState<Settled | null>(null)
  const [cursor, setCursor] = useState(0)
  const [recountTick, setRecountTick] = useState(0)
  const cache = useRef(new LowerCaseCache())
  const abort = useRef<AbortController | null>(null)
  const cancelReveal = useRef<(() => void) | null>(null)
  const lastSearchKey = useRef<string | null>(null)
  const pendingRun = useRef<{ timer: number; run(): void } | null>(null)
  const latest = useRef({ query, matchCase })
  latest.current = { query, matchCase }

  const matches = useMemo(() => (settled ? flatten(settled.groups, sessionId) : []), [settled, sessionId])
  const current = matches[cursor]

  const goTo = useCallback(
    (list: readonly FlatMatch[], index: number) => {
      const match = list[index]
      if (!match) return
      setCursor(index)
      cancelReveal.current?.()
      const pane = getPane(sessionId)
      const row = pane ? mountedRows(pane).get(match.id) : undefined
      const sameMessage = list[cursorRef.current]?.id === match.id && row !== undefined
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
    const searchKey = `${query}\u0000${matchCase}`
    const queryChanged = lastSearchKey.current !== searchKey
    lastSearchKey.current = searchKey
    async function run() {
      pendingRun.current = null
      const outcome = await searchMessages({
        count: navLength,
        getMessage: messageReader(sessionId, navIndex(sessionId)),
        query,
        matchCase,
        cache: cache.current,
        signal: controller.signal
      })
      if (!outcome) return
      setSettled({ ...outcome, query, matchCase })
      if (!queryChanged) return
      const flat = flatten(outcome.groups, sessionId)
      setCursor(0)
      cursorRef.current = 0
      if (flat.length > 0) goTo(flat, 0)
    }
    if (query === '') {
      setSettled(null)
      setCursor(0)
      return
    }
    const timer = window.setTimeout(() => void run(), queryChanged ? DEBOUNCE_MS : 0)
    pendingRun.current = { timer, run: () => void run() }
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
      if (needsRecount(sessionId, settled.groups, query, matchCase)) {
        setSettled(null)
        lastSearchKey.current = `${query}\u0000${matchCase}`
        setRecountTick((value) => value + 1)
        return
      }
      const rows = mountedRows(pane)
      const others: Range[] = []
      let currentRange: Range | null = null
      for (const group of settled.groups) {
        const row = rows.get(group.id)
        if (!row) continue
        renderedRanges(row, query, matchCase).forEach((range, ordinal) => {
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
      if (matches.length === 0) return
      goTo(matches, (cursorRef.current + delta + matches.length) % matches.length)
    },
    [matches, goTo]
  )

  let status = ''
  if (settled && settled.query === query && settled.matchCase === matchCase) {
    status = matches.length === 0 ? 'No matches' : `${Math.min(cursor, matches.length - 1) + 1} of ${matches.length}${settled.capped ? '+' : ''}`
  }

  return {
    matches,
    cursor,
    capped: settled?.capped ?? false,
    status,
    next: () => step(1),
    previous: () => step(-1),
    select: (index) => goTo(matches, index),
    flush: () => {
      const pending = pendingRun.current
      if (!pending) return
      window.clearTimeout(pending.timer)
      pending.run()
    }
  }
}
