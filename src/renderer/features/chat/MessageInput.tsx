// The message box (docs/DESIGN.md "Chat", "Keyboard"): grows up to ~8 lines, Enter sends,
// Shift+Enter inserts a newline, Esc clears, Ctrl+Shift+X stops a running turn. Queue chips come
// only from `useQueueStore` (queue:update events), never from optimistic local state. The
// slash-command menu (T044, FR-032, FR-033) lives in SlashMenu.tsx; this file only decides when
// to show it and handles the keys that drive it.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClipboardEvent as ReactClipboardEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ArrowUpIcon, CpuIcon, GaugeIcon, SquareIcon, XIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { formatModelLabel, formatThinkingLevelLabel } from '@/lib/modelDisplay'
import { EMPTY_QUEUE, notify, useChatScrollStore, useCommandsStore, useDraftStore, useQueueStore, useSessionsStore, useSettingsStore, useSplitStore } from '@/state'
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

interface QueuedChip {
  key: string
  text: string
  // Issue #540: carried through from `queue_update` so Send now/Remove act on the chip's real
  // queue instead of a hard-coded one -- a steering chip was previously matched against
  // `followUp` only, so it could never be removed and the issue's reported "several clicks"
  // symptom was, for a steering chip, actually "never works at all".
  queue: 'followUp' | 'steering'
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
  // Issue #540: `optimisticPromotions` holds follow-up text just sent via "Send now", shown as a
  // steering chip immediately rather than waiting for OMP's own `queue_update`; `inFlightChips`
  // single-flights Send now/Remove per chip text (disabled with "Sending..." while a request is
  // out), since neither action had a busy state before, so a user who saw no immediate change
  // after the first click often clicked again before the first request even returned.
  const [optimisticPromotions, setOptimisticPromotions] = useState<string[]>([])
  const [inFlightChips, setInFlightChips] = useState<ReadonlySet<string>>(new Set())
  // Garbage-collects an optimistic promotion once the real queue confirms it one way or another
  // (landed in `steering`, or left the queue by any other route) -- `visibleOptimisticPromotions`
  // above already hides a duplicate the instant `steering` catches up, so this only prevents the
  // set from growing unbounded over a long session.
  useEffect(() => {
    setOptimisticPromotions((prev) => {
      if (prev.length === 0) return prev
      const next = prev.filter((chipText) => followUp.includes(chipText))
      return next.length === prev.length ? prev : next
    })
  }, [followUp])
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
  const [attachmentAnnouncement, setAttachmentAnnouncement] = useState<string | null>(null)
  // A repeated identical announcement (e.g. pasting the same image twice) would otherwise never
  // re-render the live region, since React bails out on an unchanged string -- clear first so the
  // next microtask's set is always a real DOM mutation, even when the text itself repeats.
  const announceAttachment = useCallback((message: string) => {
    setAttachmentAnnouncement(null)
    queueMicrotask(() => setAttachmentAnnouncement(message))
  }, [])
  const attachmentsStatusId = `${sessionId}-attachments-status`
  const attachmentsSummaryId = `${sessionId}-attachments-summary`

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

  // Issue #540: shows a chip as already-steering the instant Send now is clicked (optimistic),
  // corrected by the next real `queue_update` -- the first click previously looked like nothing
  // happened (no visual change until OMP's own event arrived), so a user clicked again, which hit
  // the separate "steering chips can never succeed" bug below.
  const visibleOptimisticPromotions = optimisticPromotions.filter((chipText) => !steering.includes(chipText))
  const chips: QueuedChip[] = [
    ...followUp
      .filter((chipText) => !optimisticPromotions.includes(chipText))
      .map((chipText, index) => ({ key: `followUp-${index}-${chipText}`, text: chipText, queue: 'followUp' as const })),
    ...steering.map((chipText, index) => ({ key: `steering-${index}-${chipText}`, text: chipText, queue: 'steering' as const })),
    ...visibleOptimisticPromotions.map((chipText, index) => ({
      key: `optimistic-${index}-${chipText}`,
      text: chipText,
      queue: 'steering' as const
    }))
  ]

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
        snapshot = await useSessionsStore.getState().open(sessionId)
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

