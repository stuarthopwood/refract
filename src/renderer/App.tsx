import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeftRightIcon } from 'lucide-react'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { AppMenuBar } from '@/features/app-menu/AppMenuBar'
import { BrandWatermark } from '@/features/chat/BrandWatermark'
import { ChatPane } from '@/features/chat/ChatPane'
import { ErrorBoundary } from '@/features/chat/ErrorBoundary'
import { Readiness } from '@/features/readiness/Readiness'
import { ManageSessionsScreen } from '@/features/profile/ManageSessionsScreen'
import { ProfileItem } from '@/features/profile/ProfileItem'
import { SessionList } from '@/features/sessions/SessionList'
import { SettingsScreen } from '@/features/settings/SettingsScreen'
import { PullRequestsView } from '@/features/pull-requests/PullRequestsView'
import { toast } from 'sonner'
import { StatusBar } from '@/features/status-bar/StatusBar'
import {
  RIGHT_PANE_MAX_WIDTH_PX,
  RIGHT_PANE_MIN_WIDTH_PX,
  useRepositoriesStore,
  useRightPaneStore,
  useSessionsStore,
  useSplitStore,
  useViewStore
} from '@/state'
import { IconRail } from '@/features/right-pane/IconRail'
import { RightPaneShell } from '@/features/right-pane/RightPaneShell'
import { resumeHostedPanels, suspendHostedPanels } from '@/features/right-pane/hosted-panel-actions'
import { closeChatPane } from '@/features/chat/closeChatPane'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { focusSessionPane } from '@/lib/focus'
import { announceQuickCreateFallback } from '@/features/sessions/quickCreateFallback'

// Spec 005 (research.md Decision 6, FR-017): below this many pixels of chat-area width, two
// minimum-width panes (360px each, matching the "chat" ResizablePanel's own existing floor) can
// no longer both fit; the chat area shows one pane instead of two, with the other Session one
// click away via ChatHeader's swap chip.
const MIN_SPLIT_WIDTH_PX = 360 * 2

// Shared by every window-wide keyboard chord below (Ctrl+Shift+\, Ctrl+W, Ctrl+,): a
// destructive- or navigation-feeling chord must not fire while a Dialog/Sheet (`role="dialog"`, which Radix
// sets despite the primitive never setting `aria-modal` -- confirmed in its installed
// source, so matching the bare role is both correct and simpler), an AlertDialog
// (`role="alertdialog"`), a DropdownMenu/ContextMenu (`role="menu"`), or a Select
// (`data-slot="select-content"`, which sets no distinguishing role at all) is open. Radix
// Popover also renders `role="dialog"` despite being non-modal, so it needs no separate
// `data-slot` clause either (quality-gate remediation, PR #634/#636 gates).
const OVERLAY_OPEN_SELECTOR = '[role="alertdialog"], [role="dialog"], [role="menu"], [data-slot="select-content"]'

