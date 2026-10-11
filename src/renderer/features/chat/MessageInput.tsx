// The message box (docs/DESIGN.md "Chat", "Keyboard"): grows up to ~8 lines, Enter sends,
// Shift+Enter inserts a newline, Esc clears, Ctrl+Shift+X stops a running turn. Queue chips come
// only from `useQueueStore` (queue:update events), never from optimistic local state. The
// slash-command menu (T044, FR-032, FR-033) lives in SlashMenu.tsx; this file only decides when
// to show it and handles the keys that drive it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  ClipboardEvent as ReactClipboardEvent,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { ArrowUpIcon, CpuIcon, GaugeIcon, SlashIcon, SquareIcon, TypeIcon, XIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { formatModelLabel, formatThinkingLevelLabel } from '@/lib/modelDisplay'
import { EMPTY_QUEUE, notify, SIDE_CHAT_LOADING_HINT, useChatScrollStore, useCommandsStore, useDraftStore, useQueueStore, useRightPaneStore, useSessionsStore, useSettingsStore, useSideChatStore, useSplitStore } from '@/state'
import type { SessionStatusEvent, SlashCommand } from '../../../shared/ipc'
import { describeStopReason } from './ChatPane'
import { filterSlashCommands, parseSlashQuery, SlashMenu, slashOptionId } from './SlashMenu'
import { ApprovalModePill } from './ApprovalModePill'
import {
  ChangesChip,
  ContextUsageChip,
  CurrentTimeChip,
  PullRequestChip,
  SubagentsChip,
  TodoProgressChip,
  TurnTimeChip
} from './readout/ReadoutChips'
import { AttachmentStrip, ChipOverlaySegments } from './AttachmentStrip'
import {
  buildChipLabel,
  buildImageAttachment,
  EMPTY_ATTACHMENTS,
  findChipOccurrences,
  findClipboardImageItem,
  formatByteSize,
  isLargePaste,
  pruneDanglingChips,
  substituteChips,
  toImageContent
} from './attachments'
import type { PendingTextChip } from './attachments'
import { deriveQueuedChips, EMPTY_CHIP_POOL, type ChipPoolState, type DerivedChip } from './queuedChips'
import { MAX_IMAGE_INPUT_BYTES } from '../../../shared/images'
import { parseSlashCommand } from '../../../shared/slash-commands'

type StopReason = SessionStatusEvent['stopReason']

// Stable reference so the zustand selector below never returns a fresh array when there is no
// match; a new `[]` literal every call breaks useSyncExternalStore's snapshot stability and
// causes an infinite re-render loop.
const EMPTY_COMMANDS: SlashCommand[] = []

// T103, FR-058: debounce before a predict_word request, and a local mirror of the server's own
// gating (rpc.md "Word prediction"): the cursor must sit at the end of its line and end a
// plausible prose word, with no slash-command or path-shaped token being typed. Keeping this
// local means the vast majority of keystrokes (mid-word, mid-line, slash commands, paths) never
// reach a request at all; the server re-applies the same gates regardless.
const GHOST_TEXT_DEBOUNCE_MS = 300