  // Issue #540: single-flight per chip text -- the button already disables while `inFlightChips`
  // has this text (see the chip render below), but this guard also stops a second call that
  // somehow still lands (e.g. a fast double Enter on a focused button) from firing a duplicate
  // request.
  async function handleRemoveQueued(queuedText: string, queue: 'followUp' | 'steering') {
    if (inFlightChips.has(queuedText)) return
    setInFlightChips((prev) => new Set(prev).add(queuedText))
    const result = await window.refract.chat.removeQueued(sessionId, queuedText, queue)
    setInFlightChips((prev) => {
      const next = new Set(prev)
      next.delete(queuedText)
      return next
    })
    if (!result.ok) notify(result.error)
  }

  async function handleSendNow(queuedText: string) {
    if (inFlightChips.has(queuedText)) return
    setInFlightChips((prev) => new Set(prev).add(queuedText))
    // Issue #540: shows the chip as already-steering the instant the request goes out (see
    // `visibleOptimisticPromotions` above), corrected the moment the real `queue_update` lands.
    setOptimisticPromotions((prev) => (prev.includes(queuedText) ? prev : [...prev, queuedText]))
    // `chat.sendNow` takes no `images` argument: OMP's `promote_queued_message` moves the queued
    // message (attachments included) rather than reprocessing it, so this call site must never
    // touch, forward, or clear the composer's own current pending images.
    const result = await window.refract.chat.sendNow(sessionId, queuedText)
    setInFlightChips((prev) => {
      const next = new Set(prev)
      next.delete(queuedText)
      return next
    })
    if (!result.ok) {
      setOptimisticPromotions((prev) => prev.filter((chipText) => chipText !== queuedText))
      notify(result.error)
      return
    }
    if (!result.value.promoted) {
      // Issue #540: `promoted: false` means it was no longer pending at dispatch time (e.g.
      // already delivered) -- not an RPC-level error, so `notify` is not the right surface, but
      // silence is exactly the bug this story fixes.
      setOptimisticPromotions((prev) => prev.filter((chipText) => chipText !== queuedText))
      announceAttachment('Message could not be sent: it is no longer queued.')
      return
    }
    announceAttachment('Message moved to send at the next step.')
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
    // Slash commands are discoverable by typing '/' itself (SlashMenu.tsx opens on it), so no
    // parenthetical hint is needed here (docs/DESIGN.md "No bracket/parenthetical UI copy").
    : 'Message the agent…'
  // Accessibility remediation (High): a short, persistent sr-only summary of how many
  // attachments are pending right now, pointed to by the textarea's own `aria-describedby` --
  // the only programmatic link from the textarea to its pending chips/images before this.
  const pendingAttachmentsCount = attachments.images.length + attachments.textChips.length
  const describedByIds = [disabled ? stopReasonId : null, ghostHintId, attachmentsSummaryId].filter(Boolean).join(' ')

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3">
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((chip) => {
            const busy = inFlightChips.has(chip.text)
            return (
              <Badge key={chip.key} variant="secondary" className="max-w-full gap-1.5 py-1 pr-1">
                <span className="max-w-64 truncate" title={chip.text}>
                  {chip.text}
                </span>
                {/* Issue #540: Send now is offered only for follow-up chips -- OMP's
                 * `promote_queued_message` only ever matches a queued follow-up, so a steering
                 * chip's "Send now" could never succeed. A steering chip instead shows a quiet
                 * status: it is already on its way to the agent's next step. */}
                {chip.queue === 'followUp' ? (
                  <button
                    type="button"
                    aria-label={busy ? `Sending now: ${chip.text}` : `Send now: ${chip.text}`}
                    aria-busy={busy}
                    disabled={busy}
                    className="rounded-full px-1 text-[0.7rem] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50"
                    onClick={() => void handleSendNow(chip.text)}
                  >
                    {busy ? 'Sending…' : 'Send now'}
                  </button>
                ) : (
                  <span className="px-1 text-[0.7rem] text-muted-foreground">Sending at the next step</span>
                )}
                <button
                  type="button"
                  aria-label={busy ? `Removing queued message: ${chip.text}` : `Remove queued message: ${chip.text}`}
                  aria-busy={busy}
                  disabled={busy}
                  className="rounded-full p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50"
                  onClick={() => void handleRemoveQueued(chip.text, chip.queue)}
                >
                  <XIcon className="size-3" />
                </button>
              </Badge>
            )
          })}
        </div>
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
        {attachmentAnnouncement ?? ''}
      </div>
      <span id={attachmentsSummaryId} className="sr-only">
        {pendingAttachmentsCount > 0
          ? `${pendingAttachmentsCount} pending attachment${pendingAttachmentsCount === 1 ? '' : 's'}`
          : ''}
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
