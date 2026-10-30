// Issue #700/#701 slice (a), decision record item 5: the pinned todo panel -- the live-updating
// tree for THIS Session, mounted in `ChatPane.tsx` directly above the composer (where the #687
// current-work banner will eventually sit; #687 itself is still `todo`, per `docs/PLAN.md`) only
// while `useTodoPinStore`'s per-Session `pinned` flag is set.
import { useLayoutEffect, useRef, useState } from 'react'
import { PinOffIcon } from 'lucide-react'
import { EMPTY_READOUT_ENTRY, useReadoutStore, useTodoPinStore } from '@/state'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ComposerPanel, ComposerPanelBody } from '@/components/ComposerPanel'
import { isFocusStranded } from '@/lib/focus'
import { COMPOSER_BUTTON_FOCUS_CLASS } from './pickerShared'
import { currentTaskKeyOf, TodoPhaseGroup } from './readout/TodoTree'
import { deriveCurrentTask, deriveTodoTotals, hasTodoPlan, isTodoAllDone } from './readout/todoDerive'

export function PinnedTodoPanel({ sessionId }: { sessionId: string }) {
  const todoTree = useReadoutStore((s) => (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.todoTree)
  const pinned = useTodoPinStore((s) => s.pinnedBySession[sessionId] ?? false)
  const collapsed = useTodoPinStore((s) => s.collapsedBySession[sessionId] ?? false)
  const setCollapsed = useTodoPinStore((s) => s.setCollapsed)
  const setPinned = useTodoPinStore((s) => s.setPinned)

  const rootRef = useRef<HTMLElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  // `userScrolledRef` now latches only on real user intent (wheel, pointerdown, or a key, attached
  // directly to the list); the follow itself sets `list.scrollTop` directly (never
  // `scrollIntoView`, which walks up and can scroll an ANCESTOR -- the transcript, the whole window
  // -- not just this list).
  const userScrolledRef = useRef(false)
  const found = deriveCurrentTask(todoTree)
  const currentTaskKey = found ? currentTaskKeyOf(found.phaseIndex, found.taskIndex) : null

  const panelRenders = pinned && hasTodoPlan(todoTree)
  const panelRendersRef = useRef(panelRenders)
  panelRendersRef.current = panelRenders
  const active = panelRenders && !collapsed

  // Resets on the false -> true edge of `active` (covers mount, expand, and re-pin in one place,
  // never on every render).
  const wasActiveRef = useRef(false)
  useLayoutEffect(() => {
    if (active && !wasActiveRef.current) {
      userScrolledRef.current = false
    }
    wasActiveRef.current = active
  }, [active])

  useLayoutEffect(() => {
    if (userScrolledRef.current) return
    if (currentTaskKey === null) return
    const list = listRef.current
    const el = list?.querySelector<HTMLElement>('[data-current-task="true"]')
    if (!list || !el) return
    const listRect = list.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const elTop = elRect.top - listRect.top + list.scrollTop
    const elBottom = elTop + elRect.height
    if (elRect.height > list.clientHeight) {
      if (list.scrollTop !== elTop) list.scrollTop = elTop
    } else {
      if (elTop < list.scrollTop) list.scrollTop = elTop
      else if (elBottom > list.scrollTop + list.clientHeight) list.scrollTop = elBottom - list.clientHeight
    }
  })

  // When everything is done, the panel collapses to a one-line summary.
  const allDone = isTodoAllDone(todoTree)
  const wasAllDoneRef = useRef(false)
  useLayoutEffect(() => {
    if (allDone && !wasAllDoneRef.current) setCollapsed(sessionId, true)
    if (!allDone && wasAllDoneRef.current) setCollapsed(sessionId, false)
    wasAllDoneRef.current = allDone
  }, [allDone, sessionId, setCollapsed])

  // Keyboard-scrollable list (Main P9): `tabIndex` only while the list genuinely overflows its own
  // `max-h` cap -- an empty or short list is not its own extra Tab stop.
  const [overflowing, setOverflowing] = useState(false)
  useLayoutEffect(() => {
    const list = listRef.current
    setOverflowing(!!list && list.scrollHeight > list.clientHeight)
  })

  // THIS component never unmounts itself (`ChatPane.tsx` always renders it); only its OWN internal
  // `<section>` conditionally disappears, so any check that reads `rootRef.current` -- in the
  // cleanup OR in an effect body that could itself be re-run on the SAME commit that removes the
  // section -- risks reading a ref React has already detached.
  const focusWasInsideRef = useRef(false)
  useLayoutEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const panel = document.getElementById(`todo-panel-${sessionId}`)
      focusWasInsideRef.current = !!(panel && event.target instanceof Node && panel.contains(event.target))
    }
    document.addEventListener('focusin', onFocusIn, true)
    return () => document.removeEventListener('focusin', onFocusIn, true)
  }, [sessionId])

  // Split into two edge-triggered effects instead of one keyed on `active` (which conflated "the
  // panel itself disappeared" with "only the list closed"): this one fires only on the panel's OWN
  // true -> false edge (Unpin, or the plan vanishing), restoring focus to the pill -- or, if the
  // pill itself is hidden in Settings, THIS pane's own composer (MEDIUM 3: scoped by
  // `data-session-pane`, never a different split pane's).
  useLayoutEffect(() => {
    return () => {
      if (!focusWasInsideRef.current) return
      requestAnimationFrame(() => {
        if (!isFocusStranded(document.activeElement, null)) return
        const pill = document.querySelector(`[data-todo-pin-hook="${CSS.escape(sessionId)}"]`)
        if (pill instanceof HTMLElement) {
          pill.focus({ preventScroll: true })
          return
        }
        document.querySelector<HTMLElement>(`[data-session-pane="${CSS.escape(sessionId)}"] [aria-label="Message"]`)?.focus({ preventScroll: true })
      })
    }
  }, [panelRenders, sessionId])

  // The list closing while the panel ITSELF stays mounted (a manual Collapse, or the "All N done"
  // auto-collapse) -- focus the panel's own Collapse chevron instead, never the pill (nothing here
  // removed it).
  useLayoutEffect(() => {
    return () => {
      if (!focusWasInsideRef.current) return
      if (!panelRendersRef.current) return
      requestAnimationFrame(() => {
        if (!isFocusStranded(document.activeElement, null)) return
        document.getElementById(`todo-panel-${sessionId}`)?.querySelector<HTMLElement>('[aria-label="Todo list details"]')?.focus({ preventScroll: true })
      })
    }
  }, [active, sessionId])

  if (!pinned) return null
  if (!hasTodoPlan(todoTree)) return null
  const totals = deriveTodoTotals(todoTree)
  if (!totals) return null // unreachable given hasTodoPlan above; keeps TS narrowed without a cast
  const currentTask = found?.task ?? null
  const panelId = `todo-panel-${sessionId}`
  const listId = `${panelId}-list`

  return (
    <ComposerPanel
      rootRef={rootRef}
      id={panelId}
      slot="pinned-todo-panel"
      label="Todo list"
      toggleLabel="Todo list details"
      title={allDone ? `All ${totals.total} done` : currentTask ? `Todo ${totals.done}/${totals.total} \u00b7 ${currentTask.content}` : `Todo ${totals.done}/${totals.total}`}
      titleHint={currentTask ? currentTask.content : undefined}
      collapsed={collapsed}
      onToggle={() => setCollapsed(sessionId, !collapsed)}
      bodyId={listId}
      actions={
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Unpin todo list"
              aria-describedby={undefined}
              className={COMPOSER_BUTTON_FOCUS_CLASS}
              onClick={() => setPinned(sessionId, false)}
            >
              <PinOffIcon aria-hidden className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Unpin todo list</TooltipContent>
        </Tooltip>
      }
    >
      <ComposerPanelBody
        ref={listRef}
        id={listId}
        role="group"
        aria-label="Todo task list"
        tabIndex={overflowing ? 0 : undefined}
        onWheel={() => {
          userScrolledRef.current = true
        }}
        onPointerDown={() => {
          userScrolledRef.current = true
        }}
        onKeyDown={() => {
          userScrolledRef.current = true
        }}
        className="px-4 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
      >
        {todoTree.map((phase, phaseIndex) => (
          <TodoPhaseGroup key={phaseIndex} phase={phase} phaseIndex={phaseIndex} showHeader={todoTree.length > 1} currentTaskKey={currentTaskKey} />
        ))}
      </ComposerPanelBody>
    </ComposerPanel>
  )
}
