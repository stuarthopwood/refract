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
//    `focusProfileItemName()`. Dismiss is handled proactively, at its own click site (a
//    Tooltip-wrapped trigger's delayed Portal cleanup can outlast any reactive retry); a row
//    clearing on its own is detected via a native `focusout` listener whose own redirect is
//    deferred one animation frame, since Chromium/WebView2 fires `focusout` BEFORE the removed
//    node is actually detached -- see the gate round 3 comment further down for the full
//    reasoning. `relatedTarget` lets a normal Tab-away (focus moving to some other real element)
//    fall through untouched, so only a genuine "focus got lost" case redirects.
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
import { focusProfileItemName, isFocusStranded } from '@/lib/focus'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { useAlertDismissStore, useHealthStore, useMemoryStore } from '@/state'
import { AlertRow } from './AlertRow'
import { HealthCheckDialog } from './HealthCheckDialog'
import { MemoryTriageDialog } from './MemoryTriageDialog'
import { UpdateAlertRow, useUpdateRowShown } from './UpdateAlertRow'

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

  const updateVersion = useUpdateRowShown()
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

  // Gate round 3 (Code+A11y+UI High): a row that clears ON ITS OWN (memory recovers, the omp
  // version becomes verified) while focus was inside it never redirected. The round-2 fix read
  // `event.target.isConnected` SYNCHRONOUSLY inside the `focusout` handler, but Chromium/WebView2
  // fires blur/focusout BEFORE the removed node is actually detached
  // (`ContainerNode::RemoveChild` runs `RemoveFocusedElementOfSubtree` -- the blur step -- first),
  // so `isConnected` always read `true` at that exact synchronous moment even for a genuine
  // removal, and the early return (added for the blank-space-click fix, item 2 below) let a REAL
  // removal through just as wrongly as a fake one. Fixed per the same pattern
  // `FileExplorerPanel.tsx`'s own `handleFocusOut` already uses: `lost` (`event.target`) is
  // captured WITHOUT checking its connectedness yet, and that check is deferred to the NEXT
  // animation frame, by which point a genuine removal has actually completed -- a blank-space
  // click never removes `lost` at all, so it is still connected at that later check too, and the
  // blank-space-click fix (item 2) stays intact. Uses the shared `isFocusStranded` (`@/lib/focus`)
  // rather than an inline copy of the same check.
  //
  // The Dismiss case (a row removed by the user's own click/keyboard activation of its Dismiss
  // button) is handled separately, proactively, at the Dismiss click site itself (in the JSX
  // below) -- a Tooltip-wrapped trigger's own Portal content can re-steal focus on ITS delayed
  // unmount, which a reactive fix here could never reliably outlast (gate round 2 finding); this
  // reactive mechanism is the fallback for the row's own condition clearing WITHOUT a click to
  // hook, which has no such Tooltip-unmount race to lose.
  useEffect(() => {
    const rowEl = memoryShown ? memoryRowRef.current : null
    if (!rowEl) return
    function handleFocusOut(event: FocusEvent): void {
      const next = event.relatedTarget as Node | null
      if (next && rowEl?.contains(next)) return
      const lost = event.target as Element | null
      requestAnimationFrame(() => {
        if (!lost || lost.isConnected) return
        if (!isFocusStranded(document.activeElement, rowEl)) return
        redirectFocusFrom('memory')
      })
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
      const lost = event.target as Element | null
      requestAnimationFrame(() => {
        if (!lost || lost.isConnected) return
        if (!isFocusStranded(document.activeElement, rowEl)) return
        redirectFocusFrom('ompVersion')
      })
    }
    rowEl.addEventListener('focusout', handleFocusOut)
    return () => rowEl.removeEventListener('focusout', handleFocusOut)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryShown, ompVersionShown])

  return (
    <div className={memoryShown || ompVersionShown || updateVersion ? 'flex flex-col gap-1 px-2 pb-2' : 'flex flex-col gap-1'}>
      {updateVersion && <UpdateAlertRow version={updateVersion} />}
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
          onDismiss={() => {
            redirectFocusFrom('memory')
            dismissMemory()
          }}
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
          onDismiss={() => {
            redirectFocusFrom('ompVersion')
            dismissOmpVersion()
          }}
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
