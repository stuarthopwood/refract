// Quiet alert rows (issue #560, spec 001 FR-037/FR-072; spec 008 FR-029): two single-line
// notices rendered as App.tsx siblings directly after <ProfileItem/>, in the session-list
// column's own 'flex h-full flex-col' wrapper (SessionList.tsx:397-400, #567 decision 20,
// already reserved this render order). Replaces StatusBar.tsx's own low-memory and omp-version
// Popovers -- the footer (StatusBar.tsx) keeps only its update-availability badge.
//
// Each row: an icon, short text, one text action, and a small dismiss control. "Announced once"
// means once per appearance (including a post-dismiss recurrence after a restart): a flag per
// alert tracks whether it was already showing on the previous render, and the announce effect
// below only fires on a hidden -> shown transition.
//
// Quality-gate remediation (round 1, four reviewers): this component is mounted inside App.tsx's
// collapsible nav column (`inert`/`aria-hidden` while `navCollapsed`), so a LOCAL `aria-live`
// region here is silenced whenever the nav is collapsed -- a screen reader would never hear an
// alert that first appears in that state. Announcements now go through `useChatAreaAnnouncer`
// (the same always-mounted, never-hidden app-level region `quickCreateFallback.ts` already uses
// from outside a component), not a local `useClearedAnnouncement` region. The two conditions can
// also both become true in the SAME commit (e.g. on first mount, if a low-memory warning has
// already arrived by the time the omp-version warning is set) -- announcing them from two
// separate effects would race (`announce()` clears the other's still-pending text), so one
// effect below watches both and joins them into a single announcement when both transition
// together.
//
// Quality-gate remediation (round 2, five-reviewer gate on PR #945):
// 1. Dismissal and the hidden->shown "was shown" tracking moved out of this component's own
//    local `useState`/`useRef` into `useAlertDismissStore` (non-persisted, matches
//    `memory-store.ts`'s own convention) -- the review wanted it store-backed regardless of this
//    component's own remount lifetime.
// 2. A row that disappears -- by its own condition clearing OR by Dismiss -- while focus was
//    inside it now redirects focus to the OTHER row's own action button if still shown, else
//    `focusProfileItemName()`. Detected via a native `focusout` listener on each row's own
//    container: when a focused descendant is removed from the DOM, the browser synchronously
//    blurs it (to `<body>`) as part of the SAME removal step, before React's commit phase ends --
//    `relatedTarget` lets a normal Tab-away (focus moving to some other real element) fall
//    through untouched, so only a genuine "focus got lost" case redirects.
// 3. The four action/dismiss buttons carry `COMPOSER_BUTTON_FOCUS_CLASS` (pickerShared.tsx's own
//    forced-colors-safe focus-visible treatment) instead of inventing a new one; the link-style
//    Triage/Check buttons swap `h-auto p-0` for `Markdown.tsx`'s own "show source" button
//    convention (`-mx-1 px-1 py-1`) so the focus-visible outline has room to render unclipped.
// 4. Visual polish (ui-architect-v3 consensus): only the icon and the action keep the amber
//    `text-state-needs-you` token; the descriptive label is `text-muted-foreground` (quieter);
//    the action carries a persistent `underline` (not just on hover); the dismiss icon button
//    gets a `Tooltip`; both rows gain a `pl-2` to align their icon with `ProfileItem.tsx`'s own
//    avatar column (that button's own `px-2` sits inside this component's `px-2` container); the
//    omp-version row's text wraps instead of truncating (its version string is open-ended --
//    the low-memory row's own text stays bounded and keeps truncating).
// 5. "Low memory" no longer states a Session count: `warning.liveAgents`
//    (`shell/memory.rs::live_agent_count`) counts every non-stopped agent (idle, working, AND
//    needs-you), while the Triage dialog only ever lists idle ones -- the two numbers can
//    legitimately differ, so stating one as if it promised what Triage would list was
//    misleading. The row now just says "Low memory"; Triage itself states exactly how many idle
//    agents it found.
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { focusProfileItemName } from '@/lib/focus'
import { cn } from '@/lib/utils'
import { AlertTriangleIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { COMPOSER_BUTTON_FOCUS_CLASS } from '@/features/chat/pickerShared'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { useAlertDismissStore, useHealthStore, useMemoryStore } from '@/state'
import { HealthCheckDialog } from './HealthCheckDialog'
import { MemoryTriageDialog } from './MemoryTriageDialog'

/** One quiet alert row: an icon, a quieter label, one amber text action, and a dismiss button.
 *  Extracted (quality-gate remediation, round 2) since the memory and omp-version rows were
 *  otherwise near-identical. */
interface AlertRowProps {
  containerRef: RefObject<HTMLDivElement | null>
  label: string
  /** The low-memory row's own text stays bounded and keeps truncating; the omp-version row's
   *  embeds an arbitrary version string and needs to wrap instead (item 11). */
  wrapLabel?: boolean
  actionRef: RefObject<HTMLButtonElement | null>
  actionLabel: string
  actionAriaLabel: string
  onAction(): void
  dismissAriaLabel: string
  dismissTooltip: string
  onDismiss(): void
}

function AlertRow({
  containerRef,
  label,
  wrapLabel,
  actionRef,
  actionLabel,
  actionAriaLabel,
  onAction,
  dismissAriaLabel,
  dismissTooltip,
  onDismiss
}: AlertRowProps) {
  return (
    <div ref={containerRef} className="flex h-6 items-center gap-1.5 pl-2 text-xs">
      <AlertTriangleIcon aria-hidden className="size-3 shrink-0 text-state-needs-you" />
      <span className={cn('min-w-0 flex-1 text-muted-foreground', wrapLabel ? 'whitespace-normal' : 'truncate')}>{label}</span>
      <Button
        ref={actionRef}
        type="button"
        variant="link"
        size="xs"
        aria-label={actionAriaLabel}
        className={cn(COMPOSER_BUTTON_FOCUS_CLASS, '-mx-1 h-auto px-1 py-1 text-state-needs-you underline')}
        onClick={onAction}
      >
        {actionLabel}
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={dismissAriaLabel}
            className={cn(COMPOSER_BUTTON_FOCUS_CLASS, 'text-state-needs-you hover:text-state-needs-you')}
            onClick={onDismiss}
          >
            <XIcon aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{dismissTooltip}</TooltipContent>
      </Tooltip>
    </div>
  )
}

export function ProfileAlertRows() {
  const warning = useMemoryStore((state) => state.warning)
  const ompVersionWarning = useHealthStore((state) => state.ompVersionWarning)
  const memoryDismissed = useAlertDismissStore((state) => state.memoryDismissed)
  const ompVersionDismissed = useAlertDismissStore((state) => state.ompVersionDismissed)
  const memoryWasShown = useAlertDismissStore((state) => state.memoryWasShown)
  const ompVersionWasShown = useAlertDismissStore((state) => state.ompVersionWasShown)
  const dismissMemory = useAlertDismissStore((state) => state.dismissMemory)
  const dismissOmpVersion = useAlertDismissStore((state) => state.dismissOmpVersion)
  const setMemoryWasShown = useAlertDismissStore((state) => state.setMemoryWasShown)
  const setOmpVersionWasShown = useAlertDismissStore((state) => state.setOmpVersionWasShown)

  const [triageOpen, setTriageOpen] = useState(false)
  const [healthOpen, setHealthOpen] = useState(false)

  const triageButtonRef = useRef<HTMLButtonElement>(null)
  const checkButtonRef = useRef<HTMLButtonElement>(null)
  const memoryRowRef = useRef<HTMLDivElement>(null)
  const ompVersionRowRef = useRef<HTMLDivElement>(null)

  const memoryShown = warning !== null && !memoryDismissed
  const ompVersionShown = ompVersionWarning !== null && !ompVersionDismissed

  useEffect(() => {
    const memoryJustShown = memoryShown && !memoryWasShown
    const ompVersionJustShown = ompVersionShown && !ompVersionWasShown
    const memoryText = 'Low memory'
    const ompVersionText = ompVersionWarning ? `omp ${ompVersionWarning.found} is an unverified version` : ''
    if (memoryJustShown && ompVersionJustShown) {
      useChatAreaAnnouncer.getState().announce(`${memoryText}. ${ompVersionText}`)
    } else if (memoryJustShown) {
      useChatAreaAnnouncer.getState().announce(memoryText)
    } else if (ompVersionJustShown) {
      useChatAreaAnnouncer.getState().announce(ompVersionText)
    }
    if (memoryShown !== memoryWasShown) setMemoryWasShown(memoryShown)
    if (ompVersionShown !== ompVersionWasShown) setOmpVersionWasShown(ompVersionShown)
  }, [memoryShown, ompVersionShown, memoryWasShown, ompVersionWasShown, ompVersionWarning, setMemoryWasShown, setOmpVersionWasShown])

  /** Item 2 (gate round 2, UI/A11y): redirects focus away from a row that just disappeared,
   *  to the OTHER row's own action button if it's still shown, else the profile item's name. */
  function redirectFocusFrom(hiddenRow: 'memory' | 'ompVersion'): void {
    const fallbackButton = hiddenRow === 'memory' ? checkButtonRef.current : triageButtonRef.current
    const fallbackShown = hiddenRow === 'memory' ? ompVersionShown : memoryShown
    if (fallbackShown && fallbackButton?.isConnected) {
      fallbackButton.focus()
      return
    }
    focusProfileItemName()
  }

  // Gate round 2 (Code FAIL, second finding): a row dismissed via KEYBOARD activation (Enter on
  // a Tooltip-wrapped Dismiss button) could leave focus on a disconnected, unnamed node instead
  // of the intended fallback -- confirmed live (verify-tauri-560.mjs), still reproducing after a
  // single-rAF recheck: the Tooltip's own Portal content (still mounted while its trigger had
  // keyboard focus-visible) can re-steal focus on ITS OWN delayed unmount, over more than one
  // frame. React 19 focus-handoff pattern: `handleFocusOut` below only RECORDS intent (never
  // calls `.focus()` directly); a `requestAnimationFrame` loop then re-applies it EVERY frame
  // for up to 500ms, each time focus is STILL confirmed stranded (disconnected, or fallen back
  // to `<body>`) -- stopping the moment it lands on something real, whether ours or a genuinely
  // different destination something else legitimately claimed. Outlasts a delayed library
  // cleanup instead of losing a one-shot race against it; never left pending past its own
  // 500ms budget.
  const pendingFocusHandoffRef = useRef<(() => void) | null>(null)
  function scheduleFocusHandoff(apply: () => void): void {
    pendingFocusHandoffRef.current = apply
    // 500ms: comfortably past this app's own longest documented transition (panel open/close,
    // up to 200ms, docs/PLAN.md "Motion and focus"), so a delayed library cleanup can never
    // outlast this retry window.
    const deadline = performance.now() + 500
    function tick(): void {
      const pending = pendingFocusHandoffRef.current
      if (!pending) return
      const active = document.activeElement
      const stranded = !active || active === document.body || !active.isConnected
      if (!stranded) {
        pendingFocusHandoffRef.current = null
        return
      }
      pending()
      if (performance.now() >= deadline) {
        pendingFocusHandoffRef.current = null
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  // Watches each row's own container for a `focusout` caused by the FOCUSED DESCENDANT itself
  // being removed from the DOM (the browser blurs it to `<body>` synchronously as part of that
  // same removal step, before this row's own `focusout` listener is torn down) -- covers BOTH
  // triggers item 2 names: the row's own condition clearing on its own, and the user clicking
  // Dismiss (which removes the row the same way). A normal Tab-away is never affected:
  // `relatedTarget` there is the real next focusable element, not `null`/outside the row.
  //
  // Gate round 2 (Code FAIL): `document.activeElement === document.body` alone is NOT a removal
  // signal -- an ordinary click on blank space (anywhere with no focusable target) ALSO blurs
  // the active element to `<body>` without removing anything, and the previous version redirected
  // focus straight back to this row every time, stealing it from wherever the user had just
  // clicked. The actual discriminator is whether `event.target` (the descendant that lost focus)
  // is still connected to the document: removed-from-DOM leaves it `isConnected === false`, while
  // a blank-space click leaves the same button sitting right there, still connected.
  function describesRemoval(event: FocusEvent): boolean {
    const leaving = event.target as Node | null
    return leaving !== null && !leaving.isConnected
  }

  useEffect(() => {
    const rowEl = memoryShown ? memoryRowRef.current : null
    if (!rowEl) return
    function handleFocusOut(event: FocusEvent): void {
      const next = event.relatedTarget as Node | null
      if (next && rowEl?.contains(next)) return
      if (!describesRemoval(event)) return
      scheduleFocusHandoff(() => redirectFocusFrom('memory'))
    }
    rowEl.addEventListener('focusout', handleFocusOut)
    return () => rowEl.removeEventListener('focusout', handleFocusOut)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryShown, ompVersionShown])

  useEffect(() => {
    const rowEl = ompVersionShown ? ompVersionRowRef.current : null
    if (!rowEl) return
    function handleFocusOut(event: FocusEvent): void {
      const next = event.relatedTarget as Node | null
      if (next && rowEl?.contains(next)) return
      if (!describesRemoval(event)) return
      scheduleFocusHandoff(() => redirectFocusFrom('ompVersion'))
    }
    rowEl.addEventListener('focusout', handleFocusOut)
    return () => rowEl.removeEventListener('focusout', handleFocusOut)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryShown, ompVersionShown])

  return (
    <div className={memoryShown || ompVersionShown ? 'flex flex-col gap-0.5 px-2 pb-2' : 'flex flex-col gap-0.5'}>
      {memoryShown && warning && (
        <AlertRow
          containerRef={memoryRowRef}
          label="Low memory"
          actionRef={triageButtonRef}
          actionLabel="Triage"
          actionAriaLabel="Open memory triage"
          onAction={() => setTriageOpen(true)}
          dismissAriaLabel="Dismiss low memory alert"
          dismissTooltip="Dismiss this alert"
          onDismiss={dismissMemory}
        />
      )}
      {ompVersionShown && ompVersionWarning && (
        <AlertRow
          containerRef={ompVersionRowRef}
          label={`omp ${ompVersionWarning.found}: unverified version`}
          wrapLabel
          actionRef={checkButtonRef}
          actionLabel="Check"
          actionAriaLabel="Open Health check"
          onAction={() => setHealthOpen(true)}
          dismissAriaLabel="Dismiss unverified version alert"
          dismissTooltip="Dismiss this alert"
          onDismiss={dismissOmpVersion}
        />
      )}
      <MemoryTriageDialog
        open={triageOpen}
        onOpenChange={setTriageOpen}
        onCloseFocus={() => {
          if (triageButtonRef.current?.isConnected) triageButtonRef.current.focus()
          else focusProfileItemName()
        }}
      />
      <HealthCheckDialog
        open={healthOpen}
        onOpenChange={setHealthOpen}
        onCloseFocus={() => {
          if (checkButtonRef.current?.isConnected) checkButtonRef.current.focus()
          else focusProfileItemName()
        }}
      />
    </div>
  )
}
