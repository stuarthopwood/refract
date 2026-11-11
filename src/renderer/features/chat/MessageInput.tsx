// The message box: Enter sends, Shift+Enter inserts a newline, Esc clears, Ctrl+Shift+X stops a running turn.
// Queue chips come only from `useQueueStore`, never optimistic local state; the slash menu lives in SlashMenu.tsx.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  ClipboardEvent as ReactClipboardEvent,
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
import { ComposerModePills } from './ComposerModePills'
import { ComposerStatusLine } from './ComposerStatusLine'
import { AttachButton, ReasoningPicker } from './ComposerPickers'
import { ModelPicker } from './ModelPicker'
import { openRoleSwitcher } from './useRoleCycleShortcut'
import { AttachmentStrip, ChipOverlaySegments } from './AttachmentStrip'
import { CommandPillOverlay, COMPOSER_MIRROR_CLASS, useCommandPillOverlay } from './CommandPillOverlay'
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
import { hasSendableContent, imageDisplayNames, isImageOnlyDraft, isImageOnlyQueued, SECOND_IMAGE_ONLY_REFUSAL } from './imageOnlySend'
import { ComposerBranchLabel } from './ComposerBranchLabel'
import { remainingAttachmentSlots } from './attachDroppedPaths'
import { removeAttachment } from './removeAttachment'
import { stopAndRestore } from './restoreQueue'
import { useComposerFocusHandoff } from './useComposerFocusHandoff'
import { useComposerIndent } from './useComposerIndent'
import { ComposerIndentHint } from './ComposerIndentHint'
import type { ImagePathAttachFailureReason, ImagePathCandidate, PendingTextChip } from './attachments'
import type { QueuedMessages } from './useQueuedMessages'
import { computeEnterSendsQueuedFollowUp } from './enterSendsQueuedFollowUp'
import { isLocalNativeCommand, parseSlashCommand } from '../../../shared/slash-commands'

type StopReason = SessionStatusEvent['stopReason']

// Stable reference: a fresh `[]` per call breaks useSyncExternalStore snapshot stability and loops.
const EMPTY_COMMANDS: SlashCommand[] = []

// Debounce before a predict_word request; `isGhostTextEligible` mirrors the server's gating (rpc.md "Word prediction") so most keystrokes never reach a request.
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
  /** Focus the textarea once on mount; set by ChatPane when this is a fresh remount replacing one that had focus. */
  autoFocusOnMount?: boolean
  /** The shared queued-message state (useQueuedMessages), owned by ChatPane beside the Queued panel. */
  queued: QueuedMessages
}