function isGhostTextEligible(text: string, cursor: number): boolean {
  if (cursor < 0 || cursor > text.length) return false
  const after = text.slice(cursor)
  const nextNewline = after.indexOf('\n')
  const restOfLine = nextNewline === -1 ? after : after.slice(0, nextNewline)
  if (restOfLine.length > 0) return false // cursor is not at the end of its line

  const lastNewline = text.lastIndexOf('\n', cursor - 1)
  const line = text.slice(lastNewline + 1, cursor)
  if (line.trim() === '') return false // nothing typed on this line yet
  if (/^\s*\//.test(line)) return false // a slash-command draft, e.g. "/mo"
  if (!/[A-Za-z]+$/.test(line)) return false // cursor doesn't end a prose word

  const token = /\S+$/.exec(line)?.[0] ?? ''
  if (token.includes('/') || token.includes('\\')) return false // a file-path-shaped token

  return true
}

interface MessageInputProps {
  sessionId: string
  stopReason?: StopReason
  stopDetail?: string
  /** Focus the textarea once on mount. Set only by ChatPane when this session's MessageInput
   * instance is a fresh remount (`key={sessionId}`) replacing one that had focus (e.g. a
   * notification reopening the Session the user was typing in); never on first load. */
  autoFocusOnMount?: boolean
}

export function MessageInput({ sessionId, stopReason, stopDetail, autoFocusOnMount }: MessageInputProps) {
  const status = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status ?? 'stopped')
  const sessionReadout = useSettingsStore((s) => s.settings.sessionReadout)
  // T063: last known provider/model/effort (T062's `lastModel`/`lastThinkingLevel` on the same
  // `SessionSummary` row), never a separate live-only source -- shown as two icon-led labels
  // (CpuIcon for model, GaugeIcon for thinking level) instead of a bracketed "(Effort)" suffix
  // (docs/DESIGN.md "No bracket/parenthetical UI copy"). `null` before the first `get_state`
  // this Session has ever reported one.
  const modelSession = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId))
  const modelLabel = formatModelLabel(modelSession ?? {})
  const thinkingLabel = formatThinkingLevelLabel(modelSession ?? {})
  const { followUp, steering } = useQueueStore((s) => s.bySession[sessionId] ?? EMPTY_QUEUE)
  // Issue #540 (#591 cycle 3, full architectural replacement): chip identity/text/queue come
  // ONLY from the real `followUp`/`steering` arrays above via `deriveQueuedChips`
  // (queuedChips.ts) -- there is no more client-tracked "reserved"/"confirmed"/"pending" chip
  // state to keep in sync with the server. `inFlightChips` single-flights Send now/Remove per
  // chip (keyed by the chip's own stable identity, not its text, so a Remove in flight on one
  // chip never shows a busy state on an unrelated chip that merely shares the same text),
  // recording WHICH action is in flight so each button only ever announces its own operation.
  const [inFlightChips, setInFlightChips] = useState<ReadonlyMap<string, 'send' | 'remove'>>(new Map())
  // Last-committed per-occurrence chip id pool (queuedChips.ts): read during render by the
  // `chips` memo below, and written only in the layout effect after commit -- never during
  // render itself -- so a discarded or interrupted render (including React StrictMode's
  // dev-only double-invoked renders) can never advance it.
  const chipPoolRef = useRef<ChipPoolState>(EMPTY_CHIP_POOL)
  // Issue #540 (#591 cycle 3): tracks which chip (by stable key) and which action button
  // (`send`/`remove`) currently holds focus, read off each button's own `data-chip-key`/
  // `data-chip-action` attributes by the `<ul>`'s delegated focus handlers below -- lets the
  // layout effect below restore focus to the SAME occurrence's originally-focused action button
  // (falling back to Remove if that control no longer exists on the chip) after OMP's real
  // `queue_update` reorders the list (React moves, rather than remounts, a same-keyed `<li>`
  // via `insertBefore`, which Chromium blurs to `<body>`).
  const focusedChipRef = useRef<{ key: string; action: 'send' | 'remove' } | null>(null)
  const commands = useCommandsStore((s) => s.bySession[sessionId] ?? EMPTY_COMMANDS)
  // Spec 010: draft text lives in draft-store.ts, keyed by sessionId, instead of local useState,
  // so it survives this component unmounting (a ChatPane.tsx `key={sessionId}` Session switch,
  // or App.tsx's Settings view-swap) rather than being silently discarded (FR-001).
  const text = useDraftStore((s) => s.bySession[sessionId]?.text ?? '')
  const [starting, setStarting] = useState(false)
  const [slashActiveIndex, setSlashActiveIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const stopReasonId = `${sessionId}-stop-reason`
  const slashMenuId = `${sessionId}-slash-menu`
  // Accessibility remediation (High): a transient polite announcement for a chip being created,
  // an image being attached, or a chip being silently dropped (FR-014) -- none of which otherwise
  // reach a screen-reader user, who only ever hears the textarea's own plain-text value. Separate
  // live region from the slash-menu one below so an attachment event is never swallowed by (or
  // swallows) an unrelated "No matching commands" announcement.
  const [attachmentAnnouncement, setAttachmentAnnouncement] = useState<{ seq: number; message: string } | null>(
    null
  )
  const announceSeqRef = useRef(0)
  // Medium fix (a11y, #598): a repeated identical announcement (e.g. pasting the same image
  // twice, or two Removes in a row that both announce "Queued message removed.") must still
  // re-render the live region even though the message text is unchanged. The previous
  // `null`-then-value "clear and reset" dance relied on the clear actually committing as its
  // own render before the real value landed -- which React 18/19's automatic batching does not
  // guarantee outside a discrete event (e.g. after an `await`, as `handleRemoveQueued` calls
  // this): both updates can land in the SAME commit, in which case the DOM's text node never
  // changes at all and the announcement is silently swallowed. A monotonically-increasing
  // sequence number, keyed onto the rendered node's identity below, forces a genuinely new node
  // every call, independent of whether the message text repeats.
  const announceAttachment = useCallback((message: string) => {
    announceSeqRef.current += 1
    setAttachmentAnnouncement({ seq: announceSeqRef.current, message })
  }, [])
  const attachmentsStatusId = `${sessionId}-attachments-status`
  const attachmentsSummaryId = `${sessionId}-attachments-summary`
  // Issue #533: sr-only accessible description for the composer's empty-state hint overlay --
  // an inert overlay cannot act as a native `placeholder` for assistive tech, so the same
  // content reaches it through `aria-describedby` instead (gated off whenever the overlay
  // itself is not shown, mirroring `ghostHintId`/`attachmentsSummaryId` above).
  const composerHintId = `${sessionId}-composer-hint`

  const statusRef = useRef(status)
  statusRef.current = status
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  // Quality-gate remediation (accessibility-auditor, High, also FR-010): this component's own
  // Ctrl+Shift+X listener is a window-level listener, one per mounted MessageInput -- with a
  // split open, BOTH panes' listeners used to fire on the same keypress, so Stop silently acted
  // on whichever pane's Session happened to be `working`, including the UNFOCUSED one, with no
  // way to target just one pane from the keyboard (the pointer-driven Stop button is already
  // correctly scoped, since it lives inside this exact pane). Gated below so only the focused
  // pane's own listener (or the sole listener, when there is no split) ever acts.
  const isFocusedPane = useSplitStore((s) => s.paneSessionIds.length < 2 || s.paneSessionIds[s.focusedIndex] === sessionId)
  const isFocusedPaneRef = useRef(isFocusedPane)
  isFocusedPaneRef.current = isFocusedPane
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  // Issue #540 (Medium gate fix, #591): container for the queued-message chip row, queried by
  // stable chip key so focus can be moved explicitly after Send now/Remove settles, rather than
  // relying on the DOM happening to preserve the right node through a state transition.
  const chipListRef = useRef<HTMLUListElement>(null)
  // Spec 009: pending images and oversized-text chips for the draft currently being composed
  // (data-model.md "AttachmentsState"). Spec 010: held in draft-store.ts alongside `text`
  // above, keyed by sessionId -- renderer-memory-only, cleared on send success (FR-007) but no
  // longer on this component's own remount (spec 010 FR-002, FR-003).
  const attachments = useDraftStore((s) => s.bySession[sessionId]?.attachments ?? EMPTY_ATTACHMENTS)
  // Mirrors the ghost-text overlay's own scroll-sync div (T103, FR-058) for the text-chip
  // overlay: an inert sibling matching the textarea's box model so each chip's clickable overlay
  // lands exactly over its label's rendered position (research.md Decision 10).
  const chipOverlayRef = useRef<HTMLDivElement>(null)
  // T103, FR-058: ghost-text composer completion. `ghost` is the suggestion actually shown,
  // bound to the exact draft/cursor it was requested for; `ghostGenerationRef` guards a
  // predictWord response against a newer edit superseding it before it resolves (same guard as
  // SessionDetailsCard's diffStat stale-response fix).
  const [ghost, setGhost] = useState<{ text: string; cursor: number; suffix: string } | null>(null)
  // Mirrors `ghost` for `handleSend`'s async body (#358/#359 round-3 remediation): that function is an
  // ordinary closure captured once per render, so after its `await`s resolve its own `ghost`
  // binding is whatever was current when it started -- stale against anything that happened
  // during the gap. Refs are stable across renders, so reading through `ghostRef` instead always
  // sees the live value regardless of which render's closure is asking.
  const ghostRef = useRef<typeof ghost>(null)
  const ghostGenerationRef = useRef(0)
  const ghostDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ghostHintId = `${sessionId}-ghost-hint`
  // Separate from `ghost` so the screen-reader hint doesn't flicker through '' and back on every
  // debounce cycle: `scheduleGhostCheck` clears `ghost` (and the overlay) immediately on each
  // edit, but leaves the last-announced suggestion text alone until eligibility fails outright or
  // a new suggestion actually resolves. Re-announcing identical text on every keystroke is what
  // the remediation review flagged for a slow typist (#358/#359).
  const [announcedSuggestion, setAnnouncedSuggestion] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      if (ghostDebounceRef.current) clearTimeout(ghostDebounceRef.current)
    }
  }, [])

  // Keeps the overlay's scroll position pinned to the textarea's whenever a suggestion is newly
  // shown (the `onScroll` handler below covers scrolling while one is already showing) (#359).
  useEffect(() => {
    if (ghost && overlayRef.current && textareaRef.current) {
      overlayRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }, [ghost])

  // Same scroll-sync reasoning as the ghost overlay above, for the text-chip overlay: pins its
  // scroll position whenever the set of pending chips changes (the `onScroll` handler below
  // covers scrolling while chips are already showing).
  useEffect(() => {
    if (chipOverlayRef.current && textareaRef.current) {
      chipOverlayRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }, [attachments.textChips])

  useEffect(() => {
    if (autoFocusOnMount) textareaRef.current?.focus()
    // High remediation (accessibility-auditor, quality gate 2026-10-04): a restored
    // (non-empty) draft's own caret otherwise lands at position 0, not the end -- live-verified
    // against this same Electron build: a controlled <textarea> does NOT default its caret to
    // the end of a non-empty `value` set at mount, focused or not (spec.md's Clarifications
    // wrongly assumed it would). Setting it explicitly, every mount, matches how a freshly typed
    // draft already looks and keeps a keyboard-only user (Tab back in, or a focus-carrying
    // Session switch) from silently prepending into restored text (FR-001).
    const end = textareaRef.current?.value.length ?? 0
    textareaRef.current?.setSelectionRange(end, end)
    // Runs once per mount only: this component remounts (`key={sessionId}`) whenever the
    // visible Session changes, so re-running on prop changes would steal focus back after the
    // user deliberately moves it elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isWorking = status === 'working'
  const notStarted = status === 'stopped' && stopReason === 'not-started'
  const disabled = status === 'stopped' && !notStarted

  const slashQuery = parseSlashQuery(text)
  const slashMatches = slashQuery !== null ? filterSlashCommands(slashQuery, commands) : EMPTY_COMMANDS
  const showSlashMenu = slashQuery !== null && !slashDismissed
  // `slashActiveIndex` is reset to 0 by the post-commit effect below, but for the one commit in
  // between a shorter filtered list and that effect running, it can still reference a row past
  // the end -- clamp at render so `aria-activedescendant` and the highlighted option never
  // point at a row that no longer exists.
  const clampedSlashActiveIndex = slashMatches.length > 0 ? Math.min(slashActiveIndex, slashMatches.length - 1) : 0

  // Issue #540 (#591 cycle 3, full architectural replacement): chip identity/text/queue/
  // position come ONLY from the real `followUp`/`steering` arrays -- `deriveQueuedChips`
  // (queuedChips.ts) is a pure function the component merely feeds its own persisted id pool
  // through via `chipPoolRef`.
  //
  // Medium (code-reviewer, #598): the pool commit used to happen as a `chipPoolRef.current =`
  // write inside this `useMemo`, i.e. during render. React 19 can discard a render before it
  // commits (an interrupted concurrent render), and a discarded render had already mutated the
  // ref with ids derived from inputs that never actually committed -- the next REAL commit then
  // derived from that phantom state. `chips` below is now read-only during render (it always
  // reads the last-COMMITTED pool off the ref, never writes it); the actual commit is deferred
  // to the `useLayoutEffect` right after it, which only ever runs for a render that committed.
  // `deriveQueuedChips` is pure and cheap (small arrays), so recomputing it there is fine.
  const chips = useMemo<DerivedChip[]>(
    () => deriveQueuedChips(followUp, steering, chipPoolRef.current).chips,
    [followUp, steering]
  )
  useLayoutEffect(() => {
    chipPoolRef.current = deriveQueuedChips(followUp, steering, chipPoolRef.current).nextPool
  }, [followUp, steering])

  // Tracks the previous commit's `chips` (Issue #540/#598 High): when the tracked chip's key
  // disappears from the real arrays entirely (the server delivered it, e.g. a steering chip was
  // sent at the next turn), this is the only way to know which chip used to sit next to it, so
  // focus can move to the nearest SURVIVING chip instead of being left stranded on `<body>`.
  const previousChipsRef = useRef<DerivedChip[]>([])

  // Issue #540 (#591 cycle 3, High finding): a real `queue_update` moving which array
  // (`followUp` vs `steering`) a duplicate-text chip renders from reorders its `<li>` via
  // React's keyed reconciliation (`insertBefore`, not a remount, since the key is stable) --
  // Chromium blurs a focused element when its node is moved like that, even though the user
  // didn't click anywhere. Runs synchronously (layout phase, not an ordinary effect) so focus
  // never visibly rests on `<body>` for a frame: only acts when focus is actually stranded
  // (null/`<body>`/disconnected).
  //
  // Gate fix (Medium, #598): this is now the SOLE focus-restoration mechanism for the chip
  // list -- it handles a user-initiated Remove and a server-driven delivery/removal uniformly,
  // since `handleRemoveQueued` below no longer does any focus management of its own. Two
  // competing mechanisms here used to race (whichever of the RPC result or the server's own
  // `queue_update` frame arrived first would decide where focus landed); there is now exactly
  // one path, regardless of which event fired the update.
  //
  // If the tracked chip's own key still exists, this restores focus to it, preferring the SAME
  // action button the user originally focused (falling back to Remove if that control no
  // longer exists on the chip, e.g. a promoted follow-up losing its Send now button). If the
  // key is gone (the server delivered/removed it, or a user Remove just succeeded) focus moves
  // to the nearest surviving chip's Remove button -- always Remove here, since this is a
  // DIFFERENT chip than the one originally focused, which may not even have a Send now button
  // -- (the one that now occupies the removed chip's old position, falling back to the one
  // before it), or to the textarea if no chips remain at all. `focusedChipRef` is cleared in
  // every one of these "key is gone" outcomes, since none of them leave a chip tracked as
  // focused anymore.
  useLayoutEffect(() => {
    const previousChips = previousChipsRef.current
    previousChipsRef.current = chips
    const tracked = focusedChipRef.current
    if (!tracked) return
    const active = document.activeElement
    const stranded = active == null || active === document.body || !active.isConnected
    if (!stranded) return
    if (chips.some((chip) => chip.key === tracked.key)) {
      const row = chipListRef.current?.querySelector<HTMLElement>(`[data-chip-key="${CSS.escape(tracked.key)}"]`)
      const target =
        tracked.action === 'send'
          ? (row?.querySelector<HTMLButtonElement>('button[data-chip-action="send"]') ??
            row?.querySelector<HTMLButtonElement>('button[data-chip-action="remove"]'))
          : row?.querySelector<HTMLButtonElement>('button[data-chip-action="remove"]')
      target?.focus()
      return
    }
    focusedChipRef.current = null
    if (chips.length === 0) {
      textareaRef.current?.focus()
      return
    }
    const previousIndex = previousChips.findIndex((chip) => chip.key === tracked.key)
    const nearest =
      previousIndex === -1 ? chips[0]! : (chips[previousIndex] ?? chips[previousIndex - 1] ?? chips[0]!)
    const row = chipListRef.current?.querySelector<HTMLElement>(`[data-chip-key="${CSS.escape(nearest.key)}"]`)
    row?.querySelector<HTMLButtonElement>('button[data-chip-action="remove"]')?.focus()
  }, [chips])

  // Delegated focus tracking for the chip list (Issue #540, #591 cycle 3): records which chip
  // key/action currently holds focus, for the layout effect above to restore after a DOM move.
  // `onBlur` only clears the tracked chip when focus is KNOWINGLY moving elsewhere (a real
  // `relatedTarget`) -- when a focused node is yanked out from under the user by a reorder, the
  // browser blurs with `relatedTarget: null`, and clearing in that case would defeat the whole
  // mechanism.
  //
  // Gate fix (High, #598): a null `relatedTarget` does NOT only mean "a chip's DOM node moved"
  // -- it also happens whenever the user clicks something that can't take focus (empty sidebar
  // space, the header, non-interactive transcript text), which sends focus to `<body>` too. Two
  // layers now handle the two different null-`relatedTarget` causes:
  //
  // 1. A capture-phase `pointerdown` listener on `document` (below) clears the tracked chip the
  //    moment a genuine click-away is detected, synchronously, before this blur handler even
  //    runs -- a real DOM-move-caused blur never fires a pointerdown at all, so this can't
  //    misfire on that case.
  // 2. For a blur-without-a-prior-pointerdown (e.g. Tab-ing away, or a non-pointer-triggered
  //    blur) this handler defers the decision to a `requestAnimationFrame`: a genuine DOM move
  //    has already been repaired SYNCHRONOUSLY by the layout effect above (which runs before
  //    paint and before any rAF callback), so by the time this rAF runs, a real move will
  //    already have refocused something else -- only a still-unresolved, genuine click-away
  //    still has `activeElement === body` at that point.
  // Low fix (#598): holds the latest scheduled blur-decision rAF id so it can be cancelled on
  // unmount (e.g. a fast Session switch) -- an in-flight callback firing after unmount would
  // still touch `focusedChipRef`, a harmless but pointless stale write.
  const pendingBlurRafRef = useRef<number | null>(null)
  function handleChipListFocus(event: ReactFocusEvent<HTMLUListElement>) {
    const target = event.target as HTMLElement
    const row = target.closest<HTMLElement>('[data-chip-key]')
    const key = row?.getAttribute('data-chip-key')
    const action = target.getAttribute('data-chip-action')
    if (key && (action === 'send' || action === 'remove')) focusedChipRef.current = { key, action }
  }
  function handleChipListBlur(event: ReactFocusEvent<HTMLUListElement>) {
    if (event.relatedTarget) {
      focusedChipRef.current = null
      return
    }
    const el = event.target as HTMLElement
    pendingBlurRafRef.current = requestAnimationFrame(() => {
      pendingBlurRafRef.current = null
      if (document.activeElement === document.body && el.isConnected) focusedChipRef.current = null
    })
  }

  // Gate fix (High, #598), layer 1 of 2 above: clears the tracked chip the instant a genuine
  // click-away is detected, before React's own blur event (and this component's `onBlur`
  // handler) even fires -- `capture: true` so this sees the pointerdown before anything inside
  // the chip list can stop its propagation.
  useEffect(() => {
    function onDocumentPointerDown(event: PointerEvent) {
      if (chipListRef.current?.contains(event.target as Node)) return
      focusedChipRef.current = null
    }
    document.addEventListener('pointerdown', onDocumentPointerDown, true)
    return () => document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  }, [])

  // Low fix (#598): cancels an in-flight blur-decision rAF on unmount, so it can never fire its
  // callback (touching `focusedChipRef`) after the component is gone.
  useEffect(() => {
    return () => {
      if (pendingBlurRafRef.current !== null) cancelAnimationFrame(pendingBlurRafRef.current)
    }
  }, [])

  // The active row resets whenever the typed query changes, so a stale index from a longer list
  // never survives into a shorter, filtered one.
  useEffect(() => {
    setSlashActiveIndex(0)
  }, [slashQuery])

  // Ctrl+Shift+X stops the running turn while this pane is mounted AND focused (docs/DESIGN.md
  // "Keyboard"; spec 005 FR-010: acts only on the focused/owning pane while a split is open).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== 'x') return
      event.preventDefault()
      if (!isFocusedPaneRef.current) return
      if (statusRef.current !== 'working') return
      void window.refract.chat.stop(sessionIdRef.current).then((result) => {
        if (!result.ok) notify(result.error)
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  async function handleSend() {
    if (disabled || starting) return
    const draftText = text
    if (!draftText.trim()) return
    // Enter-send and the Send button both clear the draft via `clear(sessionId)` below, bypassing
    // `scheduleGhostCheck`'s onChange-driven invalidation; without this a shown suggestion would
    // outlive the send with no `accepted: false` feedback (#358/#359 remediation).
    clearGhostState()
    if (notStarted) {
      // Spec 005 (research.md Decision 4): sending the first message to a just-restored,
      // not-yet-opened pane is itself the "real action" that clears its pristine flag. Cleared
      // FIRST, before awaiting open() below: this lets ChatPane's own pristine-cleared effect
      // (triggered by this exact state change) be the SOLE place that calls `applySnapshot` for
      // this open.
      //
      // Quality-gate remediation (code-reviewer, Medium): this branch used to call
      // `applySnapshot` itself too, AFTER its own `open()` resolved -- `markOpened` then flipped
      // `isPristine`, which re-ran ChatPane's effect, which called `open()` again (joining the
      // same already-in-flight/dedup'd promise, harmless) and `applySnapshot` a SECOND time with
      // the SAME pre-send snapshot, racing the real message's own `transcript:patch` events and
      // risking a visible flash back to the pre-send transcript right after sending. Now this
      // branch only awaits `open()` for its own completion signal (to know the agent has
      // actually started before calling `chat.send` below) and never applies the snapshot itself.
      useSplitStore.getState().markOpened(sessionId)
      let snapshot
      try {
        setStarting(true)
        // userAction true: bypass canAutoStart like recover/restore -- a typed send is the
        // one genuine explicit user request through this path (quality-gate fix, issue #509).
        snapshot = await useSessionsStore.getState().open(sessionId, true)
      } finally {
        setStarting(false)
      }
      if (!snapshot) return
    }
    // FR-013: every pending text chip's full original text is substituted back into the draft at
    // its own position before anything reaches `chat.send` -- the plain `message` string OMP ever
    // sees is exactly what the developer would have gotten pasting the whole block directly.
    const message = substituteChips(draftText, attachments.textChips)
    // FR-006: every pending image goes out as a real `images` entry on this same call, whether it
    // sends immediately or queues as a followUp (FR-017) -- `SessionAgent.send` decides which
    // based on the Session's live status, not this call site.
    const images = attachments.images.length > 0 ? attachments.images.map(toImageContent) : undefined
    // Issue #485: a bare `/new` here is `chat.ts`'s own third `conversations.startNew` call
    // site (SessionAgent.startNewConversation, via chat.send) -- unlike ConversationSwitcher's
    // and ChatPane's `handleStartNewConversation`, its reset reaches the renderer as an ordinary
    // `transcript:patch` on the SAME event stream this call's own result races against, not as a
    // returned SessionSnapshot this call site could clear-then-apply itself. Mirrors chat.ts's own
    // `parsed.name === 'new' && parsed.rest === ''` recognition exactly (the only entry in
    // NATIVE_BUILT_COMMANDS with a working implementation) so the clear runs BEFORE the request
    // is even sent -- clearing only after awaiting the result below risks the reset patch having
    // already landed and the Transcript's landing effect already reading the stale memory.
    //
    // Quality-gate remediation (round 2, 2026-10-07): `disabled` (`status === 'stopped' &&
    // !notStarted`, see its definition above) does NOT cover every non-idle status -- a typed
    // `/new` while `status === 'working'` reaches here perfectly able to send, then
    // `SessionAgent.startNewConversation` rejects with `SessionNotIdleError` because a turn is
    // still running. That failed send must not have silently thrown away the developer's restore
    // point for whatever they were reading before typing `/new`: snapshot it first, and only put
    // it back if `chat.send` fails below AND nothing newer has been recorded for this Session in
    // the meantime (`restoreIfAbsent`).
    const slashInvocation = parseSlashCommand(message)
    // FR-007 (constitution II): `/btw` is Refract's own locally-handled native command, never
    // forwarded to OMP as a literal prompt (the defensive `NATIVE_RESERVED_COMMANDS` guard in
    // `chat.ts` would refuse it anyway if this ever slipped through) -- opens and focuses the
    // Side chat panel for this Session (`sideChatFocusRequestId`, bumped inside `openPanel`
    // itself) and, when `.rest` is non-empty, issues the side question itself through
    // `useSideChatStore`, bypassing `chat.send` entirely.
    if (slashInvocation?.name === 'btw') {
      // Gate-fix (round 2, Code2/Sec2 Medium): `btw` carries no `images` field at all
      // (contracts/ipc.md) -- refusing instead of silently dropping the attachments avoids a
      // developer discovering, after the fact, that a pasted screenshot never reached the model.
      if (attachments.images.length > 0) {
        toast.error("Side questions don't support image attachments. Remove them and try again.")
        return
      }
      // Gate-fix (round 2, Code2/Sec2 HIGH): refuses (keeping the draft) instead of sending a
      // second `btw` while one is still running -- spec Assumption 7's single-flight rule applies
      // here exactly as it does to the panel's own Send button.
      if (useSideChatStore.getState().bySession[sessionId]?.running) {
        toast.error('A side question is already running for this Session.')
        return
      }
      // Gate-fix (round 6, Code6 LOW): a bare `/btw` only opens (and focuses) the panel -- moved
      // above the `!loaded` gate below, which otherwise always refused it with an error toast
      // even though it asks nothing and has nothing to load yet.
      if (slashInvocation.rest.length === 0) {
        useRightPaneStore.getState().openPanel('side-chat')
        useDraftStore.getState().clear(sessionId)
        clearGhostState()
        return
      }
      // Gate-fix (round 5, Code5 Medium; round 6, Code6/Sec6/A11y6/Verif6 Medium): the panel's
      // own Send button already refuses while `!loaded` -- this path did not, so `/btw` typed
      // before `loadHistory` finishes (the first one per Session per app run, and every one
      // right after a Conversation change) ran `ask` with `activeTopicRecordId` still
      // `undefined`, silently starting a FRESH topic instead of continuing the Session's real
      // one. Opens the panel WITHOUT moving focus away from the main composer (the draft, and
      // the retry, both stay here) -- `focus: false` leaves `sideChatFocusRequestId` untouched;
      // the panel's own mount effect still fires its own `loadHistory`. Wording matches the
      // actual cause instead of always claiming "still loading": `loadError` means a permanent
      // failure that a retry will not fix either; a stopped Session means there is nothing
      // running yet to load from. Gate-fix (round 8, Code8/A11y8/Sec8/Verif8 Low): the loading
      // branch now uses the SAME `SIDE_CHAT_LOADING_HINT` constant `SideChatPanel.tsx`'s own
      // hint does -- round 7 claimed the two already matched exactly; they never did. Gate-fix
      // (round 9, Code9/A11y9/Sec9 Low): sharing the constant verbatim dropped this toast's own
      // "Try again in a moment." retry guidance (WCAG 3.3.3) -- the persistent hint under the
      // textarea needs no call to action (it is always visible while `!loaded`), but THIS toast
      // is a one-shot message the whole point of which is telling the user what to do next, so
      // it appends its own suffix instead of being pulled into the shared constant.
      if (!useSideChatStore.getState().bySession[sessionId]?.loaded) {
        useRightPaneStore.getState().openPanel('side-chat', { focus: false })
        const sideChatState = useSideChatStore.getState().bySession[sessionId]
        const toastMessage = sideChatState?.loadError
          ? 'Side chat history could not be loaded.'
          : status === 'stopped'
            ? 'Side chat is available once the Session is running.'
            : `${SIDE_CHAT_LOADING_HINT} Try again in a moment.`
        toast.error(toastMessage)
        return
      }
      useRightPaneStore.getState().openPanel('side-chat')
      // Gate-fix (round 2, Code2/Sec2/Verif2 Medium): the draft (and its attachments) only
      // clears AFTER `ask` resolves -- the old code cleared it first, so a question over 10,000
      // characters, a Session with no live process, or any other RPC failure silently lost the
      // typed text with nothing but a toast left behind.
      try {
        await useSideChatStore.getState().ask(sessionId, slashInvocation.rest)
        useDraftStore.getState().clear(sessionId)
        clearGhostState()
      } catch {
        // `ask` already surfaced the failure via toast; keep the draft so the question is not lost.
      }
      return
    }
    const isNewConversationCommand = slashInvocation?.name === 'new' && slashInvocation.rest === ''
    const previousScroll = isNewConversationCommand
      ? useChatScrollStore.getState().bySession[sessionId]
      : undefined
    if (isNewConversationCommand) {
      useChatScrollStore.getState().clear(sessionId)
      // Quality-gate finding (code review, High): the ONLY one of the four call sites whose
      // reset reaches the renderer via an ordinary `transcript:patch` (SessionAgent's own event
      // stream) rather than a `SessionSnapshot` this call site applies itself -- a second
      // `clear()` right before `applySnapshot` (the other three sites' pattern) has no
      // equivalent moment here, so the store-level `inFlight` flag (see `scroll-store.ts`) is
      // the only fix available: blocks `record()` for this Session until `chat.send` below
      // settles, success or failure, so a scroll on the still-visible OLD Conversation during
      // the await can never write a detached position the new (empty) Conversation inherits.
      useChatScrollStore.getState().setInFlight(sessionId, true)
    }
    // Unknown `/name` text is rejected by chat.send with `unknown-command` (FR-033); a listed
    // command given unverified arguments gets `unsupported-arguments` instead (issue #129); notify
    // below shows either as a toast, same as any other IPC error. FR-019: a failed send (whether
    // image-related or not) leaves the draft and every pending attachment untouched -- nothing
    // below this `if` runs until `chat.send` actually succeeds.
    let result
    try {
      result = await window.refract.chat.send(sessionId, message, images)
    } finally {
      if (isNewConversationCommand) {
        useChatScrollStore.getState().setInFlight(sessionId, false)
      }
    }
    if (!result.ok) {
      if (isNewConversationCommand) {
        useChatScrollStore.getState().restoreIfAbsent(sessionId, previousScroll)
      }
      notify(result.error)
      return
    }
    // Spec 010 FR-005: one atomic clear for both text and attachments (replacing the former
    // separate `setText('')`/`setAttachments(EMPTY_ATTACHMENTS)` calls) -- FR-007: pending image
    // attachments clear once the send is accepted, not once the agent's turn finishes; pending
    // text chips are a draft-only concept with nothing left to track once the draft is cleared.
    // Medium remediation (code-reviewer + test-reviewer, quality gate 2026-10-04): the draft now
    // outlives this component, so `await chat.send()` above can straddle a Session switch away
    // and back, or just the user continuing to type/paste during the request -- an unconditional
    // clear here would silently wipe whatever newer draft/attachments now sit in the store, which
    // the old local-`useState` code could never do (a stale `setState` on an unmounted instance
    // was always a no-op). Only clear if the store still holds exactly what THIS send captured
    // (`draftText`/`attachments`, both read at the top of this call); a draft that changed in the
    // meantime is left alone rather than destroyed, even though its now-stale pending attachments
    // (already part of the accepted send) stay visibly pending until removed or sent again.
    const currentDraft = useDraftStore.getState().bySession[sessionId]
    if (currentDraft?.text === draftText && currentDraft?.attachments === attachments) {
      useDraftStore.getState().clear(sessionId)
    }
    // Second invalidation (#358/#359 round-3 remediation): typing during the `await open()` / `await
    // chat.send()` gap above can schedule a fresh ghost-text debounce/request -- or let one
    // already in flight resolve -- against the draft `clear(sessionId)` just wiped; the early
    // `clearGhostState()` above ran before those awaits and can't see state that changed during
    // them. Calling it again here bumps the generation ref (dropping/cancelling anything from the
    // gap), and `dismissGhost` reads through `ghostRef` so this acts on whatever ghost is actually
    // current now, not this function's own stale `ghost` binding from before the awaits.
    clearGhostState()
  }

  /** Enter or Tab on a highlighted slash command (FR-032): fills the box with `/name ` so the
   * box no longer parses as a bare slash query, which closes the menu without extra state. */
  function completeSlashCommand(command: SlashCommand) {
    clearGhostState() // bypasses the normal onChange path too (#358/#359 remediation)
    const nextText = `/${command.name} `
    useDraftStore.getState().setText(sessionId, nextText)
    setSlashDismissed(false)
    // Medium remediation (test-reviewer): this also bypasses onChange's own `pruneDanglingChips`
    // call the same way Enter-send and Esc-clear do -- without this a chip whose label no longer
    // appears in the draft stays pending indefinitely, and a stale pending label can wrongly count
    // as "already used" when a later paste tries to disambiguate against it (compounding the
    // Critical chip-collision remediation above).
    const prunedChips = pruneDanglingChips(nextText, attachments.textChips)
    if (prunedChips.length !== attachments.textChips.length) {
      announceChipRemoval(attachments.textChips.filter((chip) => !prunedChips.includes(chip)))
      useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, textChips: prunedChips }))
    }
  }

  /** Sends `predictWordFeedback` for whatever suggestion is currently shown, at most once per
   * shown-then-abandoned suggestion (FR-058), then clears it. A no-op when nothing is shown. */
  function dismissGhost(accepted: boolean) {
    // Reads `ghostRef` rather than the closed-over `ghost` so a second, post-await call from
    // `handleSend` (#358/#359 round-3 remediation) acts on whatever ghost state is actually current, not a
    // snapshot from before the `await open()` / `await chat.send()` calls.
    const current = ghostRef.current
    if (!current) return
    void window.refract.chat.predictWordFeedback(sessionId, current.text, current.cursor, current.suffix, accepted)
    ghostRef.current = null
    setGhost(null)
  }

  /** Fully resets ghost-prediction state outside the normal onChange path -- Enter-send, plain
   * Esc-clear, and slash-command completion all call `setText` directly, bypassing
   * `scheduleGhostCheck`. Without this, a suggestion computed for the old draft could outlive it:
   * it would render (and be Tab-insertable) over the now-different text, and a request still in
   * flight for the abandoned draft could land afterward and show a stale suggestion (#358/#359
   * remediation). Bumps `ghostGenerationRef` so any in-flight `predictWord` response is dropped
   * on arrival, cancels a pending debounced request before it fires, and dismisses (`accepted:
   * false`) a currently-shown suggestion. */
  function clearGhostState() {
    ghostGenerationRef.current++
    if (ghostDebounceRef.current) {
      clearTimeout(ghostDebounceRef.current)
      ghostDebounceRef.current = null
    }
    dismissGhost(false)
    setAnnouncedSuggestion(null)
  }

  /** Re-evaluates ghost text after every composer edit (FR-058): first dismisses (`accepted:
   * false`) whatever suggestion was showing -- typing past it or deleting into it both count as
   * abandoning it -- then, only when the new draft/cursor passes the local gate
   * (`isGhostTextEligible`), debounces a fresh `predictWord` request. `ghostGenerationRef` is
   * bumped on every call so a response for an already-superseded draft is dropped on arrival
   * instead of showing a stale suggestion. */
  function scheduleGhostCheck(nextText: string, nextCursor: number) {
    const generation = ++ghostGenerationRef.current
    if (ghostDebounceRef.current) {
      clearTimeout(ghostDebounceRef.current)
      ghostDebounceRef.current = null
    }
    dismissGhost(false)
    if (!isGhostTextEligible(nextText, nextCursor)) {
      setAnnouncedSuggestion(null) // no request will be made: nothing left to announce
      return
    }
    ghostDebounceRef.current = setTimeout(() => {
      ghostDebounceRef.current = null
      void window.refract.chat.predictWord(sessionId, nextText, nextCursor).then((result) => {
        if (ghostGenerationRef.current !== generation) return // superseded by a later edit
        if (!result.ok || typeof result.value !== 'string' || result.value.length === 0) {
          // never surfaced as an error: a failed predict_word is just no ghost text, but a
          // lingering stale announcement would mislead a screen reader user
          setAnnouncedSuggestion(null)
          return
        }
        // The caret may have moved away (click/arrow key) *before* this request resolved --
        // the only case the `selectionchange` listener above can't catch, since no *further*
        // selection change happens after a caret move that predates the suggestion's arrival.
        // Showing it now would render (and let Tab insert) at a cursor position that's no
        // longer current, so require the textarea's live selection to still match the exact
        // collapsed position this request was made for; otherwise drop it, still sending
        // `accepted: false` feedback so the server-side loop sees the same silently-dropped
        // suggestion any other abandoned one gets (round 5 remediation, #358/#359).
        const target = textareaRef.current
        if (!target || target.selectionStart !== nextCursor || target.selectionEnd !== nextCursor) {
          void window.refract.chat.predictWordFeedback(sessionId, nextText, nextCursor, result.value, false)
          setAnnouncedSuggestion(null)
          return
        }
        ghostRef.current = { text: nextText, cursor: nextCursor, suffix: result.value }
        setGhost(ghostRef.current)
        setAnnouncedSuggestion(result.value)
      })
    }, GHOST_TEXT_DEBOUNCE_MS)
  }

  // FR-058: a pure cursor move away from an already-shown suggestion dismisses it too, with no
  // accompanying text edit -- onChange already covers the edit case via `scheduleGhostCheck`'s own
  // `dismissGhost` call. React's `onSelect` prop (the native `select` DOM event) looked like the
  // obvious hook for this, but live verification found Chromium never actually fires `select` for
  // a plain caret reposition -- only for an actual non-collapsed text-range selection -- so an
  // `onSelect` handler here was dead code for exactly the click/arrow-key case FR-058 names (round
  // 4 remediation, #358/#359). `selectionchange` (necessarily document-scoped: the Selection APIs
  // have no per-element event) fires for both a click and a bare arrow key. Mount-once (`[]`) like
  // the autoFocus effect below: reads `ghostRef` rather than `ghost` state, so it never goes stale
  // across renders, same reasoning as `dismissGhost` itself.
  useEffect(() => {
    function handleSelectionChange() {
      const target = textareaRef.current
      if (!target || document.activeElement !== target) return
      const current = ghostRef.current
      if (!current) return
      if (target.selectionStart !== current.cursor || target.selectionEnd !== current.cursor) {
        dismissGhost(false)
        setAnnouncedSuggestion(null)
      }
    }
    document.addEventListener('selectionchange', handleSelectionChange)
    return () => document.removeEventListener('selectionchange', handleSelectionChange)
  }, [])

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (showSlashMenu) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSlashActiveIndex((index) => Math.min(index + 1, Math.max(slashMatches.length - 1, 0)))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSlashActiveIndex((index) => Math.max(index - 1, 0))
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && slashMatches.length > 0) {
        event.preventDefault()
        const command = slashMatches[Math.min(slashActiveIndex, slashMatches.length - 1)]
        if (command) completeSlashCommand(command)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSlashDismissed(true)
        return
      }
    }
    // Tab accepts a shown ghost-text suggestion (FR-058); with none shown, or modified (Shift+Tab
    // / Ctrl+Tab / Alt+Tab / Meta+Tab focus movement, or mid-IME-composition), Tab is left
    // unhandled below so it keeps its normal field-leaving focus-movement behavior. `ghost.text
    // === text` is an extra invariant on top of the generation bump: a suggestion computed
    // against a draft that's since changed outside the normal onChange path must never be
    // insertable (#358 remediation).
    if (
      ghost &&
      ghost.text === text &&
      event.key === 'Tab' &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault()
      const { cursor, suffix } = ghost
      const nextText = text.slice(0, cursor) + suffix + text.slice(cursor)
      const nextCursor = cursor + suffix.length
      void window.refract.chat.predictWordFeedback(sessionId, ghost.text, ghost.cursor, ghost.suffix, true)
      ghostGenerationRef.current++ // invalidate any request still in flight for the old draft
      ghostRef.current = null
      setGhost(null)
      setAnnouncedSuggestion(null)
      useDraftStore.getState().setText(sessionId, nextText)
      requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(nextCursor, nextCursor)
      })
      return
    }
    // `ghost.text === text` guard mirrors the Tab-accept and render invariants above: a stale
    // ghost computed against a draft that's since changed outside the normal onChange path (e.g.
    // #358/#359's round-3 post-send gap) must not swallow Esc into a silent no-op dismiss -- fall through to
    // the real composer-clear Esc below instead.
    if (ghost && ghost.text === text && event.key === 'Escape') {
      event.preventDefault()
      dismissGhost(false)
      setAnnouncedSuggestion(null)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSend()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      clearGhostState()
      useDraftStore.getState().setText(sessionId, '')
      // Medium remediation (test-reviewer): same bypass as `completeSlashCommand` above --
      // plain Esc-clear calls `setText` directly too, skipping onChange's own
      // `pruneDanglingChips`. Every chip's label is gone from the (now-empty) draft, so this
      // simply drops them all, with the same silent-removal announcement any other drop gets.
      const prunedChips = pruneDanglingChips('', attachments.textChips)
      if (prunedChips.length !== attachments.textChips.length) {
        announceChipRemoval(attachments.textChips.filter((chip) => !prunedChips.includes(chip)))
        useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, textChips: prunedChips }))
      }
    }
  }

  async function handleStop() {
    const result = await window.refract.chat.stop(sessionId)
    if (!result.ok) notify(result.error)
  }

  // Issue #540 (#591 cycle 3): single-flight per chip (keyed by the chip's own stable identity,
  // not its text, so two chips sharing the same text never share a busy state) -- the button
  // already disables while `inFlightChips` has this key (see the chip render below), but this
  // guard also stops a second call that somehow still lands (e.g. a fast double Enter on a
  // focused button) from firing a duplicate request.
  async function handleRemoveQueued(chip: DerivedChip) {
    if (inFlightChips.has(chip.key)) return
    setInFlightChips((prev) => new Map(prev).set(chip.key, 'remove'))
    const result = await window.refract.chat.removeQueued(sessionId, chip.text, chip.queue)
    setInFlightChips((prev) => {
      const next = new Map(prev)
      next.delete(chip.key)
      return next
    })
    if (!result.ok) {
      notify(result.error)
      return
    }
    if (!result.value.removed) {
      // Gate fix (Medium, #591): a steering chip is already being delivered -- Remove silently
      // doing nothing left the user with no idea why nothing happened. `toast.warning` carries
      // the design system's severity icon (docs/design/components.md "Toasts and notices" on
      // `origin/docs/design-system-474`); the sr-only announcement is dropped here since the
      // toast is itself a live region, so a screen reader no longer hears the same sentence
      // twice.
      toast.warning('This message is already being delivered and can no longer be removed.')
      return
    }
    // Optional a11y remediation (#591): a successful Remove previously had no announcement at all.
    announceAttachment('Queued message removed.')
    // Gate fix (Medium, #598): a successful Remove no longer does any focus management of its
    // own -- the chip's key is now gone from the real `followUp`/`steering` arrays, and the
    // shared layout effect above is the SOLE mechanism that restores focus for every "key is
    // gone" outcome, uniformly, whether the key disappeared via this user-initiated Remove or a
    // server-driven delivery/removal: it moves focus to the nearest surviving chip's Remove
    // button, or to the composer textarea once no chips remain. Two competing focus mechanisms
    // used to race here (whichever of this RPC's result or the server's own `queue_update`
    // frame arrived first would "win"), landing focus unpredictably; there is now exactly one
    // path.
  }

  async function handleSendNow(chip: DerivedChip) {
    if (inFlightChips.has(chip.key)) return
    setInFlightChips((prev) => new Map(prev).set(chip.key, 'send'))
    // Issue #540 (#591 cycle 3): no reservation, no optimistic state -- this busy mark is purely
    // visual (aria-busy/aria-disabled plus the "Sending now…" button text) and never changes
    // which array the chip renders from, so its DOM node never moves or remounts just because
    // it went busy. No pre-await focus call is needed either, for the same reason.
    announceAttachment('Sending now…')
    // `chat.sendNow` takes no `images` argument: OMP's `promote_queued_message` moves the queued
    // message (attachments included) rather than reprocessing it, so this call site must never
    // touch, forward, or clear the composer's own current pending images.
    const result = await window.refract.chat.sendNow(sessionId, chip.text)
    setInFlightChips((prev) => {
      const next = new Map(prev)
      next.delete(chip.key)
      return next
    })
    if (!result.ok) {
      // Gate fix (High, #591): an RPC-level failure (as opposed to the legitimate "already
      // delivered" case below) now throws in `SessionAgent.sendNow`, so it surfaces here and
      // `notify` already shows a visible toast -- no separate copy needed at this call site.
      notify(result.error)
      // Clears the sr-only live region's stale "Sending now…" text -- without this, a screen
      // reader user who checks the live region later still hears the in-flight announcement
      // even though the action has already finished (unsuccessfully).
      announceAttachment('')
      return
    }
    if (!result.value.promoted) {
      // Issue #540: `promoted: false` means it was no longer pending at dispatch time (e.g.
      // already delivered) -- not an RPC-level error, but silence (sr-only announcement alone)
      // is exactly the no-visible-feedback bug this gate fix corrects (High, #591). The message
      // was NOT lost -- it may already have been sent -- so "could not be sent" would be wrong.
      // `toast.info` carries the severity icon; the stale "Sending now…" live-region text is
      // cleared here too (#591 cycle 3), matching the RPC-failure path above.
      announceAttachment('')
      toast.info('This message is no longer queued; it may already have been sent.')
      return
    }
    // Issue #540 (#591 cycle 3): aside from the announcement below, do nothing else -- the
    // real `queue_update` frame moves this text from `followUp` to `steering` whenever OMP
    // sends it, which may arrive before or after this promise resolves; both orderings are fine
    // and need no special-casing, since the UI never tries to predict or pre-empt that move.
    // OMP's `promote_queued_message` promotes by TEXT, FIFO (FINDINGS item 46), not by which
    // visual occurrence was clicked, so if two occurrences shared this text, which stable
    // chip-key ends up labeled `steering` is a harmless, natural consequence of
    // `queuedChips.ts`'s own front-to-back id allocation -- never something this handler tries
    // to track or correct.
    // Medium (a11y, #598): the live region otherwise keeps showing "Sending now…" forever --
    // the only two paths that cleared/replaced it were the two failure branches above. This
    // phrasing describes the MESSAGE TEXT's outcome, not a specific chip, so it stays accurate
    // regardless of which exact duplicate-text occurrence OMP's FIFO semantics actually promoted.
    announceAttachment('Message will be sent at the next step.')
  }

  /** Accessibility remediation (High): announces a chip's own silent removal (`pruneDanglingChips`
   * dropping it because its label no longer appears intact in the draft, FR-014) via the live
   * region above -- a screen-reader user otherwise gets no indication that editing, clearing, or
   * completing a slash command discarded a whole pasted block, with the broken label text sent in
   * its place and no undo. A no-op when nothing was actually removed. */
  function announceChipRemoval(removed: readonly PendingTextChip[]) {
    const [first] = removed
    if (!first) return
    announceAttachment(
      removed.length === 1 ? `Pasted text attachment ${first.label} removed.` : `${removed.length} pasted text attachments removed.`
    )
  }

  /** FR-001 to FR-003, FR-010, FR-011, Edge Cases: an image representation always wins over a
   * plain-text one when a paste carries both (e.g. a spreadsheet-cell copy) -- the text
   * representation is never also turned into a chip in that case. A short paste (at or under the
   * chip threshold) falls through untouched, landing in the textarea exactly as before (FR-010);
   * this handler only ever intervenes for an image or an over-threshold text block. */
  async function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const data = event.clipboardData
    const imageFile = findClipboardImageItem(data)
    if (imageFile) {
      // FR-001: never let any image data reach the textarea's own text value.
      event.preventDefault()
      const result = await buildImageAttachment(imageFile)
      if (!result.ok) {
        notify({
          code: result.reason === 'too-large' ? 'image-too-large' : 'invalid-argument',
          message:
            result.reason === 'too-large'
              ? `Image is too large to attach (over the ${formatByteSize(MAX_IMAGE_INPUT_BYTES)} limit); nothing was attached.`
              : 'That image could not be read; nothing was attached.'
        })
        return
      }
      useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, images: [...prev.images, result.attachment] }))
      announceAttachment(`Image attached, ${formatByteSize(result.attachment.byteLength)}.`)
      return
    }

    const pastedText = data.getData('text/plain')
    if (!isLargePaste(pastedText)) return // FR-010: at or under the threshold, paste as normal

    // FR-011: collapse it into a pending text chip, replacing the raw text at the paste position
    // with a short literal label instead of inserting the raw block.
    event.preventDefault()
    const target = event.currentTarget
    const start = target.selectionStart
    const end = target.selectionEnd
    const existingLabels = new Set(attachments.textChips.map((chip) => chip.label))
    const label = buildChipLabel(pastedText, existingLabels)
    const nextText = text.slice(0, start) + label + text.slice(end)
    const nextCursor = start + label.length
    useDraftStore.getState().setText(sessionId, nextText)
    setSlashDismissed(false)
    scheduleGhostCheck(nextText, nextCursor)
    useDraftStore.getState().setAttachments(sessionId, (prev) => ({
      ...prev,
      textChips: [...prev.textChips, { kind: 'text-chip', id: crypto.randomUUID(), text: pastedText, label }]
    }))
    announceAttachment(`Pasted text collapsed into an attachment: ${label}. Review it in Pending attachments.`)
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  function handleRemoveImage(id: string) {
    useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, images: prev.images.filter((image) => image.id !== id) }))
  }

  const placeholder = disabled
    ? describeStopReason(stopReason, stopDetail)
    // Issue #533: the empty-state hint overlay below now carries this copy (with icons), so the
    // native `placeholder` is left empty here to avoid drawing both on top of each other -- the
    // disabled branch above is unchanged, it has no overlay.
    : ''
  // Accessibility remediation (High): a short, persistent sr-only summary of how many
  // attachments are pending right now, pointed to by the textarea's own `aria-describedby` --
  // the only programmatic link from the textarea to its pending chips/images before this.
  const pendingAttachmentsCount = attachments.images.length + attachments.textChips.length
  const describedByIds = [disabled ? stopReasonId : null, ghostHintId, attachmentsSummaryId, composerHintId].filter(Boolean).join(' ')

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-divider px-4 py-3">
      {chips.length > 0 && (
        <ul
          ref={chipListRef}
          aria-label="Queued messages"
          className="m-0 flex list-none flex-wrap gap-1.5 p-0"
          onFocus={handleChipListFocus}
          onBlur={handleChipListBlur}
        >
          {chips.map((chip) => {
            const busyAction = inFlightChips.get(chip.key)
            const sendBusy = busyAction === 'send'
            const removeBusy = busyAction === 'remove'
            const anyBusy = busyAction != null
            const removeLabel = removeBusy ? `Removing queued message: ${chip.text}` : `Remove queued message: ${chip.text}`
            return (
              <li key={chip.key} data-chip-key={chip.key}>
                <Badge
                  variant="secondary"
                  className="h-auto max-w-full gap-1.5 overflow-visible py-0.5 pr-0.5"
                >
                  <span className="max-w-64 truncate" title={chip.text}>
                    {chip.text}
                  </span>
                  {/* Issue #540 (#591 cycle 3): Send now is offered only for a real follow-up
                   * chip -- OMP's `promote_queued_message` only ever matches a queued
                   * follow-up, so a steering chip's "Send now" could never succeed. A steering
                   * chip instead shows a quiet status: it is already on its way to the agent's
                   * next step. The control stays a `Button` throughout its busy state (never
                   * swapped for inert text) so focus is never lost to the busy transition
                   * itself. */}
                  {chip.queue === 'followUp' ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      data-chip-action="send"
                      aria-label={sendBusy ? `Sending now: ${chip.text}` : `Send now: ${chip.text}`}
                      aria-busy={sendBusy}
                      aria-disabled={anyBusy}
                      className="rounded-full px-2 text-[0.7rem] font-medium aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                      onClick={() => {
                        if (anyBusy) return
                        void handleSendNow(chip)
                      }}
                    >
                      {sendBusy ? 'Sending now…' : 'Send now'}
                    </Button>
                  ) : (
                    <span className="px-1 text-[0.7rem] text-muted-foreground">Sending at the next step</span>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        data-chip-action="remove"
                        aria-label={removeLabel}
                        aria-busy={removeBusy}
                        aria-disabled={anyBusy}
                        className="rounded-full text-muted-foreground hover:text-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                        onClick={() => {
                          if (anyBusy) return
                          void handleRemoveQueued(chip)
                        }}
                      >
                        <XIcon className="size-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{removeLabel}</TooltipContent>
                  </Tooltip>
                </Badge>
              </li>
            )
          })}
        </ul>
      )}
      {disabled && (
        <span id={stopReasonId} className="sr-only">
          {placeholder}
        </span>
      )}
      <div role="status" aria-live="polite" className="sr-only">
        {showSlashMenu && slashMatches.length === 0 ? 'No matching commands' : ''}
      </div>
      {/* Accessibility remediation (High): announces a chip/image being created or a chip being
          silently dropped (`announceChipRemoval`, `handlePaste`) -- separate from the slash-menu
          status above so the two never step on each other. */}
      <div id={attachmentsStatusId} role="status" aria-live="polite" className="sr-only">
        <span key={attachmentAnnouncement?.seq ?? 0}>{attachmentAnnouncement?.message ?? ''}</span>
      </div>
      <span id={attachmentsSummaryId} className="sr-only">
        {pendingAttachmentsCount > 0
          ? `${pendingAttachmentsCount} pending attachment${pendingAttachmentsCount === 1 ? '' : 's'}`
          : ''}
      </span>
      {/* Issue #533: sr-only description for the composer's empty-state hint overlay below --
          an inert overlay is not read as a `placeholder` by assistive tech, so the same wording
          reaches it through `aria-describedby` instead. Empty whenever the visible hint itself
          is not shown (disabled, or the draft has text), same pattern as `ghostHintId`/
          `attachmentsSummaryId` above. */}
      <span id={composerHintId} className="sr-only">
        {!disabled && text === '' ? 'Markdown is supported. Type slash for commands.' : ''}
      </span>
      {/* Chip row (docs/DESIGN.md "Chat"; spec 004 appends readout chips after the pill): the
          Approval mode pill is always the first item, FR-056; `flex-wrap` lets the row wrap onto
          a further line at any window width rather than ever hiding or overlapping the box below
          it (FR-009). Which readout chips render is gated by Settings (FR-012 to FR-014); each
          chip independently hides itself when its own data is null (FR-002 to FR-007, FR-021). */}
      <div className="flex flex-wrap items-center gap-1.5">
        <ApprovalModePill sessionId={sessionId} />
        {sessionReadout.changes && <ChangesChip sessionId={sessionId} />}
        {sessionReadout['context-usage'] && <ContextUsageChip sessionId={sessionId} />}
        {sessionReadout['turn-time'] && <TurnTimeChip sessionId={sessionId} />}
        {sessionReadout['current-time'] && <CurrentTimeChip />}
        {sessionReadout['pull-request'] && <PullRequestChip sessionId={sessionId} />}
        {sessionReadout.subagents && <SubagentsChip sessionId={sessionId} />}
        {sessionReadout['todo-progress'] && <TodoProgressChip sessionId={sessionId} />}
      </div>
      {/* Spec 009, FR-009: the shared attachment strip, directly above the message box, hidden
          entirely while nothing is pending. */}
      <AttachmentStrip images={attachments.images} textChips={attachments.textChips} onRemoveImage={handleRemoveImage} />
      {/* T063/quality-gate fix, Composer tone remediation (2026-10-04); spec 007 T014
          token-ized (FR-007): the composer's fill is a per-theme `--composer-background`
          custom property (globals.css), not a literal colour -- each built-in theme sets its own
          value, required to render strictly darker than that theme's own `--background` so the
          composer reads as the page's most recessive field (docs/DESIGN.md "Composer tone"); the
          one exception is the high-contrast preset, whose `--background` is literal pure black
          with no lightness value below it -- see that token's own comment in globals.css for how
          it resolves the edge case instead. A solid colour (rather than an alpha composite over
          `--card`/`--muted`) remains deliberate: the original `bg-black/20` attempt actually read
          LIGHTER once composited (Chromium's `color-mix(in oklab, black 20%, transparent)`
          resolves missing "transparent" channels to the *other* operand's lightness at zero
          weight, not literally black, so alpha-blend math does not hold here -- confirmed
          empirically via a scratch-instance pixel sample, not by reasoning about the spec), and
          `bg-muted/60` was an alpha composite of `--muted`, which sits *lighter* than
          `--background` in the original dark theme, so it read as a no-op lightening instead of
          the intended recessive fill. Plus a `border-muted-foreground/85` border re-measured at
          >=3:1 against both the page background and this fill (WCAG 1.4.11), Send/Stop moved
          inside as round icon-only buttons, and the provider/model/effort readout along the
          bottom. `focus-within` replaces the Textarea's own (now removed) focus ring so the whole
          field, not just the text area, shows the focus state. */}
      <div className="flex flex-col gap-1 rounded-lg border border-muted-foreground/85 bg-composer-background pt-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
        <div className="relative flex items-end">
          {showSlashMenu && (
            <SlashMenu
              id={slashMenuId}
              commands={slashMatches}
              activeIndex={clampedSlashActiveIndex}
              onSelect={completeSlashCommand}
              onActiveIndexChange={setSlashActiveIndex}
            />
          )}
          <Textarea
            ref={textareaRef}
            role="combobox"
            aria-label="Message"
            aria-autocomplete="list"
            aria-expanded={showSlashMenu && slashMatches.length > 0}
            aria-controls={showSlashMenu && slashMatches.length > 0 ? slashMenuId : undefined}
            aria-activedescendant={
              showSlashMenu && slashMatches.length > 0 ? slashOptionId(slashMenuId, clampedSlashActiveIndex) : undefined
            }
            aria-describedby={describedByIds}
            value={text}
            onChange={(event) => {
              const value = event.target.value
              const cursor = event.target.selectionStart ?? value.length
              useDraftStore.getState().setText(sessionId, value)
              setSlashDismissed(false)
              scheduleGhostCheck(value, cursor)
              // FR-014, Edge Cases: every edit re-checks every pending chip's label against the
              // new value -- an explicit delete and an edit that merely breaks the label both
              // drop it from pending state the same way. Accessibility remediation (High):
              // whatever got dropped is announced via the live region below, since this was
              // previously completely silent to a screen-reader user.
              const prunedChips = pruneDanglingChips(value, attachments.textChips)
              if (prunedChips.length !== attachments.textChips.length) {
                announceChipRemoval(attachments.textChips.filter((chip) => !prunedChips.includes(chip)))
                useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, textChips: prunedChips }))
              }
            }}
            onPaste={(event) => void handlePaste(event)}
            onScroll={(event) => {
              // The overlay doesn't track the textarea's scroll on its own (#359 remediation):
              // without this a suggestion on a tall, scrolled draft renders on the wrong line.
              const scrollTop = (event.target as HTMLTextAreaElement).scrollTop
              if (overlayRef.current) overlayRef.current.scrollTop = scrollTop
              if (chipOverlayRef.current) chipOverlayRef.current.scrollTop = scrollTop
            }}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder={placeholder}
            className="max-h-48 min-h-16 resize-none overflow-y-auto border-none bg-transparent pr-20 shadow-none focus-visible:border-none focus-visible:ring-0 dark:bg-transparent"
          />
          {/* Issue #533: empty-state hint overlay. A native `placeholder` attribute cannot carry
              icons, so this inert sibling (same technique as the ghost-text overlay below) shows
              "Message the agent" plus two short hints (slash commands, Markdown), each with a
              leading icon, spaced apart rather than bracketed (docs/design/product-look-and-
              feel.md:27 "No bracket/parenthetical UI copy"). Hidden as soon as there is any text,
              so it never draws over the draft or the ghost-text suggestion, and whenever disabled
              (the native `placeholder` carries the stop-reason text for that state instead,
              unchanged). The accessible name stays "Message"; `composerHintId` above carries the
              same wording through `aria-describedby` since an overlay is never read as a
              `placeholder`. Gate-fixes (quality gate, PR #644 round 1): `TypeIcon` (lucide), not
              Tabler's `IconMarkdown` -- at the time, Stuart's 2026-10-08 rule (PLAN.md "Icon set
              and style") limited `@tabler/icons-react` to GitHub/GitLab/Bitbucket brand marks
              only, and a Markdown glyph is not a brand mark (resolved, `docs/design/
              foundations-icons.md` "Status, action, tool, and brand icons"); that brand-marks-only
              limit was itself superseded 2026-10-10 (Tabler is now allowed whenever lucide lacks
              the icon), but this choice is unaffected either way since lucide already has
              `TypeIcon`; `@tabler/icons-react` is back out of
              `package.json`. Responsive: the issue's own three-stage design (truncate the hint
              labels, then icons-only with a tooltip, then truncate the main prompt) is narrowed to
              two stages here -- a tooltip cannot attach to a `pointer-events-none` overlay, so
              that middle tier is dropped (flagged on the issue and in the PR as a deviation,
              Stuart's call). `min-w-0 truncate` on the leading text (no `shrink-0`) plus a
              `shrink-[100]` weight on each hint group (CSS flexbox shrinks proportionally to
              basis * shrink-factor, so at 100x the groups absorb nearly all of any shrink deficit
              before the main prompt gives up any width) means a narrow pane truncates the hint
              labels first; only once both groups hit their own `min-w-[1.125rem]` floor (the
              14px icon plus its 4px `gap-1` to the label, the narrowest the group can go without
              the icon itself getting clipped by `overflow-hidden`) does the main prompt start
              truncating too, with an ellipsis instead of the earlier hard clip. Gate-fixes
              (quality gate, PR #644 round 2): `100` was not nearly large enough -- flexbox shares
              a shortfall by `basis * shrink-factor`, so even at 100x the main prompt's own small
              basis (about 113px) still worked out to roughly 0.46% of any shortfall (113 /
              (113 + 100 * 243)), enough to show an ellipsis from a wide pane down (confirmed in
              headless Chromium against this exact CSS). `100000` instead keeps the main prompt's
              share under one sub-pixel layout step (1/64px) until the groups are fully at their
              floor, so it stays visually whole the entire time the labels are still truncating.
              Each label span also needs its own `min-w-0` (a flex item defaults to `min-width:
              auto`, i.e. its own content size, which would otherwise block `truncate`'s ellipsis
              from ever firing inside the group's own nested flex row). `forced-colors:text-[GrayText]` matches the
              native placeholder's own forced-colors rendering (radio-group.tsx:54,77 for the same
              pattern elsewhere) so the hint cannot be mistaken for typed text in Windows High
              Contrast, where `text-muted-foreground` would otherwise resolve to the same
              `CanvasText` as the real draft. */}
          {!disabled && text === '' && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 flex items-start gap-1.5 overflow-hidden px-2.5 py-2 pr-20 text-base text-muted-foreground forced-colors:text-[GrayText] md:text-sm"
            >
              <span className="min-w-0 truncate">Message the agent</span>
              <span className="flex min-w-[1.125rem] shrink-[100000] items-center gap-1 overflow-hidden">
                <SlashIcon aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">for commands</span>
              </span>
              <span className="flex min-w-[1.125rem] shrink-[100000] items-center gap-1 overflow-hidden">
                <TypeIcon aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">Markdown supported</span>
              </span>
            </div>
          )}
          {/* Ghost-text overlay (T103, FR-058): an inert sibling, not part of the textarea's own
              accessible value -- matching its box model exactly (same padding/font classes) so
              the invisible leading span reserves the same space the real draft occupies, landing
              the dimmed suffix immediately after the cursor. Gated on `ghost.text === text` as an
              extra invariant on top of the generation bump: a suggestion computed against a draft
              that's since changed outside the normal onChange path must never render (#358
              remediation). */}
          {ghost && ghost.text === text && (
            <div
              ref={overlayRef}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-2.5 py-2 pr-20 text-base md:text-sm"
            >
              <span className="invisible">{text.slice(0, ghost.cursor)}</span>
              <span className="text-muted-foreground/60">{ghost.suffix}</span>
            </div>
          )}
          {/* Text-chip overlay (spec 009, FR-012, research.md Decision 10): reuses the ghost-text
              overlay technique above -- same inert sibling, same box-model-matching classes -- so
              each pending chip's clickable, chip-styled label lands exactly over its own rendered
              position in the draft. Independent of `ghost`: both overlays can render at once. */}
          {attachments.textChips.length > 0 && (
            <div
              ref={chipOverlayRef}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-2.5 py-2 pr-20 text-base md:text-sm"
            >
              <ChipOverlaySegments
                text={text}
                occurrences={findChipOccurrences(text, attachments.textChips)}
                textareaRef={textareaRef}
              />
            </div>
          )}
          {/* Screen reader users never heard WHAT was suggested, only a generic hint -- Tab would
              send unseen text to the agent (#359 remediation). `announcedSuggestion` is separate
              state from `ghost` so the hint doesn't flicker through '' and back on every debounce
              cycle (`scheduleGhostCheck` clears `ghost` immediately on each edit, but leaves the
              last-announced text alone until eligibility fails outright or a new suggestion
              actually resolves, so the identical text is not re-announced on every keystroke). */}
          <div id={ghostHintId} role="status" aria-live="polite" className="sr-only">
            {announcedSuggestion ? `Suggestion: "${announcedSuggestion}". Tab to accept, Escape to dismiss.` : ''}
          </div>
          {/* Vertically centered on the field's right edge via `top-1/2 -translate-y-1/2`
              rather than `bottom-1.5`, so the button stays centered as the textarea grows to
              multiple lines instead of drifting toward the bottom (morning UI feedback,
              2026-10-04). Send and Stop share the exact same `variant="outline"` + `size="icon-sm"`
              treatment -- only the icon inside differs -- so neither reads as a different size or
              weight than the other. */}
          <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
            {isWorking && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    className="rounded-full"
                    aria-label="Stop"
                    aria-keyshortcuts="Control+Shift+X"
                    onClick={() => void handleStop()}
                  >
                    <SquareIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <KbdGroup>
                    <Kbd>Ctrl</Kbd>
                    <Kbd>Shift</Kbd>
                    <Kbd>X</Kbd>
                  </KbdGroup>
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  className="rounded-full aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                  aria-label="Send message"
                  aria-keyshortcuts="Enter"
                  aria-disabled={disabled || starting || !text.trim()}
                  onClick={() => {
                    if (disabled || starting || !text.trim()) return
                    void handleSend()
                  }}
                >
                  <ArrowUpIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <Kbd>Enter</Kbd>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        {/* Model-in-use and thinking-level readout (T062/T063): a leading icon for each instead
            of a bracketed "(Effort)" suffix (docs/DESIGN.md "No bracket/parenthetical UI copy").
            */}
        <div className="flex items-center gap-3 truncate px-2.5 pb-1 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1 truncate">
            <CpuIcon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{modelLabel ?? 'Model not known yet'}</span>
          </span>
          {thinkingLabel && (
            <span className="flex min-w-0 shrink-0 items-center gap-1">
              <GaugeIcon className="size-3.5 shrink-0" aria-hidden="true" />
              <span>
                <span className="sr-only">Thinking level: </span>
                {thinkingLabel}
              </span>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