// Three-region layout (docs/DESIGN.md "Layout"): session list, chat, and the right region --
// spec 004's Subagents panel is its first occupant (FR-017 to FR-020), always mounted but
// collapsed to zero width until opened (see the `useLayoutEffect` below for why);
// a file browser and side chat (backlog issue #1) remain later tenants of the same region. A
// fixed status bar runs along the bottom, outside the resizable regions. Before the readiness
// checklist passes or before a repository exists, this area shows the readiness screen instead
// (docs/DESIGN.md "First run and empty states"). Each region has its own ErrorBoundary so a
// render error in one (a malformed Session/TranscriptItem, say) cannot blank the other.
// `AppMenuBar` mounts once here, outside both branches, so Alt reveals the File/Edit/View/Window
// bar (FR-057) no matter which screen is showing; it is deliberately the LAST element in this
// file (see its own comment below) so its `no-drag-region` always outranks every drag-region
// header underneath it.
//
// Spec 005: the chat region renders one `ChatPane` when `useSplitStore`'s `paneSessionIds` holds
// one id, or two side by side (a nested horizontal `ResizablePanelGroup`) when it holds two --
// unless the chat area is narrower than `MIN_SPLIT_WIDTH_PX` (research.md Decision 6), in which
// case only the focused pane renders, with the other Session reachable through its header's
// swap chip.
export function App() {
  const [ready, setReady] = useState(false)
  const hasRepositories = useRepositoriesStore((state) => state.repositories.length > 0)
  const showReadiness = !ready || !hasRepositories
  const view = useViewStore((state) => state.view)
  const rightPaneOpen = useRightPaneStore((state) => state.open)
  // Gate remediation (Medium, round 2): the rail and pane are chat-view only (Stuart's
  // decision). The store's own `open` flag genuinely survives a view switch (not just FR-003's
  // collapse/restore semantics) -- the `onResize` handler below only persists a drag-collapse's
  // `open: false` back to the store while `view === 'chat'`, so the programmatic collapse that
  // fires when leaving the chat view (the layout effect's own `handle.collapse()` call) never
  // overwrites it. The rendered pane and the right-most `ChatPane`'s `reservesWindowControls`
  // still both treat the pane as closed outside the chat view (`paneShown` below), so
  // `PullRequestsView`'s own header is the one reserving the window-controls corner there
  // instead of double-reserving it (FR-011).
  const paneShown = rightPaneOpen && view === 'chat'
  const sessions = useSessionsStore((state) => state.sessions)
  const paneSessionIds = useSplitStore((state) => state.paneSessionIds)
  const focusedIndex = useSplitStore((state) => state.focusedIndex)
  const dividerPercent = useSplitStore((state) => state.dividerPercent)
  const rightPaneRef = useRef<PanelImperativeHandle>(null)
  const focusMoveButtonRef = useRef<HTMLButtonElement>(null)
  // Round 3 (code-reviewer, Low): starting this at `+Infinity` made `canShowSplit` wrongly
  // assume a wide window before the chat panel's first real `onResize` measurement lands (e.g.
  // at startup or just after a renderer reload) -- long enough to clear a hidden Session's unread
  // flag the `visible` effect below should not have touched yet. `null` means "not yet measured".
  const [chatWidthPx, setChatWidthPx] = useState<number | null>(null)
  // Quality-gate remediation (test-reviewer Medium; revised gate-3, UI N6 / A11y M3): the
  // session-list panel's own content stays mounted AND rendered even collapsed to zero width
  // (react-resizable-panels sets no inert/hidden/display:none on a collapsed Panel by itself) --
  // unmounting it on collapse (the first fix) dropped the whole left nav's own live state (which
  // Sessions group was open/closed, scroll position, an in-progress rename) every time the user
  // dragged the divider shut. The content below is instead kept mounted and marked `inert` +
  // `aria-hidden` while collapsed -- out of the Tab order and screen-reader browse mode, exactly
  // like the always-mounted subagents Panel's own content further down, but never torn down.
  // Tracked via this Panel's own `onResize` (there is no dedicated open/close store for this
  // one, unlike the right pane's `useRightPaneStore`).
  const [navCollapsed, setNavCollapsed] = useState(false)
  // Quality-gate remediation (code-reviewer, round 2, High): the focus-move button's `left` was
  // reading the PERSISTED `dividerPercent`, which `onLayoutChanged` only updates once a drag or
  // keyboard resize finishes (the library's own docs: "not called until the pointer has been
  // released") -- so the button stayed at the old position for the whole drag, then jumped, and
  // never moved at all for a layout the library sets itself (a restored `dividerPercent` the
  // `minSize={360}` floor re-clamps, or a window resize). Tracks the Group's own `onLayoutChange`
  // instead (fires on every pointer move AND every programmatic layout change, not just completed
  // user interactions) purely for the button's own position; `dividerPercent`/`onLayoutChanged`
  // remain the persisted, debounced source of truth for everything else.
  // Round 3 (code-reviewer/test-reviewer, Medium): the sync effect this first shipped with
  // (`useEffect(() => setLiveDividerPercent(dividerPercent), [dividerPercent])`) raced the
  // Group's own mount-time `onLayoutChange` emit -- both fire for the same commit when a split
  // mounts with a restored `dividerPercent` the `minSize={360}` floor re-clamps, and the passive
  // effect below the Group's layout effect runs LAST, overwriting the library's correct clamped
  // value with the stale persisted one. Removed: `onLayoutChange` alone already covers every
  // case (it fires on every mount, not just drags/later changes), so the `useState` initial
  // value only matters for the one frame before that first mount emit lands.
  const [liveDividerPercent, setLiveDividerPercent] = useState(dividerPercent)

  const isSplit = paneSessionIds.length === 2
  const canShowSplit = chatWidthPx !== null && chatWidthPx >= MIN_SPLIT_WIDTH_PX
  const showSplit = isSplit && canShowSplit
  // "Whichever pane is front-and-center" regardless of whether a split is actually open right
  // now: index 0 for a single pane (focusedIndex is meaningless at that length), the focused
  // pane's id for a real split.
  const [paneA, paneB] = paneSessionIds
  const frontSessionId = paneSessionIds.length > 0 ? paneSessionIds[Math.min(focusedIndex, paneSessionIds.length - 1)] : null
  const unfocusedSessionId = isSplit ? paneSessionIds[focusedIndex === 0 ? 1 : 0] : null
  const unfocusedSession = unfocusedSessionId ? sessions.find((session) => session.id === unfocusedSessionId) : undefined
  const otherSessionForNarrowCollapse =
    isSplit && !canShowSplit && unfocusedSession ? { id: unfocusedSession.id, name: unfocusedSession.name } : null
  // Quality-gate remediation (accessibility-auditor, High): the shared aria-live announcer used
  // to mount only inside the `showSplit` branch, so a narrow-window collapse (still `isSplit`,
  // just rendering one pane) never announced its own swap-chip focus changes. Driven by
  // `isSplit` throughout instead, regardless of whether both panes currently fit on screen.
  const focusedSessionName = isSplit ? sessions.find((session) => session.id === paneSessionIds[focusedIndex])?.name : undefined
  // Quality-gate remediation (code-reviewer, LOW, PR #634): was called inline inside the JSX
  // below; moved up with the other hooks, which is where a hook call belongs.
  const chatAreaAnnouncement = useChatAreaAnnouncer((s) => s.text)

  // Spec 005 (FR-007, research.md Decision 8): Ctrl+Shift+\ moves focus to the other pane while
  // a split is open, active window-wide (same pattern MessageInput.tsx's Ctrl+Shift+X listener
  // uses); `event.code` (not `event.key`) targets the physical backslash key regardless of what
  // Shift produces on the current keyboard layout.
  useEffect(() => {
    if (!isSplit) return
    function onKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || !event.shiftKey || event.code !== 'Backslash') return
      // Quality-gate remediation (PR #636 gate, MEDIUM): hoisted into the shared
      // `OVERLAY_OPEN_SELECTOR` constant above -- this chord and Ctrl+W below were
      // carrying an identical, independently-maintained copy of the same selector string.
      if (document.querySelector(OVERLAY_OPEN_SELECTOR)) return
      event.preventDefault()
      useSplitStore.getState().focusOther()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isSplit])

  // Issue #621 (close chat pane): Ctrl+W closes whichever chat pane is actually showing --
  // the focused pane of a genuine split, the sole visible pane during the narrow-window
  // collapse (still `isSplit`, see `otherSessionForNarrowCollapse` above), or the single
  // pane when there is no split at all -- all three render with `paneIndex={isSplit ?
  // focusedIndex : 0}` below, so that same expression picks the right pane here too.
  // `menu.ts` moved the Electron `role: 'close'` accelerator off Ctrl+W to Alt+F4 specifically
  // so this listener -- never window close -- receives it; `event.preventDefault()` is
  // this chord's own "stop it falling through" fix on top of that.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Quality-gate remediation (accessibility-auditor/code-reviewer/security-auditor,
      // MEDIUM, PR #634): matching the physical `event.code` (copied from the Backslash
      // chord above, where it is correct because Shift changes the character) is wrong for a
      // plain letter chord -- on AZERTY the `KeyW` code is labelled Z, so Ctrl+Z (undo in the
      // message box) would close the pane while the real Ctrl+W does nothing. `event.key`
      // matches the letter instead, regardless of layout. `altKey`/`metaKey` excludes AltGr
      // (reported as Ctrl+Alt on Windows -- some layouts type a real character on this key
      // with AltGr) and Ctrl+Cmd combinations from closing the pane; `repeat` stops a held
      // chord from closing a split's two panes one after another; `isComposing` matches the
      // convention at `MessageInput.tsx:724`.
      // Follow-up (PR #634 gate, read-only note): `event.key` alone mismatches non-Latin
      // keyboard layouts (Cyrillic, Greek, ...), where the physical W-position key types a
      // character with no relation to the Latin alphabet at all -- the chord would never
      // fire there even though `event.code` is still 'KeyW'. Falls back to the physical
      // code only when `event.key` is neither printable ASCII nor a Latin-script character
      // (quality-gate remediation, PR #637 gate, MEDIUM: the PR #636 fix's printable-ASCII
      // test still wrongly took the code fallback for a genuine, just non-ASCII, Latin
      // letter -- BÉPO's physical W key types 'é', which IS a Latin letter, so it is
      // compared by key and does not fire; corrected again, PR #637 gate round 3: an
      // earlier draft of this comment wrongly claimed Turkish-Q's physical W key types
      // 'ö' -- it types 'w' there, like QWERTY; 'ö' lives on a different key on that
      // layout). A Latin-script or printable-ASCII key -- Dvorak's ',', AZERTY's 'z',
      // BÉPO's 'é' -- is compared by `key` and correctly does NOT match; only a
      // genuinely non-Latin letter (Cyrillic, Greek, ...) falls back to the physical code.
      const latin = /^(?:[\x21-\x7e]|\p{Script=Latin})$/u.test(event.key)
      const isW = latin ? event.key.toLowerCase() === 'w' : event.code === 'KeyW'
      if (
        !event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        event.metaKey ||
        event.repeat ||
        event.isComposing ||
        !isW
      )
        return
      if (showReadiness || view !== 'chat' || paneSessionIds.length === 0) return
      // Quality-gate remediation (PR #636 gate, MEDIUM): see `OVERLAY_OPEN_SELECTOR`'s own
      // comment above for why `role="dialog"` alone (not `[aria-modal="true"]`) is correct.
      if (document.querySelector(OVERLAY_OPEN_SELECTOR)) return
      event.preventDefault()
      closeChatPane(isSplit ? focusedIndex : 0)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showReadiness, view, paneSessionIds.length, isSplit, focusedIndex])

  // Issue #6 (keyboard shortcut set), first slice: Ctrl+N creates a new Session. Target rule
  // (decided on the issue before implementing, reusing #620's own UX-consult decision 7
  // verbatim): the FOCUSED pane's repository and its default branch when a pane is open
  // (`frontSessionId` above already picks that session id -- index 0 for a single pane, the
  // focused pane's id for a real split); with no pane open and exactly one repository, that
  // repository; otherwise (no pane open with 2+ repositories, OR a focused pane whose
  // repository can no longer be resolved -- e.g. removed mid-session, a defensive extension of
  // the decided rule) moves focus to the first repository group's quick-create "+" button
  // instead of guessing which repository to create in. Zero repositories is covered by
  // `showReadiness` below -- the Readiness screen, not the session list, is showing then.
  // Restricted to `view === 'chat'`, the same guard Ctrl+W above uses, since this rule depends
  // on the chat view's own focused-pane state; reaching from Settings/Manage sessions/Pull
  // requests is left to a later slice. Ctrl+Shift+N, Ctrl+1..9 and Ctrl+Shift+A stay out of
  // this slice entirely (still backlog issue #6).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Same printable-ASCII/Latin-script key match (with a physical-code fallback for a
      // non-Latin layout) as the Ctrl+W chord above -- see its own comment for the full
      // layout-independence rationale (PR #634/#636/#637 remediations).
      const latin = /^(?:[\x21-\x7e]|\p{Script=Latin})$/u.test(event.key)
      const isN = latin ? event.key.toLowerCase() === 'n' : event.code === 'KeyN'
      if (
        !event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        event.metaKey ||
        event.repeat ||
        event.isComposing ||
        !isN
      )
        return
      if (showReadiness || view !== 'chat') return
      // Quality-gate remediation pattern (see `OVERLAY_OPEN_SELECTOR`'s own comment above).
      if (document.querySelector(OVERLAY_OPEN_SELECTOR)) return
      event.preventDefault()

      // Quality-gate fix (round 2, Code/Verif Low): read the live session list here instead of
      // closing over the `sessions` prop, so that value no longer needs to sit in this effect's
      // own dependency array -- every session-status update used to re-attach this listener.
      const currentSessions = useSessionsStore.getState().sessions
      const focusedSession = frontSessionId
        ? currentSessions.find((session) => session.id === frontSessionId)
        : undefined
      const repositories = useRepositoriesStore.getState().repositories
      const target = focusedSession
        ? repositories.find((candidate) => candidate.id === focusedSession.repositoryId)
        : repositories.length === 1
          ? repositories[0]
          : undefined
      // Quality-gate fix (round 2, Code/A11y/Verif Medium): a repository whose git read failed
      // has `defaultBranch === ''` -- treated as UNRESOLVED (the same "leave it out" rule
      // #620/#635 already apply to the row menu item and the Manage screen), not as a real
      // target, so it takes the focus-the-"+" fallback below instead of announcing "Creating
      // session from " and calling `create(id, '')`.
      const repository = target?.defaultBranch ? target : undefined

      if (!repository) {
        const plus = document.querySelector<HTMLElement>('[data-quick-create-session]')
        plus?.focus()
        // Quality-gate fix (round 2, A11y/Verif Medium): when the session list is collapsed to
        // zero width, its content stays mounted but `inert` (App.tsx's own `navCollapsed`
        // state further down) -- an `inert` element cannot take focus, so `.focus()` above is a
        // silent no-op there, and the keypress has already been `preventDefault`ed. Checking
        // whether focus genuinely moved catches that (and the button being altogether absent)
        // in one condition, and announces instead of leaving the user with no feedback at all.
        // Issue #559 decision 26, gate round 1 fix: `announceQuickCreateFallback` now decides
        // purely by outcome (`features/sessions/quickCreateFallback.ts`) -- no longer reads
        // `repositories.length` or the search query here.
        if (document.activeElement !== plus) announceQuickCreateFallback()
        return
      }

      // Quality-gate fix (round 2, Sec/A11y/Verif Medium): the shared guard every other
      // `create()` caller already relies on (the row menu item's #620 fix, the quick-create
      // "+" button's own early-return at `SessionList.tsx:937`) -- silently ignores a repeat
      // chord while this repository's create is already running, instead of re-announcing
      // "Creating session from {branch}" and then showing a spurious "already being created"
      // error toast for what is, from the user's own perspective, the same single request.
      if (useSessionsStore.getState().creatingRepositoryIds.has(repository.id)) return

      // Quality-gate fix (round 2, A11y/Verif Medium): captured at keydown, BEFORE the
      // multi-second worktree create runs, so success can tell whether the user is still where
      // they were when they pressed the chord (decision 8: move focus into the new pane "only
      // if the user has not moved on") -- the same check #620's own row-menu create already
      // applies via `isStillHere()`.
      const origin = document.activeElement
      const originPaneContainer = origin?.closest('[data-session-pane]') ?? null

      // Issue #620, UX consult item 2 decision 9's own pattern: announce immediately (the
      // worktree create itself takes seconds), then let a successful `focusSessionPane` call's
      // own focus-move stand in for a second "created" announcement; only announce success
      // explicitly when that pane genuinely cannot be found (the view moved on in the meantime).
      useChatAreaAnnouncer.getState().announce(`Creating session from ${repository.defaultBranch}`)
      void useSessionsStore
        .getState()
        .create(repository.id, repository.defaultBranch)
        .then((result) => {
          if (!result.ok) {
            // Quality-gate fix (round 2, Sec/A11y/Verif/Code HIGH): `notify()` is a plain,
            // auto-dismissing toast. #620's OWN create() callers (the row menu item,
            // `SessionList.tsx:358`, and the Manage screen, `ManageSessionRow.tsx:322`) both
            // settled a create failure as a dismiss-until-cleared toast instead, exactly
            // decision 8's own wording ("an error toast that stays until dismissed") -- only the
            // older quick-create "+" button still uses the auto-dismissing one. Ctrl+N has no
            // visible on-screen trigger at all, so that toast is the ONLY failure cue there is;
            // it must not disappear on its own (WCAG 2.2.1).
            toast.error(result.error.message, { duration: Infinity, closeButton: true })
            return
          }
          // Quality-gate fix (round 2, A11y/Verif Medium): one frame later (matching #620's own
          // row-menu deferral), and only if the user genuinely has not moved on in the meantime
          // -- focus is still nowhere in particular (`<body>`, disconnected), still on the
          // control that triggered this, or still inside the pane that was focused back at
          // keydown. Otherwise the new pane's own focus never happens at all (never yanking
          // focus away from wherever the user has since moved to), and only the announcement
          // reports the outcome.
          requestAnimationFrame(() => {
            const active = document.activeElement
            const stillHere =
              !active ||
              active === document.body ||
              !active.isConnected ||
              active === origin ||
              (originPaneContainer !== null && originPaneContainer.contains(active))
            if (!stillHere || !focusSessionPane(result.value.id)) {
              useChatAreaAnnouncer.getState().announce(`Created session ${result.value.name}`)
            }
          })
        })
        .catch((err: unknown) => {
          // Quality-gate fix (round 2, Sec/A11y/Verif/Code HIGH+Medium): `create()`'s own
          // `finally` re-throws a rejected IPC call rather than swallowing it -- with no
          // `.catch` here, that was an unhandled promise rejection: no toast at all, and the
          // "Creating session from {branch}" announcement left standing with no resolution.
          // Mirrors #620's own row-menu create, which catches this exact case.
          toast.error(err instanceof Error ? err.message : String(err), { duration: Infinity, closeButton: true })
        })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showReadiness, view, frontSessionId])

  // Issue #395 (keyboard shortcut set): Ctrl+, opens Settings -- documented in
  // docs/design/index.md's Keyboard table since before any handler existed (found while
  // building spec 008 T013/T014). Reuses the Ctrl+W/Ctrl+Shift+\ chords' own window-wide
  // pattern and modal guard immediately above; `key`-matching (with a code-based fallback
  // for non-Latin layouts, mirroring the Ctrl+W fix) is how VS Code binds this exact chord.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Quality-gate remediation (PR #637 gate, LOW; then MEDIUM, PR #637 gate round 2): a
      // punctuation chord DOES have its own layout mismatches -- on Russian/Ukrainian
      // layouts the physical comma key types 'б', and producing ',' there needs Shift,
      // which this guard already rejects. Falls back to the physical code only when
      // `event.key` is neither printable ASCII nor a Latin-script character (mirrors the
      // Ctrl+W fix above): AZERTY and QWERTZ already type an unshifted ',' (a Latin
      // character) and are unaffected either way. Turkish-Q's physical comma key types
      // 'ö' (Latin), so it is compared by key and does not fire; ',' there sits on
      // another key.
      const latin = /^(?:[\x21-\x7e]|\p{Script=Latin})$/u.test(event.key)
      const isComma = latin ? event.key === ',' : event.code === 'Comma'
      if (
        !event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        event.metaKey ||
        event.repeat ||
        event.isComposing ||
        !isComma
      )
        return
      // Already in Settings: a no-op, not a second `openSettings()` call, which would reset
      // the open section back to the default and silently discard where the developer was.
      if (showReadiness || view === 'settings') return
      // Quality-gate remediation (PR #636/#637 gates): see `OVERLAY_OPEN_SELECTOR`'s own
      // comment above.
      if (document.querySelector(OVERLAY_OPEN_SELECTOR)) return
      event.preventDefault()
      useViewStore.getState().openSettings()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showReadiness, view])

  // Round 3 (code-reviewer/accessibility-auditor/test-reviewer, Low): the React
  // `onPointerDownCapture` prop this first shipped with on the button below never ran early
  // enough -- react-resizable-panels attaches its own `pointerdown` listener directly to
  // `ownerDocument` in the CAPTURE phase, and the capture phase always reaches `document` before
  // it reaches React's root container (where React's synthetic `onPointerDownCapture` actually
  // dispatches from), so the library's handler -- which focuses the Separator, flags an active
  // drag, and calls `preventDefault()` -- had already run by the time React's handler fired. A
  // native listener on `window` (earlier still in the capture path than `document`) that calls
  // `preventDefault()` itself when the event's target is inside this button pre-empts it for
  // real: the library's own handler bails out immediately whenever the event arrives already
  // `defaultPrevented`.
  useEffect(() => {
    function onPointerDownCapture(event: PointerEvent) {
      if (focusMoveButtonRef.current?.contains(event.target as Node)) event.preventDefault()
    }
    window.addEventListener('pointerdown', onPointerDownCapture, { capture: true })
    return () => window.removeEventListener('pointerdown', onPointerDownCapture, { capture: true })
  }, [])

  // Quality-gate remediation (test-reviewer, round 2, Medium; then round 3, Medium, same gap):
  // FR-018 ("a session shown in either pane counts as viewed") needs exactly ONE place deciding
  // what main thinks is visible. Round 2 kept `split-store.ts`'s own `syncVisible` calls (always
  // sending BOTH `paneSessionIds`) AND added this effect to narrow the result back down during
  // the narrow-window collapse -- but main's `setVisible` clears unread (and resets the
  // transcript) for every id made newly visible the MOMENT the store's wide call lands, before
  // this effect's own narrowing call ever reaches main; the hidden Session's unread flag was
  // already cleared by the time the correction arrived, so the hole stayed open for the most
  // common actions (a plain row click, "Open in split"). This effect is now the SOLE caller of
  // `sessions.setVisible` -- every `syncVisible` call was removed from `split-store.ts` -- and
  // covers every pane count, not just an open split: `paneSessionIds.length` 0 (nothing visible),
  // 1 (today's single-pane case), or 2 collapsed-by-width (only `frontSessionId`'s pane actually
  // renders) all resolve to exactly what's on screen.
  useEffect(() => {
    const visible = isSplit && canShowSplit ? paneSessionIds : frontSessionId ? [frontSessionId] : []
    window.refract.sessions.setVisible(visible).then(
      (result) => {
        if (!result.ok) console.error('sessions.setVisible failed', result.error)
      },
      (err: unknown) => console.error('sessions.setVisible threw', err)
    )
  }, [isSplit, canShowSplit, frontSessionId, paneSessionIds])

  // Keeps the right pane mounted at all times (collapsible/collapsedSize=0, same pattern as
  // SessionList's own left-nav panel) rather than conditionally mounting/unmounting it --
  // react-resizable-panels recomputes every sibling's size whenever the set of mounted Panels
  // changes, which would move the chat pane's width on open/close and break FR-020's "Close
  // restores the chat pane's size and scroll exactly as before" (spec 013: generalised from the
  // Subagents-only panel to every hosted panel, same guard). `useLayoutEffect` (not `useEffect`)
  // so the imperative collapse()/expand() call commits before the browser paints, never flashing
  // the panel at its expanded width first. Depends on `showReadiness`/`view` too, not just
  // `rightPaneOpen`: the `ResizablePanelGroup` (and so `rightPaneRef`'s handle) only exists once
  // the Readiness screen clears and `view` is `'chat'`/`'pull-requests'`/`'manage-sessions'`, and
  // a `[rightPaneOpen]`-only dependency list never ran this effect for that later first mount
  // (caught live: the panel rendered at its full `defaultSize` instead of collapsed, the very
  // regression this effect exists to prevent).
  useLayoutEffect(() => {
    const handle = rightPaneRef.current
    if (!handle) return
    if (paneShown && handle.isCollapsed()) handle.expand()
    else if (!paneShown && !handle.isCollapsed()) handle.collapse()
  }, [paneShown, showReadiness, view])

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Permanent drag strip (FR-057): Electron settles overlapping `-webkit-app-region` values
          by DOM document order, not paint/z-index (confirmed live), so this being the FIRST
          drag-region element in the tree means the left-nav header and the chat header (both
          declared later, whenever the workspace is showing) always win over it for the pixels
          they cover; the `-z-10` is cosmetic only (keeps it from ever visibly flashing), not what
          makes it inert there. It is the *only* drag-region source on the Readiness screen and the
          empty-chat state (especially with the session-list panel collapsed to 0 width) -- both
          leave the top row entirely unpainted otherwise, and with `titleBarStyle: 'hidden'`
          removing the real OS title bar, an unmovable window would result without it. */}
      <div aria-hidden className="drag-region fixed left-0 top-0 -z-10 flex h-10 w-full">
        <div
          aria-hidden
          className="no-drag-region ml-auto h-full"
          style={{ width: 'calc(100vw - env(titlebar-area-width, 100vw))' }}
        />
      </div>
      {/* Spec 005 (FR-022): one shared live region for the whole split, outside both panes and
          mounted whenever a split exists (even collapsed to one pane by the narrow-window
          rule), so a focus change -- including a narrow-window swap -- is announced exactly
          once (React only touches this text node when the computed string itself changes)
          rather than each pane re-reading on every unrelated re-render. */}
      {isSplit && <div aria-live="polite" className="sr-only">{focusedSessionName ? `Focused: ${focusedSessionName}` : ''}</div>}
      {/* Issue #621 (close chat pane): the "Closed {name} chat pane" announcement, always
          mounted here -- outside ChatPane entirely, per the decision -- not gated on
          `isSplit` like the region above, since closing the single, non-split pane down to
          zero is the one case that region's own gate would otherwise miss. */}
      <div aria-live="polite" className="sr-only">{chatAreaAnnouncement}</div>
      <div className="min-h-0 flex-1">
        {showReadiness ? (
          <Readiness onReadyChange={setReady} />
        ) : view === 'settings' ? (
          <ErrorBoundary>
            <SettingsScreen />
          </ErrorBoundary>
        ) : view === 'manage-sessions' ? (
          <ErrorBoundary>
            <ManageSessionsScreen />
          </ErrorBoundary>
        ) : (
          <div className="flex h-full overflow-hidden">
          <ResizablePanelGroup orientation="horizontal" className="h-full flex-1 min-w-0">
            <ResizablePanel
              id="session-list"
              defaultSize={280}
              minSize={220}
              maxSize={480}
              collapsible
              collapsedSize={0}
              onResize={(size) => setNavCollapsed(size.inPixels <= 0)}
            >
              {/* Quality-gate remediation (test-reviewer Medium; revised gate-3, UI N6 / A11y
                  M3): the `ResizablePanel` wrapper stays always mounted either way (so its own
                  pixel-exact sizing never changes), and now so does the content inside it --
                  `inert` + `aria-hidden` take it out of the Tab order and screen-reader browse
                  mode while collapsed, without unmounting it (and losing SessionList's own open
                  group/scroll/rename state) the way the previous conditional mount did. */}
              <ErrorBoundary>
                <div className="flex h-full flex-col" inert={navCollapsed} aria-hidden={navCollapsed || undefined}>
                  <div className="min-h-0 flex-1">
                    <SessionList />
                  </div>
                  <ProfileItem />
                </div>
              </ErrorBoundary>
            </ResizablePanel>
            <ResizableHandle withHandle aria-label="Resize session list" />
            <ResizablePanel id="chat" minSize={360} onResize={(size) => setChatWidthPx(size.inPixels)}>
              <ErrorBoundary>
                {view === 'pull-requests' ? (
                  // specs/003-pull-request-management: swaps only this panel's content (never
                  // the session-list panel or the subagent panel, both of which stay mounted --
                  // "Pull requests" is a left-nav entry, not a separate shell).
                  <PullRequestsView reservesWindowControls={!paneShown} />
                ) : paneSessionIds.length === 0 ? (
                  // Spec 012 (research.md decision 3): no pane open at all -- no composer exists
                  // in this branch, so the mark anchors to this div's own full box.
                  //
                  // Quality-gate remediation (code-reviewer/ui-architect, Medium): `20cqw` needs
                  // this root itself to be the query container (`[container-type:size]`), not the
                  // window, matching ChatPane.tsx's own transcript container (research.md decision
                  // 8) -- missing it here sized the mark off the WHOLE window instead of this box.
                  // `isolate` plus the mark's own `-z-10` (BrandWatermark.tsx) then keeps the
                  // absolutely-positioned mark painting BEHIND this normal-flow text instead of
                  // over it: `isolate` is what creates the stacking context here (`container-type`
                  // does not, it only applies style and size containment).
                  <div
                    data-chat-empty-state
                    role="region"
                    aria-label="Chat"
                    tabIndex={-1}
                    className="relative isolate flex h-full items-center justify-center text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [container-type:size]"
                  >
                    <BrandWatermark variant="live" />
                    Select a Session or create one.
                  </div>
                ) : !showSplit || paneA === undefined || paneB === undefined ? (
                  <ChatPane
                    sessionId={frontSessionId as string}
                    paneIndex={isSplit ? focusedIndex : 0}
                    reservesWindowControls={!paneShown}
                    otherSession={otherSessionForNarrowCollapse}
                    showWatermark
                  />
                ) : (
                  <ResizablePanelGroup
                    orientation="horizontal"
                    className="relative h-full"
                    onLayoutChange={(layout) => {
                      const percent = layout['split-pane-0']
                      if (typeof percent === 'number') setLiveDividerPercent(percent)
                    }}
                    onLayoutChanged={(layout, meta) => {
                      // research.md Decision 5: only a real drag or keyboard resize persists;
                      // the initial/restored mount's own layout-settle call is not a user
                      // choice.
                      if (!meta.isUserInteraction) return
                      const percent = layout['split-pane-0']
                      if (typeof percent === 'number') {
                        useSplitStore.getState().setDividerPercent(percent, { isUserInteraction: true })
                      }
                    }}
                  >
                    <ResizablePanel id="split-pane-0" defaultSize={`${dividerPercent}%`} minSize={360}>
                      <ErrorBoundary>
                        <ChatPane sessionId={paneA} paneIndex={0} reservesWindowControls={false} />
                      </ErrorBoundary>
                    </ResizablePanel>
                    <ResizableHandle withHandle aria-label="Resize chat panes" />
                    {/* Quality-gate remediation (accessibility-auditor, High x2; then a real
                        regression caught live during remediation re-verification; then a Tab-order
                        regression from the code-reviewer, round 2, Medium): the focus-move button
                        first lived INSIDE the Separator (`handleContent`), which made it a child of
                        `role="separator"` (ARIA: children presentational -- screen readers lost its
                        name) and let the library's own `keydown` handler on the Separator swallow
                        the button's native Enter activation. Wrapping the Separator itself in a
                        `relative` DIV sibling-fixed both of those but silently broke the library's
                        OWN arrow-key resize (confirmed live: 15x ArrowLeft on a correctly-focused,
                        correctly-labelled handle produced zero pixel change) -- the Separator must
                        stay a DIRECT child of this Group for its internal layout bookkeeping. This
                        button is a true sibling of both ResizablePanels and the Separator (not
                        wrapping anything), absolutely positioned via the Group's own `relative` root
                        at the live divider position -- not a descendant of the separator, and the
                        Separator's own DOM position in the Group is completely unchanged from the
                        library's expectations. It sits here, between the Separator and the second
                        Panel, so Tab order follows the divider's visual position (pane 0 ->
                        Separator -> this button -> pane 1) instead of landing after the entire
                        second pane's own content; the library's hit-region scan sorts by
                        `offsetLeft`, not DOM order, so this placement does not affect it. */}
                    <button
                      ref={focusMoveButtonRef}
                      type="button"
                      className="absolute top-1/2 z-20 flex size-6 -translate-x-1/2 -translate-y-10 items-center justify-center rounded border border-border bg-background text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      style={{ left: `${liveDividerPercent}%` }}
                      title="Move focus to other pane (Ctrl+Shift+\)"
                      aria-label="Move focus to the other pane"
                      aria-keyshortcuts="Control+Shift+\"
                      onClick={() => useSplitStore.getState().focusOther()}
                    >
                      <ArrowLeftRightIcon aria-hidden className="size-3.5" />
                    </button>
                    <ResizablePanel id="split-pane-1" defaultSize={`${100 - dividerPercent}%`} minSize={360}>
                      <ErrorBoundary>
                        {/* Spec 012 (research.md decision 3, FR-008): the right-most pane's own
                            reading area, never paneA -- "one watermark, not one per pane". */}
                        <ChatPane sessionId={paneB} paneIndex={1} reservesWindowControls={!paneShown} showWatermark />
                      </ErrorBoundary>
                    </ResizablePanel>
                  </ResizablePanelGroup>
                )}
              </ErrorBoundary>
            </ResizablePanel>
            <ResizableHandle withHandle aria-label="Resize right pane" disabled={view !== 'chat'} />
            <ResizablePanel
              id="right-pane"
              panelRef={rightPaneRef}
              defaultSize={useRightPaneStore.getState().widthPx}
              minSize={RIGHT_PANE_MIN_WIDTH_PX}
              maxSize={RIGHT_PANE_MAX_WIDTH_PX}
              collapsible
              collapsedSize={0}
              onResize={(size, _id, prevSize) => {
                // Spec 013 (research.md decision 2): generalised from the Subagents-only guard
                // that used to live here -- the handle stays draggable even while "collapsed"
                // (nothing else disables it), so dragging it directly (rather than through a rail
                // icon, the launcher, or a panel's own Close control) must keep `right-pane-
                // store.ts`'s `open`/`widthPx` in sync with the panel's REAL rendered size, not
                // just the state the store last commanded. `prevSize === undefined` is the
                // initial mount, which the layout effect above already owns EXCEPT for one gap
                // (gate remediation, High, round 3): Settings/Manage sessions unmount the whole
                // `ResizablePanelGroup`, so returning to chat with the pane previously left open
                // (e.g. after a chat -> Pull requests -> Settings -> chat round trip) remounts
                // this Panel already expanded (`defaultSize` is non-zero) -- the layout effect
                // sees `paneShown` already true and the handle already not collapsed, so it
                // never fires, and this is the ONLY resize event for that remount. Resuming here
                // only when the rendered size is genuinely non-zero, the destination view is
                // actually chat (never while merely passing through a remount that lands on Pull
                // requests, which should stay paused and not spend an IPC round trip nobody can
                // see), AND the store still thinks the pane is open (gate remediation, round 4,
                // Medium): without this last check, remounting a pane the user had left COLLAPSED
                // in chat view would still momentarily resume -- the layout effect's own
                // `collapse()` call corrects it a moment later (same generation-guard machinery
                // drops the now-stale fetch), but it would still cost a pointless subscribe/
                // unsubscribe round trip the whole point of this gate is to avoid.
                if (prevSize === undefined) {
                  const paneStore = useRightPaneStore.getState()
                  if (size.inPixels > 0 && useViewStore.getState().view === 'chat' && paneStore.open) {
                    resumeHostedPanels(paneStore.openPanelIds)
                  }
                  return
                }
                const collapsed = size.inPixels <= 0
                const wasCollapsed = prevSize.inPixels <= 0
                if (collapsed === wasCollapsed) {
                  if (!collapsed) useRightPaneStore.getState().setWidth(size.inPixels)
                  return
                }
                const paneState = useRightPaneStore.getState()
                if (collapsed) {
                  // Gate remediation (Critical/High, round 1; Medium, round 2): FR-003 and
                  // data-model.md's collapsed-pane invariant -- collapsing the pane is a separate
                  // action from closing a panel. Every open panel and its Session binding survive
                  // (including a programmatic collapse from leaving the chat view); only the live
                  // stream pauses, since nothing can see it at 0px wide. The store's own `open`
                  // flag is only overwritten by a GENUINE drag-collapse inside the chat view --
                  // leaving the chat view also collapses the panel visually (via the layout
                  // effect's `handle.collapse()`, which fires this same callback) but must not
                  // persist `open: false`, or returning to chat would find the pane already
                  // closed instead of restoring it.
                  suspendHostedPanels(paneState.openPanelIds)
                  if (useViewStore.getState().view === 'chat') {
                    // `widthPx` keeps its last real value too (FR-003's "same width"), never 0.
                    paneState.syncRenderedState(false, paneState.widthPx)
                  }
                } else {
                  // FR-009: dragging the pane open with no panels bound (or returning to the chat
                  // view) shows the launcher, same as closing the last open panel -- never a
                  // forced default panel, never snapping back shut.
                  paneState.syncRenderedState(true, size.inPixels)
                  resumeHostedPanels(paneState.openPanelIds)
                }
              }}
            >
              <ErrorBoundary>
                <div className="h-full" inert={!paneShown} aria-hidden={!paneShown || undefined}>
                  <RightPaneShell
                    sessionId={frontSessionId ?? null}
                    resize={(widthPx) => rightPaneRef.current?.resize(widthPx)}
                  />
                </div>
              </ErrorBoundary>
            </ResizablePanel>
          </ResizablePanelGroup>
          {view === 'chat' && <IconRail sessionId={frontSessionId ?? null} />}
          </div>
        )}
      </div>
      <StatusBar />
      {/* Rendered last (Electron computes `-webkit-app-region` override by DOM document order,
          not paint/z-index order, confirmed live: a `no-drag-region` element earlier in the tree
          than an overlapping `drag-region` one is silently outvoted and the OS still swallows the
          click as a window-drag) so its own `no-drag-region` root always wins over every
          drag-region header it can visually sit on top of (the permanent strip above, the left-nav
          header, and the chat header). */}
      <AppMenuBar />
    </div>
  )
}