export function MessageInput({ sessionId, stopReason, stopDetail, autoFocusOnMount, queued }: MessageInputProps) {
  const status = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status ?? 'stopped')
  // A Session being deleted must not take a send: its worktree is going away and the backend refuses it too.
  const deleting = useSessionsStore((s) => s.deletingIds.has(sessionId))
  // Turns off path-based image-attach detection; a pasted clipboard image is unaffected (#514).
  const detectImagePathsOnPaste = useSettingsStore((s) => s.settings.detectImagePathsOnPaste)
  // Absent means enabled (#772).
  const wordPredictionEnabled = useSettingsStore((s) => s.settings.wordPredictionEnabled)
  // Reactive so Send's `aria-disabled` reflects an in-flight path/drop read, like `handleSend`.
  const pendingAttachmentReads = useDraftStore((s) => s.bySession[sessionId]?.pendingAttachmentReads ?? 0)
  const { followUp, steering } = useQueueStore((s) => s.bySession[sessionId] ?? EMPTY_QUEUE)
  const commands = useCommandsStore((s) => s.bySession[sessionId] ?? EMPTY_COMMANDS)
  // Draft text lives in draft-store.ts so it survives unmounts (Session switch, Settings view-swap).
  const text = useDraftStore((s) => s.bySession[sessionId]?.text ?? '')
  const [starting, setStarting] = useState(false)
  const [slashActiveIndex, setSlashActiveIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const stopReasonId = `${sessionId}-stop-reason`
  const slashMenuId = `${sessionId}-slash-menu`
  // Polite live region for attachment events, separate from the slash-menu one so neither swallows the other.
  // Held in the draft store because ChatPane's drag-and-drop handler (#432) announces through it too.
  const attachmentAnnouncement = useDraftStore((s) => s.bySession[sessionId]?.attachmentAnnouncement ?? null)
  const announceAttachment = useCallback(
    (message: string) => {
      useDraftStore.getState().announceAttachment(sessionId, message)
    },
    [sessionId]
  )
  // Announces "Attaching…" once per 0-to-positive transition of `pendingAttachmentReads`.
  const prevPendingAttachmentReadsRef = useRef(pendingAttachmentReads)
  useEffect(() => {
    if (pendingAttachmentReads > 0 && prevPendingAttachmentReadsRef.current === 0) {
      announceAttachment('Attaching…')
    }
    prevPendingAttachmentReadsRef.current = pendingAttachmentReads
  }, [pendingAttachmentReads, announceAttachment])
  const attachmentsStatusId = `${sessionId}-attachments-status`
  const attachmentsSummaryId = `${sessionId}-attachments-summary`
  // An inert overlay can't act as a `placeholder` for assistive tech, so its text is exposed via `aria-describedby` (#533).
  const composerHintId = `${sessionId}-composer-hint`

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const indent = useComposerIndent(textareaRef, announceAttachment)
  const indentHintId = `${sessionId}-indent-hint`
  // #897: Chromium fires no blur when a focused element unmounts, so this still reads true after
  // Stop disappears at the end of a turn.
  const stopHadFocusRef = useRef(false)
  // Scopes `handleRemoveImage`'s focus query to this pane's strip; a `document` query hits the first pane in split view.
  const attachmentStripRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  // Pending images and oversized-text chips live in draft-store.ts: renderer-memory-only, cleared on send success, kept across remounts.
  const attachments = useDraftStore((s) => s.bySession[sessionId]?.attachments ?? EMPTY_ATTACHMENTS)
  // Inert sibling matching the textarea's box model so each chip's click overlay lands over its label.
  const chipOverlayRef = useRef<HTMLDivElement>(null)
  const { commandToken, commandPillOverlayRef, markdownSegments, textareaClass } = useCommandPillOverlay(text, commands, textareaRef) // FR-092, #1050
  // `ghost` is the suggestion shown, bound to the draft/cursor it was requested for; `ghostGenerationRef` drops a stale predictWord response.
  const [ghost, setGhost] = useState<{ text: string; cursor: number; suffix: string } | null>(null)
  // Ref mirror so `handleSend`'s async body sees the live `ghost`, not its render-time closure value (#358/#359).
  const ghostRef = useRef<typeof ghost>(null)
  const ghostGenerationRef = useRef(0)
  const ghostDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ghostHintId = `${sessionId}-ghost-hint`
  // Separate from `ghost` so the screen-reader hint doesn't flicker on every debounce cycle (#358/#359).
  const [announcedSuggestion, setAnnouncedSuggestion] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      if (ghostDebounceRef.current) clearTimeout(ghostDebounceRef.current)
    }
  }, [])

  // Pins the overlay's scroll to the textarea's when a suggestion is newly shown (#359).
  useEffect(() => {
    if (ghost && overlayRef.current && textareaRef.current) {
      overlayRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }, [ghost])

  // Same scroll pinning for the text-chip overlay when the chip set changes.
  useEffect(() => {
    if (chipOverlayRef.current && textareaRef.current) {
      chipOverlayRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }, [attachments.textChips])

  useEffect(() => {
    if (autoFocusOnMount) textareaRef.current?.focus()
    // A controlled textarea doesn't default its caret to the end of a restored draft, so set it explicitly (FR-001).
    const end = textareaRef.current?.value.length ?? 0
    textareaRef.current?.setSelectionRange(end, end)
    // Once per mount: the component remounts on Session change, and re-running would steal focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isWorking = status === 'working'
  // Any stop without a stop banner keeps the composer usable; a send starts the agent (#1205).
  const notStarted = status === 'stopped' && (stopReason === 'not-started' || stopReason === undefined)
  const disabled = status === 'stopped' && !notStarted
  useComposerFocusHandoff({ textareaRef, isWorking, disabled, stopHadFocusRef })

  const { slashMatches, showSlashMenu, slashMenuKey, slashMenuViewProps, slashAnnouncement, handleSlashMenuSelect, handleSlashMenuKey } = useSlashMenuCompletion({
    sessionId,
    text,
    commands,
    slashDismissed,
    setSlashDismissed,
    clearGhostState,
    textChips: attachments.textChips,
    announceChipRemoval,
    awaitingCommands: commands.length === 0 && (notStarted || starting)
  })
  // Clamp at render: until the reset effect runs, the index can point past a shorter filtered list.
  const clampedSlashActiveIndex = slashMatches.length > 0 ? Math.min(slashActiveIndex, slashMatches.length - 1) : 0

  // Issue #1067: steer the oldest queued follow-up on a plain Enter against a blank composer.
  const enterQueuedFollowUp = computeEnterSendsQueuedFollowUp(text, attachments, pendingAttachmentReads, queued.chips, showSlashMenu, ghost, disabled)
  // Reset on query change; a layout effect so no paint shows the old index against the new list.
  useLayoutEffect(() => {
    setSlashActiveIndex(0)
  }, [slashMenuKey])

  // One start-and-send at a time per Session: a retry or re-render during the awaits must not send twice (#1812).
  // State, not just the ref, so Send exposes aria-busy and a polite "Sending…" status instead of dropping a second submit silently.
  const [sending, setSending] = useState(false)
  const sendInFlightRef = useRef(false)
  /** `overrideText` sends that text at once; `text` is this render's stale closure value (#938). */
  async function handleSend(overrideText?: string) {
    if (sendInFlightRef.current) return
    sendInFlightRef.current = true
    setSending(true)
    let held = true
    // Idempotent so a later send that took the guard is never released by this one's `finally`.
    const release = () => {
      if (!held) return
      held = false
      sendInFlightRef.current = false
      setSending(false)
    }
    try {
      await sendOnce(release, overrideText)
    } finally {
      release()
    }
  }

  async function sendOnce(releaseSendGuard: () => void, overrideText?: string) {
    // Refuse mid-read, or Enter sends the message without the pending image.
    if (disabled || deleting || starting || pendingAttachmentReads > 0) return
    const draftText = overrideText ?? text
    if (!hasSendableContent(draftText, attachments)) return
    // OMP's queue cannot tell two image-only follow-ups apart (#744).
    const imageOnly = isImageOnlyDraft(draftText, attachments)
    if (imageOnly && isImageOnlyQueued(followUp, steering)) return void toast.error(SECOND_IMAGE_ONLY_REFUSAL)
    // Send bypasses `scheduleGhostCheck`, so a shown suggestion would outlive it without this (#358/#359).
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
    // Refract-native commands run locally and must not start the agent (#1812).
    const attachmentFree = attachments.images.length === 0 && attachments.files.length === 0
    const runsWithoutAgent = attachmentFree && modelsInvocation !== undefined && isLocalNativeCommand(modelsInvocation)
    if (notStarted && !runsWithoutAgent) {
      // Clear pristine before open() so ChatPane's effect is the sole `applySnapshot` caller (a second apply races `transcript:patch`).
      useSplitStore.getState().markOpened(sessionId)
      let snapshot
      try {
        setStarting(true)
        // A typed send is an explicit start (#1205).
        snapshot = await useSessionsStore.getState().open(sessionId, true)
      } finally {
        setStarting(false)
      }
      // A failed start keeps the draft.
      if (!snapshot || snapshot.runtime.status === 'stopped') return
    }
    // Chips are expanded back to their full text before `chat.send`.
    const message = substituteChips(imageOnly ? '' : draftText, attachments.textChips)
    // #926 (D1 HIGH): typed text carrying the literal marker is refused, draft stays intact.
    if (message.includes(FILE_ATTACHMENTS_MARKER)) {
      toast.error(`The message contains the reserved "${FILE_ATTACHMENTS_MARKER}" marker line used internally for file attachments. Remove it and try again.`)
      return
    }
    const images = attachments.images.length > 0 ? attachments.images.map(toImageContent) : undefined
    // A bare `/new` resets via `transcript:patch`, racing this call's result, so scroll memory is cleared before sending (#485).
    // A failed send (e.g. SessionNotIdleError) restores the saved scroll position via `restoreIfAbsent`.
    const slashInvocation = parseSlashCommand(message)
    // `/btw` is handled locally and never forwarded to OMP: it opens the Side chat panel and asks through `useSideChatStore`.
    if (slashInvocation?.name === 'btw') {
      // `btw` has no `images` field; refuse rather than silently drop a screenshot.
      if (attachments.images.length > 0 || attachments.files.length > 0) {
        toast.error("Side questions don't support attachments. Remove them and try again.")
        return
      }
      // Single-flight, as on the panel's own Send button.
      if (useSideChatStore.getState().bySession[sessionId]?.running) {
        toast.error('A side question is already running for this Session.')
        return
      }
      // A bare `/btw` only opens the panel, so it sits above the `!loaded` gate.
      if (slashInvocation.rest.length === 0) {
        useRightPaneStore.getState().openPanel('side-chat')
        useDraftStore.getState().clear(sessionId)
        clearGhostState()
        return
      }
      // Asking before `loadHistory` finishes would start a fresh topic; open the panel without stealing focus.
      // The toast appends its own retry guidance (WCAG 3.3.3) to the shared hint.
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
      // Clear only after `ask` resolves so a failed RPC doesn't lose the typed text.
      // The guard covers only start and send: `ask` runs for the whole reply, and a second `/btw` has its own running toast above.
      releaseSendGuard()
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
      // `inFlight` blocks `record()` until send settles so the old Conversation's scroll isn't inherited by the new one.
      useChatScrollStore.getState().setInFlight(sessionId, true)
    }
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
    // Clear only if the store still holds what this send captured; the user may have kept typing during the await.
    const currentDraft = useDraftStore.getState().bySession[sessionId]
    if (currentDraft?.text === draftText && currentDraft?.attachments === attachments) {
      useDraftStore.getState().clear(sessionId)
    }
    // Typing during the awaits can schedule a ghost request against the wiped draft; invalidate again (#358/#359).
    clearGhostState()
  }

  /** Sends `predictWordFeedback` for the shown suggestion, then clears it; no-op when none is shown. */
  function dismissGhost(accepted: boolean) {
    // Reads `ghostRef`, not the closed-over `ghost`, so post-await calls see live state.
    const current = ghostRef.current
    if (!current) return
    void window.refract.chat.predictWordFeedback(sessionId, current.text, current.cursor, current.suffix, accepted)
    ghostRef.current = null
    setGhost(null)
  }

  /** Resets ghost state for paths that bypass `scheduleGhostCheck` (send, Esc, slash completion) (#358/#359). */
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

  /** Dismisses the shown suggestion after each edit, then debounces a `predictWord` request if eligible; stale responses are dropped. */
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
        // A failed predict_word is just no ghost text; clear any stale announcement.
          setAnnouncedSuggestion(null)
          return
        }
        // The caret may have moved before this resolved (selectionchange can't catch that); drop it with `accepted: false` feedback (#358/#359).
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

  // A pure caret move dismisses the suggestion; Chromium never fires `select` for that, so use document `selectionchange` (#358/#359).
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
        // 'unhandled' (empty list or Shift+Tab) falls through to Tab's ghost/focus handling below.
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSlashDismissed(true)
        return
      }
    }
    // Tab accepts a shown suggestion; modified Tab or IME composition keeps normal focus movement.
    // `ghost.text === text` rejects a suggestion computed against a draft changed outside onChange (#358).
    if (
      ghost &&
      ghost.text === text &&
      event.key === 'Tab' &&
      !indent.tabMovesFocus &&
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
    // Same `ghost.text === text` guard: a stale ghost must not swallow Esc; fall through to composer-clear.
    if (ghost && ghost.text === text && event.key === 'Escape') {
      event.preventDefault()
      dismissGhost(false)
      setAnnouncedSuggestion(null)
      return
    }
    if (indent.handleKeyDown(event)) return
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void (enterQueuedFollowUp.applies ? queued.sendNow(enterQueuedFollowUp.chip) : handleSend())
      return
    }
    if (event.key === 'Escape') {
      // An Escape already handled by `useReadoutCard.ts` (closing a hover card) must not also wipe the draft (#700/#701).
      if (event.defaultPrevented) return
      event.preventDefault()
      clearGhostState()
      useDraftStore.getState().setText(sessionId, '')
      // `setText` bypasses onChange's `pruneDanglingChips`, so drop all chips here with the usual removal announcement.
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

  /** Announces a chip silently dropped by `pruneDanglingChips`, which screen-reader users would otherwise miss (FR-014). */
  function announceChipRemoval(removed: readonly PendingTextChip[]) {
    const [first] = removed
    if (!first) return
    announceAttachment(
      removed.length === 1 ? `Pasted text attachment ${first.label} removed.` : `${removed.length} pasted text attachments removed.`
    )
  }

  /** An image paste wins over plain text; short text falls through to the textarea, only images and over-threshold text are intercepted. */
  async function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const data = event.clipboardData
    const imageFile = findClipboardImageItem(data)
    const pastedFiles = Array.from(data.files ?? [])
    // A plain clipboard-image paste has nothing else in `data.files` (#926).
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

    // Paste-time image-path detection runs on every paste without a clipboard image, however short (#514).
    if (detectImagePathsOnPaste) {
      const pathCandidates = extractImagePathCandidates(pastedText)
      if (pathCandidates.length > 0) {
        if (isImagePathOnlyText(pastedText)) {
          // Path-only paste: attachments replace the text; unresolved candidates fall back to raw text.
          // Capture `currentTarget` and the selection before the first `await`: React nulls the synthetic event afterwards.
          // `before` detects typing during the IPC round trip, in which case the fallback inserts at the current caret instead of stale offsets.
          event.preventDefault()
          const target = event.currentTarget
          const before = target.value
          const start = target.selectionStart
          const end = target.selectionEnd
          // The cap applies per message, shared with pending files (FR-039).
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
          // Re-insert each candidate's RAW text so quoting and `file://` encoding aren't rewritten (FR-022).
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
            // Report overflow and read failures together.
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
        // Mixed paste: the path stays in the draft; candidates resolve in the background and attach silently if they are images (FR-039).
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
          // Over-cap or unresolved paths get a quiet notice (FR-026); the path text stays in the draft.
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

    // Collapse into a pending text chip with a short literal label (FR-011).
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

  // Remove restores focus and announces via the shared `removeAttachment` core (#926).
  const handleRemoveImage = (id: string) => removeAttachment(sessionId, 'image', id, attachmentStripRef, textareaRef, announceAttachment)
  const handleRemoveFile = (id: string) => removeAttachment(sessionId, 'file', id, attachmentStripRef, textareaRef, announceAttachment)

  const placeholder = disabled
    ? describeStopReason(stopReason, stopDetail)
    : ''
  const pendingAttachmentsCount = attachments.images.length + attachments.textChips.length + attachments.files.length
  const describedByIds = [disabled ? stopReasonId : null, ghostHintId, attachmentsSummaryId, composerHintId, indentHintId].filter(Boolean).join(' ')
  const composerClearanceRef = useComposerClearanceCallbackRef() // #980 gate round 2: hoisted out of JSX for clarity

  return (
    <div ref={composerClearanceRef} className="flex shrink-0 flex-col gap-2 border-t border-divider px-4 py-4">
      {disabled && (
        <span id={stopReasonId} className="sr-only">
          {placeholder}
        </span>
      )}
      <div data-slot="slash-menu-announcement" role="status" aria-live="polite" className="sr-only">
        {slashAnnouncement}
      </div>
      <div id={attachmentsStatusId} role="status" aria-live="polite" className="sr-only">
        <span key={attachmentAnnouncement?.seq ?? 0}>{attachmentAnnouncement?.message ?? ''}</span>
      </div>
      <span id={attachmentsSummaryId} className="sr-only">
        {pendingAttachmentsCount > 0
          ? `${pendingAttachmentsCount} pending attachment${pendingAttachmentsCount === 1 ? '' : 's'}`
          : ''}
      </span>
      <span id={composerHintId} className="sr-only">
        {!disabled && text === '' ? (enterQueuedFollowUp.applies ? 'Enter sends the next queued message. Markdown is supported. Type slash for commands.' : 'Markdown is supported. Type slash for commands.') : ''}
      </span>
      <ComposerStatusLine sessionId={sessionId} textareaRef={textareaRef} />
      <AttachmentStrip
        images={attachments.images}
        files={attachments.files}
        textChips={attachments.textChips}
        onRemoveImage={handleRemoveImage}
        onRemoveFile={handleRemoveFile}
        containerRef={attachmentStripRef}
      />
      {pendingAttachmentReads > 0 && <p className="text-xs text-muted-foreground">Attaching…</p>}
      <p role="status" aria-live="polite" className={sending ? 'text-xs text-muted-foreground' : 'sr-only'}>
        {sending ? 'Sending…' : ''}
      </p>
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
          <CommandPillOverlay text={text} token={commandToken} overlayRef={commandPillOverlayRef} markdownSegments={markdownSegments} />
          <ComposerTextarea
            ref={textareaRef}
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
              // Drops chips whose label was broken or deleted, announced via the live region (FR-014).
              const prunedChips = pruneDanglingChips(value, attachments.textChips)
              if (prunedChips.length !== attachments.textChips.length) {
                announceChipRemoval(attachments.textChips.filter((chip) => !prunedChips.includes(chip)))
                useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, textChips: prunedChips }))
              }
            }}
            onPaste={(event) => void handlePaste(event)}
            onScroll={(event) => {
              // The overlay doesn't track the textarea's scroll on its own (#359).
              const scrollTop = (event.target as HTMLTextAreaElement).scrollTop
              if (overlayRef.current) overlayRef.current.scrollTop = scrollTop
              if (chipOverlayRef.current) chipOverlayRef.current.scrollTop = scrollTop
              if (commandPillOverlayRef.current) commandPillOverlayRef.current.scrollTop = scrollTop // FR-092, #1050
            }}
            onKeyDown={handleKeyDown}
            onBlur={indent.resetFocusMode}
            disabled={disabled}
            placeholder={placeholder}
            // The disabled placeholder carries the stop reason, so `ComposerTextarea` brightens it under the dim.
            className={textareaClass}
          />
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
          {ghost && ghost.text === text && (
            <div ref={overlayRef} aria-hidden="true" className={cn(COMPOSER_MIRROR_CLASS, 'z-[2]')}>
              <span className="invisible">{text.slice(0, ghost.cursor)}</span>
              <span className="text-muted-foreground/60">{ghost.suffix}</span>
            </div>
          )}
          {attachments.textChips.length > 0 && (
            <div ref={chipOverlayRef} aria-hidden="true" className={cn(COMPOSER_MIRROR_CLASS, 'z-[2]')}>
              <ChipOverlaySegments
                text={text}
                occurrences={findChipOccurrences(text, attachments.textChips)}
                textareaRef={textareaRef}
              />
            </div>
          )}
          <div id={ghostHintId} role="status" aria-live="polite" className="sr-only">
            {announcedSuggestion ? `Suggestion: "${announcedSuggestion}". Tab to accept, Escape to dismiss.` : ''}
          </div>
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
            <ComposerSendButton
              blocked={disabled || deleting || starting || sending || pendingAttachmentReads > 0 || !hasSendableContent(text, attachments)}
              busy={sending}
              dimWhenBlocked={!disabled}
              keyShortcuts={enterQueuedFollowUp.applies ? undefined : 'Enter'}
              onSend={() => void handleSend()}
              tooltip={
                // The button is aria-disabled when blank and Radix wires the tooltip into aria-describedby, so it must not describe an impossible action.
                enterQueuedFollowUp.applies ? 'Send' : <Kbd>Enter</Kbd>
              }
            />
          </ComposerActions>
        </ComposerField>
        <ComposerFooter>
          <ComposerModePills sessionId={sessionId} />
          <ModelPicker sessionId={sessionId} />
          <ReasoningPicker sessionId={sessionId} />
          <ComposerBranchLabel sessionId={sessionId} />
          <AttachButton sessionId={sessionId} disabled={disabled} />
          <ComposerIndentHint id={indentHintId} tabMovesFocus={indent.tabMovesFocus} />
        </ComposerFooter>
      </ComposerBox>
    </div>
  )
}
