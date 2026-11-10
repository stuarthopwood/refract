import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { useDraftStore, useRepositoriesStore, useSessionsStore } from '@/state'
import type { ItemSummary } from '../../../shared/ipc-item-refs'
import { hashOptionId, type HashPickerProps, type HashPickerStatus } from './HashPicker'
import { applyHashPick, parseHashTrigger } from './hashTrigger'

// Composer glue for the `#` picker (#1789). Self-contained so the composer only mounts it, routes
// keys to it and reads its combobox attributes.

const DEBOUNCE_MS = 150
/** Mirrors the backend's cap; a longer query is not a title worth searching for. */
const MAX_QUERY_CHARS = 64
const EMPTY_ROWS: readonly ItemSummary[] = []

type SearchState =
  | { key: string; status: 'ready'; rows: readonly ItemSummary[] }
  | { key: string; status: 'error'; message: string }

export interface UseHashPickerArgs {
  sessionId: string
  text: string
  textareaRef: RefObject<HTMLTextAreaElement | null>
  /** True while another composer menu (the slash menu) is showing; only one menu shows at a time. */
  suppressed: boolean
  disabled: boolean
  /** Called after an item replaced the typed `#query`, so the composer can drop a now-stale ghost suggestion. */
  onInserted(): void
}

export function useHashPicker({ sessionId, text, textareaRef, suppressed, disabled, onInserted }: UseHashPickerArgs) {
  const repositoryId = useSessionsStore((state) => state.sessions.find((session) => session.id === sessionId)?.repositoryId)
  // Only a Project with a GitHub remote has a repository to search (grill outcome 1).
  const hasGithubRepo = useRepositoriesStore((state) => {
    const remote = state.repositories.find((candidate) => candidate.id === repositoryId)?.remote
    return remote?.kind === 'has' && Boolean(remote.owner) && Boolean(remote.repo)
  })
  const [caret, setCaret] = useState<{ start: number; end: number } | null>(null)
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [search, setSearch] = useState<SearchState | null>(null)
  const [announcement, announce] = useClearedAnnouncement()
  const pickerId = `${sessionId}-hash-picker`

  // The trigger is decided from the text before the caret, so the caret is tracked alongside the text.
  useEffect(() => {
    const target = textareaRef.current
    if (!target) return
    const sync = (): void => {
      if (document.activeElement === target) setCaret({ start: target.selectionStart, end: target.selectionEnd })
    }
    const clear = (): void => setCaret(null)
    document.addEventListener('selectionchange', sync)
    target.addEventListener('blur', clear)
    target.addEventListener('focus', sync)
    sync()
    return () => {
      document.removeEventListener('selectionchange', sync)
      target.removeEventListener('blur', clear)
      target.removeEventListener('focus', sync)
    }
  }, [textareaRef])
  // Chromium does not always fire `selectionchange` for a typed character, so re-read after each text change.
  useEffect(() => {
    const target = textareaRef.current
    if (target && document.activeElement === target) setCaret({ start: target.selectionStart, end: target.selectionEnd })
  }, [text, textareaRef])

  const trigger = useMemo(() => {
    if (!caret || !hasGithubRepo || suppressed || disabled) return null
    const found = parseHashTrigger(text, caret.start, caret.end)
    return found && found.query.length <= MAX_QUERY_CHARS ? found : null
  }, [caret, hasGithubRepo, suppressed, disabled, text])
  const open = trigger !== null && dismissedFor !== text
  const query = trigger?.query ?? ''
  const searchKey = `${repositoryId ?? ''}\u0000${query}`

  useEffect(() => {
    if (!open || !repositoryId) return
    let stale = false
    // The first, empty-query list shows at once; typing waits for a pause.
    const timer = setTimeout(
      () => {
        window.refract.itemRefs
          .search(repositoryId, query)
          .then((result) => {
            if (stale) return // a newer query already took over
            setSearch(result.ok ? { key: searchKey, status: 'ready', rows: result.value } : { key: searchKey, status: 'error', message: result.error.message })
          })
          .catch(() => {
            if (!stale) setSearch({ key: searchKey, status: 'error', message: 'Could not search this repository.' })
          })
      },
      query === '' ? 0 : DEBOUNCE_MS
    )
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [open, repositoryId, query, searchKey])

  // A result for another key (or none yet) means the current query is still in flight.
  const current = search?.key === searchKey ? search : null
  const status: HashPickerStatus = current ? current.status : 'loading'
  const rows = current?.status === 'ready' ? current.rows : EMPTY_ROWS
  const errorMessage = current?.status === 'error' ? current.message : null
  const clampedIndex = rows.length > 0 ? Math.min(activeIndex, rows.length - 1) : 0

  useLayoutEffect(() => {
    setActiveIndex(0)
  }, [searchKey])

  useEffect(() => {
    if (!open || status !== 'ready') return
    announce(rows.length === 0 ? 'No matching items' : `${rows.length} ${rows.length === 1 ? 'result' : 'results'}`)
  }, [open, status, rows, announce])

  const select = useCallback(
    (item: ItemSummary): void => {
      if (!trigger) return
      const target = textareaRef.current
      const next = applyHashPick(text, trigger, target?.selectionStart ?? caret?.end ?? text.length, item.number)
      useDraftStore.getState().setText(sessionId, next.text)
      onInserted()
      // A controlled value resets the caret to the end; put it just after the inserted space.
      requestAnimationFrame(() => target?.setSelectionRange(next.caret, next.caret))
    },
    [trigger, textareaRef, text, caret, sessionId, onInserted]
  )

  /** True when the picker consumed the key. */
  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open) return false
    if (event.key === 'Escape') {
      event.preventDefault()
      setDismissedFor(text)
      return true
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (rows.length === 0) return false
      event.preventDefault()
      setActiveIndex(event.key === 'ArrowDown' ? Math.min(clampedIndex + 1, rows.length - 1) : Math.max(clampedIndex - 1, 0))
      return true
    }
    const picks = (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) && !event.ctrlKey && !event.altKey && !event.metaKey
    if (!picks || event.nativeEvent.isComposing) return false
    // Enter while the list is still loading must not send the half-typed `#query`.
    if (status === 'loading' && event.key === 'Enter') {
      event.preventDefault()
      return true
    }
    const item = rows[clampedIndex]
    if (!item) return false
    event.preventDefault()
    select(item)
    return true
  }

  const listShown = open && status === 'ready' && rows.length > 0
  const pickerProps: HashPickerProps = {
    id: pickerId,
    rows,
    status,
    errorMessage,
    activeIndex: clampedIndex,
    onSelect: select,
    onActiveIndexChange: setActiveIndex
  }
  return {
    open,
    pickerProps,
    announcement,
    handleKeyDown,
    /** Combobox attributes for the textarea while the list is shown, else all undefined. */
    expanded: listShown,
    controls: listShown ? pickerId : undefined,
    activeDescendant: listShown ? hashOptionId(pickerId, rows[clampedIndex]!) : undefined
  }
}
