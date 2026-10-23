// Issue #700/#701 slice (a), decision record item 5: the pinned todo panel -- the live-updating
// tree for THIS Session, mounted in `ChatPane.tsx` directly above the composer (where the #687
// current-work banner will eventually sit; #687 itself is still `todo`, per `docs/PLAN.md`) only
// while `useTodoPinStore`'s per-Session `pinned` flag is set. The Todo pill
// (`ReadoutChips.tsx`'s `TodoProgressChip`) toggles that flag; this panel's own header carries
// the reverse Unpin control too, since the pill itself can be hidden in Settings (`sessionReadout
// ['todo-progress']`). Unmounts entirely once there is no plan at all (`hasTodoPlan` false), but
// the pin flag itself survives into the next plan (decision item 5: "the pin stays") -- this
// component only ever reads `pinned`, never clears it. `ChatPane.tsx` renders this with
// `key={`todo-${sessionId}`}`, so every ref below starts fresh on a Session switch (gate round
// 1, Main P1).
import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronDownIcon, PinOffIcon } from 'lucide-react'
import { EMPTY_READOUT_ENTRY, useReadoutStore, useTodoPinStore } from '@/state'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isFocusStranded } from '@/lib/focus'
import { cn } from '@/lib/utils'
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
  // Decision item 5: "follows the in-progress task... only when that task changes, and stops
  // once the user scrolls" -- gate round 1 fix (Main P1): the OLD `onScroll` handler latched on
  // ANY scroll, including the one this effect itself causes, so the very first follow permanently
  // disabled every later one. `userScrolledRef` now latches only on real user intent (wheel,
  // pointerdown, or a key, attached directly to the list); the follow itself sets `list.scrollTop`
  // directly (never `scrollIntoView`, which walks up and can scroll an ANCESTOR -- the transcript,
  // the whole window -- not just this list).
  //
  // Gate round 7 fix (self-caught live-check failure, #700 E4): this used to also skip re-running
  // whenever `currentTaskKey` matched a `lastFollowedKeyRef` recorded on an earlier render. That
  // broke the moment a row ABOVE the current task changed height without the current task itself
  // changing -- e.g. `todo-6` blocks "Update docs" (adding its "Blocked: <blocker>" line) 300ms
  // after `todo-5` already followed "Task 9" into view; the extra line pushes every later row down,
  // but the key-match guard silently skipped the re-check, leaving "Task 9" partly scrolled out of
  // view with no way to recover (the key never changes again until the task itself does). There is
  // no equivalent risk from running the full containment check every render: it is a pure read plus
  // a conditional write, a no-op scrollTop assignment when the row is already fully in view, so
  // nothing to recompute away via a key cache in the first place.
  const userScrolledRef = useRef(false)
  const found = deriveCurrentTask(todoTree)
  const currentTaskKey = found ? currentTaskKeyOf(found.phaseIndex, found.taskIndex) : null

  const panelRenders = pinned && hasTodoPlan(todoTree)
  // Gate round 6 fix (#700, Main HIGH 1): kept in sync with the LATEST render's own
  // `panelRenders` by a plain write during render (not inside an effect) -- React always runs
  // render before any effect or cleanup for the SAME commit, so both focus-restore effects'
  // cleanups below see this commit's true value, never a stale one from the previous render.
  const panelRendersRef = useRef(panelRenders)
  panelRendersRef.current = panelRenders
  const active = panelRenders && !collapsed

  // Gate round 1 fix (Main P1): "re-run the follow on mount, expand and re-pin" -- this component
  // never fully unmounts between pin/unpin or collapse/expand (the SAME instance just returns
  // `null` or stale state), so a stale `userScrolledRef` from a PRIOR pinned-and-expanded stretch
  // would otherwise silently suppress the very first follow of a fresh one. Resets on the false ->
  // true edge of `active` (covers mount, expand, and re-pin in one place, never on every render).
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
    // Gate round 3 fix (Main's diagnosis, #700 E4, traced live): `el.offsetTop`/`offsetHeight`
    // are relative to `el.offsetParent` -- the NEAREST POSITIONED ancestor (or <body>), never
    // just "the nearest scrollable one". Nothing between this `<li>` and the list div carries a
    // `position` utility, so `offsetParent` skipped the list entirely and landed on some distant
    // ancestor; comparing that unrelated coordinate space against `list.scrollTop`/`clientHeight`
    // produced a nonsense target (bigger than the list's own `scrollHeight`), which the browser
    // then silently clamped to `scrollHeight - clientHeight` on write -- reproducing on every
    // run regardless of which task was current. `getBoundingClientRect()` is always viewport-
    // relative, so subtracting the list's own rect (plus its current scrollTop) gives the row's
    // true offset within the LIST's own scrolled content, independent of any ancestor's position.
    const listRect = list.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const elTop = elRect.top - listRect.top + list.scrollTop
    const elBottom = elTop + elRect.height
    // Gate round 6 fix (#700, Main MEDIUM 5): a row taller than the list itself (a long wrapped
    // blocker line) can never satisfy the full-containment check below -- align its own top
    // instead (the best available fit).
    if (elRect.height > list.clientHeight) {
      if (list.scrollTop !== elTop) list.scrollTop = elTop
    } else {
      if (elTop < list.scrollTop) list.scrollTop = elTop
      else if (elBottom > list.scrollTop + list.clientHeight) list.scrollTop = elBottom - list.clientHeight
    }
  })

  // Decision item 5: "When everything is done, it collapses to... All N done". A ONE-TIME
  // automatic action (gate round 1 fix, Main P2: the render must actually HIDE the list, not
  // just swap the header text while it stays visible) -- collapses exactly once on the
  // false -> true edge of all-done, leaving `collapsed` as an ordinary toggle afterward so "the
  // user can expand again" still works normally.
  const allDone = isTodoAllDone(todoTree)
  const wasAllDoneRef = useRef(false)
  useLayoutEffect(() => {
    if (allDone && !wasAllDoneRef.current) setCollapsed(sessionId, true)
    // Gate round 6 fix (#700, Main MEDIUM 6): the all-done auto-collapse must not stay sticky
    // once the plan genuinely changes (a new task added, or a task leaving done re-extends the
    // plan) -- the false -> true edge above re-collapses; this expands it back on the
    // true -> false edge, so a new or extended plan is never left silently hidden.
    if (!allDone && wasAllDoneRef.current) setCollapsed(sessionId, false)
    wasAllDoneRef.current = allDone
  }, [allDone, sessionId, setCollapsed])

  // Keyboard-scrollable list (Main P9): `tabIndex` only while the list genuinely overflows its
  // own `max-h` cap -- an empty or short list is not its own extra Tab stop.
  const [overflowing, setOverflowing] = useState(false)
  useLayoutEffect(() => {
    const list = listRef.current
    setOverflowing(!!list && list.scrollHeight > list.clientHeight)
  })

  // Gate round 1 fix (Main P3, the #900 focus-intent pattern, `useFocusSearchOnStrandedUnmount.ts`
  // precedent): Unpin and the plan vanishing both unmount whichever button/row currently holds
  // focus inside this panel, which would otherwise strand it on `<body>`.
  //
  // Gate round 2 fix (self-caught live-check failure: P3's own assertion failed, "actual false",
  // twice -- the first retry still kept a direct `rootRef.current` read inside the tracking
  // effect's OWN setup, which is just as exposed to the same ordering hazard on whichever commit
  // removes the section): the precedent hook's cleanup fires on a REAL fiber deletion
  // (`useFocusSearchOnStrandedUnmount` is called by a component -- `SessionRow`/`RepositoryGroup`
  // -- that is itself removed from the tree), where React still has the deleted subtree's own
  // refs attached when it runs that fiber's own effect cleanup. THIS component never unmounts
  // itself (`ChatPane.tsx` always renders it); only its OWN internal `<section>` conditionally
  // disappears, so any check that reads `rootRef.current` -- in the cleanup OR in an effect body
  // that could itself be re-run on the SAME commit that removes the section -- risks reading a
  // ref React has already detached. `focusWasInsideRef` instead listens on `document` (attached
  // once, for this component instance's whole lifetime, independent of the section's own mount
  // state) and re-derives the panel by id from the event's own target on every `focusin`, never
  // dereferencing `rootRef` at all.
  const focusWasInsideRef = useRef(false)
  useLayoutEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const panel = document.getElementById(`todo-panel-${sessionId}`)
      focusWasInsideRef.current = !!(panel && event.target instanceof Node && panel.contains(event.target))
    }
    document.addEventListener('focusin', onFocusIn, true)
    return () => document.removeEventListener('focusin', onFocusIn, true)
  }, [sessionId])

  // Gate round 6 fix (#700, Main HIGH 1, self-caught by the final gate's own A11y review):
  // unpinning from a COLLAPSED panel (including right after the "All N done" auto-collapse)
  // read `active` as ALREADY false, so the single effect this used to be never fired at all --
  // focus fell straight to `<body>`. Split into two edge-triggered effects instead of one keyed
  // on `active` (which conflated "the panel itself disappeared" with "only the list closed"):
  // this one fires only on the panel's OWN true -> false edge (Unpin, or the plan vanishing),
  // restoring focus to the pill -- or, if the pill itself is hidden in Settings, THIS pane's own
  // composer (MEDIUM 3: scoped by `data-session-pane`, never a different split pane's). LOW 10:
  // finds the pill via a stable `data-` hook, not `aria-controls` -- that attribute is now only
  // rendered while pinned (`ReadoutChip.tsx`), so by the time this cleanup runs, `pinned` has
  // already flipped and `aria-controls` is already gone from the DOM.
  useLayoutEffect(() => {
    return () => {
      if (!focusWasInsideRef.current) return
      requestAnimationFrame(() => {
        if (!isFocusStranded(document.activeElement, null)) return
        const pill = document.querySelector(`[data-todo-pin-hook="${CSS.escape(sessionId)}"]`)
        if (pill instanceof HTMLElement) {
          // Gate round 3 fix (Main's diagnosis, #700 E4): a plain `.focus()` here (no
          // `preventScroll`) lets the browser scroll this focus target into view, which can
          // disturb an unrelated scrollable ancestor's own position -- neither focus-restore
          // target is inside the todo list itself, so nothing here should ever move ITS scroll.
          pill.focus({ preventScroll: true })
          return
        }
        document.querySelector<HTMLElement>(`[data-session-pane="${CSS.escape(sessionId)}"] [aria-label="Message"]`)?.focus({ preventScroll: true })
      })
    }
  }, [panelRenders, sessionId])

  // The list closing while the panel ITSELF stays mounted (a manual Collapse, or the "All N
  // done" auto-collapse) -- focus the panel's own Collapse chevron instead, never the pill
  // (nothing here removed it). Skips entirely when the panel is ALSO disappearing in the SAME
  // commit (the effect above owns that case), read from `panelRendersRef`'s just-rendered value.
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
    <section
      ref={rootRef}
      id={panelId}
      data-slot="pinned-todo-panel"
      aria-label="Todo list"
      aria-live="off"
      className="shrink-0 border-t border-divider px-4 py-2"
    >
      <div className="flex h-6 items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={currentTask ? currentTask.content : undefined}>
          {allDone ? `All ${totals.total} done` : currentTask ? `Todo ${totals.done}/${totals.total} \u00b7 ${currentTask.content}` : `Todo ${totals.done}/${totals.total}`}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-expanded={!collapsed}
              aria-controls={listId}
              aria-label="Todo list details"
              aria-describedby={undefined}
              className={cn('aria-expanded:bg-transparent aria-expanded:text-muted-foreground', COMPOSER_BUTTON_FOCUS_CLASS)}
              onClick={() => setCollapsed(sessionId, !collapsed)}
            >
              <ChevronDownIcon aria-hidden className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Todo list details</TooltipContent>
        </Tooltip>
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
              <PinOffIcon aria-hidden className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Unpin todo list</TooltipContent>
        </Tooltip>
      </div>
      {!collapsed && (
        <div
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
          className="mt-1 max-h-[min(12rem,30vh)] overflow-y-auto [overflow-anchor:none] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
        >
          {todoTree.map((phase, phaseIndex) => (
            <TodoPhaseGroup key={phaseIndex} phase={phase} phaseIndex={phaseIndex} showHeader={todoTree.length > 1} currentTaskKey={currentTaskKey} />
          ))}
        </div>
      )}
    </section>
  )
}
