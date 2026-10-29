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
import { SlashIcon, TypeIcon } from 'lucide-react'
import { toast } from 'sonner'
import {
  COMPOSER_TEXT_CLASS,
  ComposerActions,
  ComposerBox,
  ComposerField,
  ComposerFooter,
  ComposerSendButton,
  ComposerStopButton,
  ComposerTextarea
} from '@/components/ComposerBox'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import { dismissSlashCommandRefusalToast, EMPTY_QUEUE, notify, SIDE_CHAT_LOADING_HINT, useChatScrollStore, useCommandsStore, useDraftStore, useQueueStore, useRightPaneStore, useSessionsStore, useSettingsStore, useSideChatStore, useSplitStore, useViewStore } from '@/state'
import type { SessionStatusEvent, SlashCommand } from '../../../shared/ipc'
import { describeStopReason } from './ChatPane'
import { SlashMenu, slashOptionId, slashRowKey } from './SlashMenu'
import { useSlashMenuCompletion } from './useSlashMenuCompletion'
import { ApprovalModePill } from './ApprovalModePill'
import { ComposerStatusLine } from './ComposerStatusLine'
import { AttachButton, ReasoningPicker } from './ComposerPickers'
import { ModelPicker } from './ModelPicker'
import { openRoleSwitcher } from './useRoleCycleShortcut'
import { AttachmentStrip, ChipOverlaySegments } from './AttachmentStrip'
import { CommandPillOverlay, COMMAND_PILL_TEXTAREA_CLASS, COMPOSER_MIRROR_CLASS, useCommandPillOverlay } from './CommandPillOverlay'
import { attachPastedImage, attachPastedFiles } from './attachImage'
import {
  buildChipLabel,
  buildImagePathAttachment,
  describeAttachFailureReason,
  EMPTY_ATTACHMENTS,
  extractImagePathCandidates,
  findChipOccurrences,
  findClipboardImageItem,
  formatByteSize,
  isImagePathOnlyText,
  isLargePaste,
  pruneDanglingChips,
  substituteChips,
  toImageContent
} from './attachments'
import { useComposerClearanceCallbackRef } from './composerHeightVar'
import { appendFileAttachmentText, FILE_ATTACHMENTS_MARKER } from './anyFileAttachments'
import { hasSendableContent, imageDisplayNames, isImageOnlyDraft, isImageOnlyQueued, queuedChipRpcText, SECOND_IMAGE_ONLY_REFUSAL } from './imageOnlySend'
import { QueuedChipList } from './QueuedChipList'
import { ComposerBranchLabel } from './ComposerBranchLabel'
import { remainingAttachmentSlots } from './attachDroppedPaths'
import { removeAttachment } from './removeAttachment'
import { stopAndRestore } from './restoreQueue'
import { isFocusStranded } from '@/lib/focus'
import type { ImagePathAttachFailureReason, ImagePathCandidate, PendingTextChip } from './attachments'
import { deriveQueuedChips, EMPTY_CHIP_POOL, type ChipPoolState, type DerivedChip } from './queuedChips'
import { computeEnterSendsQueuedFollowUp } from './enterSendsQueuedFollowUp'
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
  // #514: a Settings switch to turn path-based image-attach detection off entirely (a pasted
  // clipboard image itself is never affected by this).
  const detectImagePathsOnPaste = useSettingsStore((s) => s.settings.detectImagePathsOnPaste)
  // Issue #772 (Settings::word_prediction_enabled, Rust build only): absent means enabled (Electron).
  const wordPredictionEnabled = useSettingsStore((s) => s.settings.wordPredictionEnabled !== false)
  // PR #723 gate round 1 fix (Code1 Medium): reactive read so the Send button's own
  // `aria-disabled` reflects an in-flight path/drop read, same guard as `handleSend` (draft-store.ts).
  const pendingAttachmentReads = useDraftStore((s) => s.bySession[sessionId]?.pendingAttachmentReads ?? 0)
  const { followUp, steering } = useQueueStore((s) => s.bySession[sessionId] ?? EMPTY_QUEUE)
  const imageOnlyNames = useQueueStore((s) => s.imageOnlyBySession[sessionId])
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
  // #514/#432: now held in `useDraftStore` (per session), not local state -- ChatPane.tsx's own
  // drag-and-drop handler (#432) needs to announce through this EXACT same live region, and it
  // lives outside this component. The sequence-number re-render trick (a repeated identical
  // message, e.g. pasting the same image twice, must still force a fresh DOM node) now lives in
  // the store's own `announceAttachment` action instead of a local ref.
  const attachmentAnnouncement = useDraftStore((s) => s.bySession[sessionId]?.attachmentAnnouncement ?? null)
  const announceAttachment = useCallback(
    (message: string) => {
      useDraftStore.getState().announceAttachment(sessionId, message)
    },
    [sessionId]
  )
  // PR #723 gate round 2 fix (Code2/A11y2 Medium): announces "Attaching…" once per
  // 0-to-positive transition of `pendingAttachmentReads` (never on every re-render while it
  // stays above 0, and never again on the already-covered 0-to-0/no-op case) -- the paired
  // visible text line above this component's own JSX is the courtesy UI; this is the
  // announcement a screen-reader user needs for the exact same state.
  const prevPendingAttachmentReadsRef = useRef(pendingAttachmentReads)
  useEffect(() => {
    if (pendingAttachmentReads > 0 && prevPendingAttachmentReadsRef.current === 0) {
      announceAttachment('Attaching…')
    }
    prevPendingAttachmentReadsRef.current = pendingAttachmentReads
  }, [pendingAttachmentReads, announceAttachment])
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
  // #897: Chromium fires no blur when a focused element unmounts, so this still reads true after
  // Stop disappears at the end of a turn.
  const stopHadFocusRef = useRef(false)
  // PR #723 gate round 3 fix (A11y3 HIGH): scopes `handleRemoveImage`'s own focus query to THIS
  // composer's own attachment strip -- in split view each pane renders its own MessageInput, so
  // a `document`-wide query always found whichever pane's strip happened to render first.
  const attachmentStripRef = useRef<HTMLDivElement>(null)
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
  const { commandToken, commandPillOverlayRef } = useCommandPillOverlay(text, commands, textareaRef) // FR-092, #1050
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
  // Layout effect: no frame without a focus ring. A disabled composer (stop banner) cannot take
  // focus; that case is tracked in #1285.
  useLayoutEffect(() => {
    if (isWorking || !stopHadFocusRef.current) return
    stopHadFocusRef.current = false
    if (isFocusStranded(document.activeElement, null)) textareaRef.current?.focus()
  }, [isWorking])
  // Issue #1205 (FR-104): any stop without a stop banner (not started, or stopped on request)
  // keeps the composer usable; a send starts the agent.
  const notStarted = status === 'stopped' && (stopReason === 'not-started' || stopReason === undefined)
  const disabled = status === 'stopped' && !notStarted

  const { slashMatches, showSlashMenu, slashMenuKey, slashMenuViewProps, slashAnnouncement, handleSlashMenuSelect, handleSlashMenuKey } = useSlashMenuCompletion({
    sessionId,
    text,
    commands,
    slashDismissed,
    setSlashDismissed,
    clearGhostState,
    textChips: attachments.textChips,
    announceChipRemoval
  })
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
  // Issue #1067: steer the oldest queued follow-up on a plain Enter against a blank composer.
  const enterQueuedFollowUp = computeEnterSendsQueuedFollowUp(text, attachments, pendingAttachmentReads, chips, showSlashMenu, ghost, disabled)

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
  // never survives into a shorter, filtered one. Gate round 1 fix (Low): `useLayoutEffect`, not
  // `useEffect` -- the plain-`useEffect` version could still commit one paint with the OLD
  // active index against the NEW (shorter) list before this ran, visibly highlighting the wrong
  // row for a frame.
  useLayoutEffect(() => {
    setSlashActiveIndex(0)
  }, [slashMenuKey])
  // Ctrl+Shift+X stops the running turn while this pane is mounted AND focused (docs/DESIGN.md
  // "Keyboard"; spec 005 FR-010: acts only on the focused/owning pane while a split is open).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== 'x') return
      event.preventDefault()
      if (!isFocusedPaneRef.current) return
      if (statusRef.current !== 'working') return
      void stopAndRestore(sessionIdRef.current, () => textareaRef.current?.focus())
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /** `overrideText` (issue #938 item 1): a just-completed "Run /<cmd>" or exact-subcommand
   * selection must send THAT text at once -- `text` is this render's stale closure value until
   * the store write it just made applies on a later render. */
  async function handleSend(overrideText?: string) {
    // PR #723 gate round 1 fix (Code1 Medium): refuses while a background path/drop image read
    // for this session is still in flight (`pendingAttachmentReads`, draft-store.ts's own doc
    // comment) -- otherwise Enter mid-read sent the message WITHOUT the image (which then landed
    // on the NEXT draft instead), the same race class `disabled`/`starting` already guard against.
    if (disabled || starting || pendingAttachmentReads > 0) return
    const draftText = overrideText ?? text
    if (!hasSendableContent(draftText, attachments)) return
    // #744 (spec 009 FR-042): OMP's queue cannot tell two image-only follow-ups apart.
    const imageOnly = isImageOnlyDraft(draftText, attachments)
    if (imageOnly && isImageOnlyQueued(followUp, steering)) return void toast.error(SECOND_IMAGE_ONLY_REFUSAL)
    // Enter-send and the Send button both clear the draft via `clear(sessionId)` below, bypassing
    // `scheduleGhostCheck`'s onChange-driven invalidation; without this a shown suggestion would
    // outlive the send with no `accepted: false` feedback (#358/#359 remediation).
    clearGhostState()
    // Issue #762: bare `/models` opens Settings > Model roles; bare `/role` (#766) opens the switcher.
    const modelsInvocation = parseSlashCommand(draftText)
    const bareCommand = attachments.images.length === 0 && attachments.files.length === 0 && modelsInvocation?.rest === ''
    if (bareCommand && (modelsInvocation?.name === 'models' || modelsInvocation?.name === 'role')) {
      useDraftStore.getState().clear(sessionId)
      if (modelsInvocation.name === 'models') useViewStore.getState().openSettings('models')
      else openRoleSwitcher(sessionId)
      return
    }
    if (notStarted) {
      // Spec 005 (research.md Decision 4): sending the first message to a just-restored,
      // not-yet-opened pane is itself the "real action" that clears its pristine flag. Cleared
      // FIRST, before awaiting open() below: this lets ChatPane's own pristine-cleared effect
      // (triggered by this exact state change) be the SOLE place that calls `applySnapshot` for
      // this open.
      //
      // Quality-gate remediation (code-reviewer, Medium): this branch no longer calls
      // `applySnapshot` itself (a second apply raced `transcript:patch` and could flash the
      // pre-send transcript); it only awaits `open()` to know the agent has started.
      useSplitStore.getState().markOpened(sessionId)
      let snapshot
      try {
        setStarting(true)
        // Issue #1205 (FR-104): a typed send is an explicit start -- `open(sessionId, true)`
        // starts the stopped agent and resolves once it is ready, then this one send goes out.
        snapshot = await useSessionsStore.getState().open(sessionId, true)
      } finally {
        setStarting(false)
      }
      // A failed start keeps the draft (it is only cleared after `chat.send` succeeds) and the
      // stop banner shows from the live status event.
      if (!snapshot || snapshot.runtime.status === 'stopped') return
    }
    // FR-013: every pending text chip's full original text is substituted back into the draft at
    // its own position before anything reaches `chat.send` -- the plain `message` string OMP ever
    // sees is exactly what the developer would have gotten pasting the whole block directly.
    const message = substituteChips(imageOnly ? '' : draftText, attachments.textChips)
    // #926 (D1 HIGH): typed text carrying the literal marker is refused, draft stays intact.
    if (message.includes(FILE_ATTACHMENTS_MARKER)) {
      toast.error(`The message contains the reserved "${FILE_ATTACHMENTS_MARKER}" marker line used internally for file attachments. Remove it and try again.`)
      return
    }
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
      // Gate-fix (round 2, Code2/Sec2 Medium): `btw` carries no `images` field (contracts/ipc.md);
      // refuse rather than silently drop a pasted screenshot.
      if (attachments.images.length > 0 || attachments.files.length > 0) {
        toast.error("Side questions don't support attachments. Remove them and try again.")
        return
      }
      // Gate-fix (round 2, Code2/Sec2 HIGH): refuses (keeping the draft) while a `btw` is still
      // running -- spec Assumption 7's single-flight rule, as on the panel's own Send button.
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
    // #926 (D4 HIGH): a slash command with a pending file would append the marker text, which OMP rejects as unsupported-arguments.
    if (slashInvocation && attachments.files.length > 0) {
      toast.error("Slash commands can't carry attached files. Remove them and try again.")
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
    // #926: appended to the OUTGOING text only, never into `message` above, so `parseSlashCommand` keeps reading the developer's own typed text.
    const outgoingMessage = appendFileAttachmentText(message, attachments.files)
    try {
      result = await window.refract.chat.send(sessionId, outgoingMessage, images)
    } finally {
      if (isNewConversationCommand) {
        useChatScrollStore.getState().setInFlight(sessionId, false)
      }
    }
    if (!result.ok) {
      if (isNewConversationCommand) {
        useChatScrollStore.getState().restoreIfAbsent(sessionId, previousScroll)
      }
      notify(result.error, sessionId)
      return
    }
    dismissSlashCommandRefusalToast(sessionId)
    if (imageOnly) useQueueStore.getState().setImageOnly(sessionId, result.value.queued ? imageDisplayNames(attachments.images) : null)
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

  /** Fully resets ghost-prediction state outside the normal onChange path (Enter-send, Esc-clear,
   * and slash-command completion all call `setText` directly, bypassing `scheduleGhostCheck`) --
   * bumps `ghostGenerationRef`, cancels any pending request, dismisses what's shown (#358/#359). */
  function clearGhostState() {
    ghostGenerationRef.current++
    if (ghostDebounceRef.current) {
      clearTimeout(ghostDebounceRef.current)
      ghostDebounceRef.current = null
    }
    dismissGhost(false)
    setAnnouncedSuggestion(null)
  }

  useEffect(() => { // Issue #772: clears a stale/in-flight suggestion the instant prediction is disabled.
    if (wordPredictionEnabled === false) clearGhostState()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wordPredictionEnabled])

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
    if (!wordPredictionEnabled || !isGhostTextEligible(nextText, nextCursor)) {
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
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.nativeEvent.isComposing) {
        const outcome = handleSlashMenuKey(event.key, event.shiftKey, slashActiveIndex)
        if (outcome !== 'unhandled') {
          event.preventDefault()
          if (outcome) void handleSend(outcome.sendText)
          return
        }
        // 'unhandled' (an empty list, or Shift+Tab, gate round 1 Low): falls through so Tab's
        // own ghost-suggestion/focus-movement handling further below still runs for this key.
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
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void (enterQueuedFollowUp.applies ? handleSendNow(enterQueuedFollowUp.chip) : handleSend())
      return
    }
    if (event.key === 'Escape') {
      // Gate round 1 fix 3 (#700/#701 slice b): belt to `useReadoutCard.ts`'s own capture-phase Escape handler, which already calls `preventDefault`/`stopPropagation` on this exact keypress when a hover-focus card is open -- without this, a `defaultPrevented` Escape that somehow still reached this far would wipe the whole draft instead of only closing the card.
      if (event.defaultPrevented) return
      event.preventDefault()
      clearGhostState()
      useDraftStore.getState().setText(sessionId, '')
      // Medium remediation (test-reviewer): same bypass as `completeSlashCommand` above -- plain Esc-clear calls `setText` directly too, skipping onChange's own `pruneDanglingChips`.
      // Every chip's label is gone from the (now-empty) draft, so this simply drops them all, with the same silent-removal announcement any other drop gets.
      const prunedChips = pruneDanglingChips('', attachments.textChips)
      if (prunedChips.length !== attachments.textChips.length) {
        announceChipRemoval(attachments.textChips.filter((chip) => !prunedChips.includes(chip)))
        useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, textChips: prunedChips }))
      }
    }
  }

  async function handleStop() {
    await stopAndRestore(sessionId, () => textareaRef.current?.focus())
  }

  // Issue #540 (#591 cycle 3): single-flight per chip (keyed by the chip's own stable identity,
  // not its text, so two chips sharing the same text never share a busy state) -- the button
  // already disables while `inFlightChips` has this key (see the chip render below), but this
  // guard also stops a second call that somehow still lands (e.g. a fast double Enter on a
  // focused button) from firing a duplicate request.
  async function handleRemoveQueued(chip: DerivedChip) {
    if (inFlightChips.has(chip.key)) return
    setInFlightChips((prev) => new Map(prev).set(chip.key, 'remove'))
    const result = await window.refract.chat.removeQueued(sessionId, queuedChipRpcText(chip), chip.queue)
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
    const result = await window.refract.chat.sendNow(sessionId, queuedChipRpcText(chip))
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
    const pastedFiles = Array.from(data.files ?? [])
    // #926: a plain clipboard-image paste is the single-image case with nothing else in
    // `data.files` (`attachPastedImage`'s own doc comment covers the shared FR-039 cap).
    if (imageFile != null && pastedFiles.length <= 1) {
      event.preventDefault()
      await attachPastedImage(sessionId, imageFile)
      return
    }

    if (pastedFiles.length > 0) {
      event.preventDefault()
      await attachPastedFiles(sessionId, pastedFiles)
      return
    }

    const pastedText = data.getData('text/plain')

    // #514: paste-time image-path detection, shares the main-process reader with #432's
    // drag-and-drop. Runs on EVERY paste with no clipboard image (even a short one, well under
    // the FR-011 chip threshold below) -- a pasted path is typically only a few dozen characters.
    if (detectImagePathsOnPaste) {
      const pathCandidates = extractImagePathCandidates(pastedText)
      if (pathCandidates.length > 0) {
        if (isImagePathOnlyText(pastedText)) {
          // #514 point 3: nothing else in the paste -- the path text is replaced by the
          // attachment(s), the box stays clean. Any candidate that fails to resolve (missing,
          // not an image, too large) falls back to its own raw text instead of vanishing.
          // PR #723 gate round 1 fix (Sec1/Code1/A11y1/Verif1 HIGH, reproduced by all four
          // reviewers): `event.currentTarget`/`selectionStart`/`selectionEnd` MUST be captured
          // synchronously, right here, BEFORE the first `await` below -- React nulls a synthetic
          // event's `currentTarget` the instant this handler's synchronous portion returns, so
          // reading it after an `await` threw a TypeError that silently discarded the pasted
          // text with no notice at all (`onPaste`'s own `void handlePaste(event)` swallowed the
          // rejection). The fallback insert below also no longer reads the stale, paste-time
          // `text` closure -- it reads the LIVE draft text from the store.
          //
          // PR #723 gate round 2 fix (Code2 Medium): `before` (the textarea's own value at THIS
          // exact moment) is captured alongside `start`/`end` -- if the live text at fallback
          // time no longer matches it, the developer typed during the IPC round trip and
          // `start`/`end` are no longer meaningful offsets into `liveText` (splicing at them
          // could delete or duplicate characters the developer just typed, round 2's own
          // reproduction: select text, paste a missing path, type a character before the read
          // resolves). The fallback then inserts at the textarea's CURRENT caret position
          // instead (or at the end of the live text if the ref is gone), never the stale
          // offsets. `pruneDanglingChips` now also runs on the result, matching every other
          // write path (onChange, Esc, slash-command completion).
          event.preventDefault()
          const target = event.currentTarget
          const before = target.value
          const start = target.selectionStart
          const end = target.selectionEnd
          // PR #723 gate round 1 fix (Code1 LOW) / gate round 1 (FR-039 Medium): the cap applies
          // PER MESSAGE, shared with pending files too, not a static slice of this one paste.
          const remainingSlots = remainingAttachmentSlots(sessionId)
          const capped = pathCandidates.slice(0, remainingSlots)
          const overflow = pathCandidates.slice(remainingSlots)
          const loopFailures: { candidate: ImagePathCandidate; reason: ImagePathAttachFailureReason }[] = []
          useDraftStore.getState().incrementPendingAttachmentReads(sessionId)
          let attachedCount = 0
          try {
            for (const candidate of capped) {
              const result = await buildImagePathAttachment(sessionId, candidate.normalized)
              if (result.ok) {
                useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, images: [...prev.images, result.attachment] }))
                attachedCount++
              } else {
                loopFailures.push({ candidate, reason: result.reason })
              }
            }
          } finally {
            useDraftStore.getState().decrementPendingAttachmentReads(sessionId)
          }
          if (attachedCount > 0) {
            announceAttachment(attachedCount === 1 ? 'Image attached from a file path.' : `${attachedCount} images attached from file paths.`)
          }
          // PR #723 gate round 3 fix (Code3 Low): re-inserts each candidate's own RAW pasted
          // text (FR-022's actual wording), never the normalized form `buildImagePathAttachment`
          // above was given -- a quoted path's quotes, and a `file://…%20…` URL's own encoding,
          // are no longer silently rewritten on fallback. Round 4 fix (Verif4 HIGH): `raw` itself
          // used to be the quote-stripped regex capture for a QUOTED candidate, so this still
          // dropped the quotes on fallback despite the comment above; `attachments.ts`'s
          // `extractImagePathCandidates` now keeps `raw` as the full quoted match.
          const unresolved = [...overflow, ...loopFailures.map((f) => f.candidate)].map((c) => c.raw)
          if (unresolved.length > 0) {
            const liveText = useDraftStore.getState().bySession[sessionId]?.text ?? ''
            const fallbackText = unresolved.join('\n')
            const typedDuringRead = liveText !== before
            const insertAt = typedDuringRead ? (textareaRef.current?.selectionStart ?? liveText.length) : start
            const insertEnd = typedDuringRead ? insertAt : end
            const nextText = liveText.slice(0, insertAt) + fallbackText + liveText.slice(insertEnd)
            const nextCursor = insertAt + fallbackText.length
            useDraftStore.getState().setText(sessionId, nextText)
            const liveChips = useDraftStore.getState().bySession[sessionId]?.attachments.textChips ?? []
            const prunedChips = pruneDanglingChips(nextText, liveChips)
            if (prunedChips.length !== liveChips.length) {
              announceChipRemoval(liveChips.filter((chip) => !prunedChips.includes(chip)))
              useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, textChips: prunedChips }))
            }
            requestAnimationFrame(() => {
              textareaRef.current?.setSelectionRange(nextCursor, nextCursor)
            })
            // PR #723 gate round 3 fix (A11y3 Low): overflow and read-failure sentences are now
            // BOTH reported when a paste has both at once (previously the ternary below only
            // ever reported overflow, silently dropping the failure half), matching the join
            // pattern `ChatPane.tsx`'s own drop-overflow notice already uses.
            const overflowText =
              overflow.length > 0
                ? remainingSlots === 0
                  ? 'This message already has the maximum of 10 images; nothing more was attached.'
                  : `Only ${remainingSlots} more image${remainingSlots === 1 ? '' : 's'} could be attached to this message; the rest were left as text.`
                : null
            const failureText =
              loopFailures.length === 1
                ? `That file ${describeAttachFailureReason(loopFailures[0]!.reason)}; left as text.`
                : loopFailures.length > 1
                  ? `${loopFailures.length} files could not be attached as images; left as text.`
                  : null
            notify({ code: 'invalid-argument', message: [overflowText, failureText].filter(Boolean).join(' ') })
          }
          return
        }
        // Mixed paste (#514 point 3): the path stays exactly where it was pasted below (never
        // prevented) -- each candidate is resolved in the background and attached silently if it
        // turns out to be a real image, with no interruption to typing or the normal paste (FR-039: shares the cap with pending files too).
        const remainingSlots = remainingAttachmentSlots(sessionId)
        const capped = pathCandidates.slice(0, remainingSlots)
        const overflow = pathCandidates.slice(remainingSlots)
        useDraftStore.getState().incrementPendingAttachmentReads(sessionId)
        void (async () => {
          let attachedCount = 0
          let failedCount = 0
          try {
            for (const candidate of capped) {
              const result = await buildImagePathAttachment(sessionId, candidate.normalized)
              if (result.ok) {
                useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, images: [...prev.images, result.attachment] }))
                attachedCount++
              } else {
                failedCount++
              }
            }
          } finally {
            useDraftStore.getState().decrementPendingAttachmentReads(sessionId)
          }
          if (attachedCount > 0) {
            announceAttachment(
              attachedCount === 1 ? 'Image attached from a file path in your message.' : `${attachedCount} images attached from file paths in your message.`
            )
          }
          // PR #723 gate round 2 fix (Code2/A11y2 Medium): a path past the per-message cap, or
          // one that failed to resolve, used to be silently dropped here with no notice at all
          // -- FR-026 says even a mixed paste's own over-cap/unresolved paths get "a quiet
          // notice", the same wording the path-only branch already uses (the path TEXT itself
          // still stays in the draft either way, untouched -- only the ATTACH attempt failed).
          // Round 3 fix (A11y3 Low): both sentences now join, same as the path-only branch above.
          const skipped = overflow.length + failedCount
          if (skipped > 0) {
            const overflowText =
              overflow.length > 0
                ? remainingSlots === 0
                  ? 'This message already has the maximum of 10 images; nothing more was attached; the paths were left as text.'
                  : `Only ${remainingSlots} more image${remainingSlots === 1 ? '' : 's'} could be attached to this message; the rest were left as text.`
                : null
            const failureText =
              failedCount === 1
                ? 'One of the paths in your message could not be attached as an image.'
                : failedCount > 1
                  ? `${failedCount} of the paths in your message could not be attached as images.`
                  : null
            notify({ code: 'invalid-argument', message: [overflowText, failureText].filter(Boolean).join(' ') })
          }
        })()
      }
    }

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

  // PR #723 gate round 2 fix (A11y2 Medium) / #926: Remove restores focus and announces -- the
  // shared `removeAttachment` core owns both the image and file/folder case (`removeAttachment.ts`).
  const handleRemoveImage = (id: string) => removeAttachment(sessionId, 'image', id, attachmentStripRef, textareaRef, announceAttachment)
  const handleRemoveFile = (id: string) => removeAttachment(sessionId, 'file', id, attachmentStripRef, textareaRef, announceAttachment)

  const placeholder = disabled
    ? describeStopReason(stopReason, stopDetail)
    // Issue #533: the empty-state hint overlay below now carries this copy (with icons), so the
    // native `placeholder` is left empty here to avoid drawing both on top of each other -- the
    // disabled branch above is unchanged, it has no overlay.
    : ''
  // Accessibility remediation (High): a persistent sr-only pending-attachments summary, linked via `aria-describedby`.
  const pendingAttachmentsCount = attachments.images.length + attachments.textChips.length + attachments.files.length
  const describedByIds = [disabled ? stopReasonId : null, ghostHintId, attachmentsSummaryId, composerHintId].filter(Boolean).join(' ')
  const composerClearanceRef = useComposerClearanceCallbackRef() // #980 gate round 2: hoisted out of JSX for clarity

  return (
    <div ref={composerClearanceRef} className="flex shrink-0 flex-col gap-2 border-t border-divider px-4 py-4">
      {chips.length > 0 && (
        <QueuedChipList chips={chips} inFlightChips={inFlightChips} imageOnlyNames={imageOnlyNames} listRef={chipListRef} onFocus={handleChipListFocus} onBlur={handleChipListBlur} onSendNow={(chip) => void handleSendNow(chip)} onRemove={(chip) => void handleRemoveQueued(chip)} />
      )}
      {disabled && (
        <span id={stopReasonId} className="sr-only">
          {placeholder}
        </span>
      )}
      <div data-slot="slash-menu-announcement" role="status" aria-live="polite" className="sr-only">
        {slashAnnouncement}
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
        {!disabled && text === '' ? (enterQueuedFollowUp.applies ? 'Enter sends the next queued message. Markdown is supported. Type slash for commands.' : 'Markdown is supported. Type slash for commands.') : ''}
      </span>
      {/* Status line (docs/design/product-chat.md "Status line"; spec 004 FR-023, #564,
          2026-10-15): the old chip row, minus the Approval mode pill -- it now lives in the box's
          own bottom row below (spec 001 FR-065) instead of as this row's guaranteed first item. */}
      <ComposerStatusLine sessionId={sessionId} textareaRef={textareaRef} />
      {/* Spec 009, FR-009: the shared attachment strip, directly above the message box, hidden
          entirely while nothing is pending. */}
      <AttachmentStrip
        images={attachments.images}
        files={attachments.files}
        textChips={attachments.textChips}
        onRemoveImage={handleRemoveImage}
        onRemoveFile={handleRemoveFile}
        containerRef={attachmentStripRef}
      />
      {/* PR #723 gate round 2 fix (Code2/A11y2 Medium): while a background path/drop read is in
          flight, Send/Enter are refused (`pendingAttachmentReads`) with no visible or announced
          reason -- a developer who pressed Enter right after a mixed paste or a drop saw nothing
          happen at all. A real network stall (a OneDrive placeholder hydrating, a disconnected
          mapped drive) can make this last a while, so a visible, text-only line here (never only
          a cursor/disabled-state change) is the actual notice, not just a courtesy. The
          announcement itself (`useEffect` below) fires once per 0-to-positive transition, not on
          every re-render while the count stays above 0. */}
      {pendingAttachmentReads > 0 && <p className="text-xs text-muted-foreground">Attaching…</p>}
      {/* Composer tone (#927): fill, border and focus ring are per-theme tokens (globals.css).
          Composer dimming (Stuart, 2026-10-15, PR #877): while disabled the unusable parts dim
          as one `opacity-60` layer in `ComposerField`; the box edge and the Approval pill (still
          usable while stopped) never dim. */}
      <ComposerBox>
        <ComposerField disabled={disabled}>
          {showSlashMenu && (
            <SlashMenu
              id={slashMenuId}
              commands={slashMatches}
              activeIndex={clampedSlashActiveIndex}
              {...slashMenuViewProps}
              onSelect={(command, isRunBare) => {
                const result = handleSlashMenuSelect(command, { runBare: isRunBare })
                if (result) void handleSend(result.sendText)
              }}
              onActiveIndexChange={setSlashActiveIndex}
            />
          )}
          <CommandPillOverlay text={text} token={commandToken} overlayRef={commandPillOverlayRef} />
          <ComposerTextarea
            role="combobox"
            aria-label="Message"
            aria-autocomplete="list"
            aria-expanded={showSlashMenu && slashMatches.length > 0}
            aria-controls={showSlashMenu && slashMatches.length > 0 ? slashMenuId : undefined}
            aria-activedescendant={
              showSlashMenu && slashMatches.length > 0 ? slashOptionId(slashMenuId, slashRowKey(slashMatches[clampedSlashActiveIndex]!)) : undefined
            }
            aria-describedby={describedByIds}
            spellCheck={!commandToken} // FR-092, #1050: off while the draft starts with a recognised command
            value={text}
            onChange={(event) => {
              const value = event.target.value
              const cursor = event.target.selectionStart ?? value.length
              useDraftStore.getState().setText(sessionId, value)
              setSlashDismissed(false)
              scheduleGhostCheck(value, cursor)
              // FR-014, Edge Cases: every edit re-checks every pending chip's label (an explicit
              // delete, or an edit that merely breaks the label, both drop it); the drop is now
              // announced via the live region below (previously silent to a screen reader).
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
              if (commandPillOverlayRef.current) commandPillOverlayRef.current.scrollTop = scrollTop // FR-092, #1050
            }}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder={placeholder}
            // The disabled placeholder carries the stop reason, so it brightens to
            // `text-foreground` (in `ComposerTextarea`) to stay readable under the 0.6 dim.
            className={commandToken ? COMMAND_PILL_TEXTAREA_CLASS : undefined}
          />
          {/* Issue #533: empty-state hint overlay. A native `placeholder` cannot carry icons, so
              this inert sibling shows "Message the agent" plus two hints (slash commands,
              Markdown) with leading icons, spaced apart, not bracketed (product-look-and-feel.md
              "No bracket/parenthetical UI copy"). Hidden once there is any text and while
              disabled (the native `placeholder` carries the stop reason then). The accessible
              name stays "Message"; `composerHintId` carries the same wording through
              `aria-describedby`. Responsive: `shrink-[100000]` on each hint group makes the
              groups absorb a narrow pane's shortfall first (flexbox shares it by basis * shrink,
              and 100x still left the main prompt about 0.46% of it, enough for an ellipsis); the
              main prompt truncates only once both groups sit at their `min-w-4` floor. Each label
              span needs `min-w-0` so `truncate` can fire inside the group. A tooltip cannot attach
              to a `pointer-events-none` overlay, so there is no icons-only stage (Stuart's call).
              `text-composer-placeholder` is the quiet placeholder token (#1149), and
              `forced-colors:text-[GrayText]` matches the native placeholder so the hint is never
              mistaken for typed text in Windows High Contrast. */}
          {!disabled && text === '' && (
            <div
              aria-hidden="true"
              className={cn(
                'pointer-events-none absolute inset-0 flex items-start gap-2 overflow-hidden px-2 py-2 pr-20 text-composer-placeholder forced-colors:text-[GrayText]',
                COMPOSER_TEXT_CLASS
              )}
            >
              <span className="min-w-0 truncate">{enterQueuedFollowUp.applies ? 'Enter: send next queued' : 'Message the agent'}</span>
              <span className="flex min-w-4 shrink-[100000] items-center gap-1 overflow-hidden">
                <SlashIcon aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 truncate">for commands</span>
              </span>
              <span className="flex min-w-4 shrink-[100000] items-center gap-1 overflow-hidden">
                <TypeIcon aria-hidden="true" className="size-4 shrink-0" />
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
            <div ref={overlayRef} aria-hidden="true" className={cn(COMPOSER_MIRROR_CLASS, 'z-[2]')}>
              <span className="invisible">{text.slice(0, ghost.cursor)}</span>
              <span className="text-muted-foreground/60">{ghost.suffix}</span>
            </div>
          )}
          {/* Text-chip overlay (spec 009, FR-012, research.md Decision 10): reuses the ghost-text
              overlay technique above -- same inert sibling, same box-model-matching classes -- so
              each pending chip's clickable, chip-styled label lands exactly over its own rendered
              position in the draft. Independent of `ghost`: both overlays can render at once. */}
          {attachments.textChips.length > 0 && (
            <div ref={chipOverlayRef} aria-hidden="true" className={cn(COMPOSER_MIRROR_CLASS, 'z-[2]')}>
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
          {/* Send and Stop (2026-10-15 grill, #564 decision 5): Send is the one accent-filled commit
              action (`--send`); Stop is a solid NEUTRAL fill, never red, since stopping keeps the
              work. Both show while a turn runs because Send still queues a follow-up (FR-011),
              a documented exception to "one filled button per surface". */}
          <ComposerActions>
            {isWorking && (
              <ComposerStopButton
                label="Stop"
                keyShortcuts="Control+Shift+X"
                tooltip={
                  <KbdGroup>
                    <Kbd>Ctrl</Kbd>
                    <Kbd>Shift</Kbd>
                    <Kbd>X</Kbd>
                  </KbdGroup>
                }
                onClick={() => void handleStop()}
                onFocus={() => { stopHadFocusRef.current = true }}
                onBlur={() => { stopHadFocusRef.current = false }}
              />
            )}
            {/* The shared dim applies for the refusal reasons other than `disabled`, which
                already dims the whole field block. */}
            <ComposerSendButton
              blocked={disabled || starting || pendingAttachmentReads > 0 || !hasSendableContent(text, attachments)}
              dimWhenBlocked={!disabled}
              keyShortcuts={enterQueuedFollowUp.applies ? undefined : 'Enter'}
              onSend={() => void handleSend()}
              tooltip={
                // aria-disabled while the rule applies (blank text) and Radix wires this into
                // aria-describedby, so it must not describe an action the button cannot perform.
                enterQueuedFollowUp.applies ? 'Send' : <Kbd>Enter</Kbd>
              }
            />
          </ComposerActions>
        </ComposerField>
        {/* Composer bottom row (#564): Approval pill, combined Role.Model pill (#766), Reasoning
            picker, branch label, then Attach. */}
        <ComposerFooter>
          <ApprovalModePill sessionId={sessionId} />
          <ModelPicker sessionId={sessionId} />
          <ReasoningPicker sessionId={sessionId} />
          <ComposerBranchLabel sessionId={sessionId} />
          <AttachButton sessionId={sessionId} disabled={disabled} />
        </ComposerFooter>
      </ComposerBox>
    </div>
  )
}
