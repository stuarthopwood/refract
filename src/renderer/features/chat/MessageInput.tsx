// The message box (docs/DESIGN.md "Chat", "Keyboard"): grows up to ~8 lines, Enter sends,
// Shift+Enter inserts a newline, Esc clears, Ctrl+Shift+X stops a running turn. Queue chips come
// only from `useQueueStore` (queue:update events), never from optimistic local state. The
// slash-command menu (T044, FR-032, FR-033) lives in SlashMenu.tsx; this file only decides when
// to show it and handles the keys that drive it.
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { SendIcon, SquareIcon, XIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { formatModelReadout } from '@/lib/modelDisplay'
import { EMPTY_QUEUE, notify, useCommandsStore, useQueueStore, useSessionsStore } from '@/state'
import type { SessionStatusEvent, SlashCommand } from '../../../shared/ipc'
import { applySnapshot, describeStopReason } from './ChatPane'
import { filterSlashCommands, parseSlashQuery, SlashMenu, slashOptionId } from './SlashMenu'
import { ApprovalModePill } from './ApprovalModePill'

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
  // T063: last known provider/model/effort (T062's `lastModel`/`lastThinkingLevel` on the same
  // `SessionSummary` row), never a separate live-only source -- "Model not known yet" before the
  // first `get_state` this Session has ever reported one.
  const modelReadout = useSessionsStore((s) => formatModelReadout(s.sessions.find((x) => x.id === sessionId) ?? {}))
  const { followUp, steering } = useQueueStore((s) => s.bySession[sessionId] ?? EMPTY_QUEUE)
  const commands = useCommandsStore((s) => s.bySession[sessionId] ?? EMPTY_COMMANDS)
  const [text, setText] = useState('')
  const [starting, setStarting] = useState(false)
  const [slashActiveIndex, setSlashActiveIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const stopReasonId = `${sessionId}-stop-reason`
  const slashMenuId = `${sessionId}-slash-menu`

  const statusRef = useRef(status)
  statusRef.current = status
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // T103, FR-058: ghost-text composer completion. `ghost` is the suggestion actually shown,
  // bound to the exact draft/cursor it was requested for; `ghostGenerationRef` guards a
  // predictWord response against a newer edit superseding it before it resolves (same guard as
  // SessionDetailsCard's diffStat stale-response fix).
  const [ghost, setGhost] = useState<{ text: string; cursor: number; suffix: string } | null>(null)
  const ghostGenerationRef = useRef(0)
  const ghostDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ghostHintId = `${sessionId}-ghost-hint`

  useEffect(() => {
    return () => {
      if (ghostDebounceRef.current) clearTimeout(ghostDebounceRef.current)
    }
  }, [])

  useEffect(() => {
    if (autoFocusOnMount) textareaRef.current?.focus()
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

  const chips: QueuedChip[] = [
    ...followUp.map((chipText, index) => ({ key: `followUp-${index}-${chipText}`, text: chipText })),
    ...steering.map((chipText, index) => ({ key: `steering-${index}-${chipText}`, text: chipText }))
  ]

  // The active row resets whenever the typed query changes, so a stale index from a longer list
  // never survives into a shorter, filtered one.
  useEffect(() => {
    setSlashActiveIndex(0)
  }, [slashQuery])

  // Ctrl+Shift+X stops the running turn while this pane is mounted (docs/DESIGN.md "Keyboard").
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== 'x') return
      event.preventDefault()
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
    const message = text
    if (!message.trim()) return
    if (notStarted) {
      let snapshot
      try {
        setStarting(true)
        snapshot = await useSessionsStore.getState().open(sessionId)
      } finally {
        setStarting(false)
      }
      if (!snapshot) return
      applySnapshot(sessionId, snapshot)
    }
    // Unknown `/name` text is rejected by chat.send with `unknown-command` (FR-033); a listed
    // command given unverified arguments gets `unsupported-arguments` instead (issue #129); notify
    // below shows either as a toast, same as any other IPC error.
    const result = await window.refract.chat.send(sessionId, message)
    if (!result.ok) {
      notify(result.error)
      return
    }
    setText('')
  }

  /** Enter or Tab on a highlighted slash command (FR-032): fills the box with `/name ` so the
   * box no longer parses as a bare slash query, which closes the menu without extra state. */
  function completeSlashCommand(command: SlashCommand) {
    setText(`/${command.name} `)
    setSlashDismissed(false)
  }

  /** Sends `predictWordFeedback` for whatever suggestion is currently shown, at most once per
   * shown-then-abandoned suggestion (FR-058), then clears it. A no-op when nothing is shown. */
  function dismissGhost(accepted: boolean) {
    if (!ghost) return
    void window.refract.chat.predictWordFeedback(sessionId, ghost.text, ghost.cursor, ghost.suffix, accepted)
    setGhost(null)
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
    if (!isGhostTextEligible(nextText, nextCursor)) return
    ghostDebounceRef.current = setTimeout(() => {
      ghostDebounceRef.current = null
      void window.refract.chat.predictWord(sessionId, nextText, nextCursor).then((result) => {
        if (ghostGenerationRef.current !== generation) return // superseded by a later edit
        if (!result.ok) return // never surfaced as an error: a failed predict_word is just no ghost text
        if (typeof result.value !== 'string' || result.value.length === 0) return
        setGhost({ text: nextText, cursor: nextCursor, suffix: result.value })
      })
    }, GHOST_TEXT_DEBOUNCE_MS)
  }

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
    // Tab accepts a shown ghost-text suggestion (FR-058); with none shown, Tab is left
    // unhandled below so it keeps its normal field-leaving focus-movement behavior.
    if (ghost && event.key === 'Tab') {
      event.preventDefault()
      const { cursor, suffix } = ghost
      const nextText = text.slice(0, cursor) + suffix + text.slice(cursor)
      const nextCursor = cursor + suffix.length
      void window.refract.chat.predictWordFeedback(sessionId, ghost.text, ghost.cursor, ghost.suffix, true)
      ghostGenerationRef.current++ // invalidate any request still in flight for the old draft
      setGhost(null)
      setText(nextText)
      requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(nextCursor, nextCursor)
      })
      return
    }
    if (ghost && event.key === 'Escape') {
      event.preventDefault()
      dismissGhost(false)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSend()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setText('')
    }
  }

  async function handleStop() {
    const result = await window.refract.chat.stop(sessionId)
    if (!result.ok) notify(result.error)
  }

  async function handleRemoveQueued(queuedText: string) {
    const result = await window.refract.chat.removeQueued(sessionId, queuedText)
    if (!result.ok) notify(result.error)
  }

  async function handleSendNow(queuedText: string) {
    const result = await window.refract.chat.sendNow(sessionId, queuedText)
    if (!result.ok) notify(result.error)
  }

  const placeholder = disabled
    ? describeStopReason(stopReason, stopDetail)
    : 'Message the agent… (/ for commands)'

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3">
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <Badge key={chip.key} variant="secondary" className="max-w-full gap-1.5 py-1 pr-1">
              <span className="max-w-64 truncate" title={chip.text}>
                {chip.text}
              </span>
              <button
                type="button"
                aria-label={`Send now: ${chip.text}`}
                className="rounded-full px-1 text-[0.7rem] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                onClick={() => void handleSendNow(chip.text)}
              >
                Send now
              </button>
              <button
                type="button"
                aria-label={`Remove queued message: ${chip.text}`}
                className="rounded-full p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                onClick={() => void handleRemoveQueued(chip.text)}
              >
                <XIcon className="size-3" />
              </button>
            </Badge>
          ))}
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
      {/* Chip row (docs/DESIGN.md "Chat"; spec 004 appends readout chips after the pill): the
          Approval mode pill is always the first item, FR-056. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <ApprovalModePill sessionId={sessionId} />
      </div>
      {/* T063/quality-gate fix: a real `bg-muted/60` fill (distinct from the page's own
          `bg-background` -- `ChatPane.tsx` sets no background of its own, so a translucent
          `bg-background/40` here composited to literally the same colour as the page, a no-op)
          plus a `border-muted-foreground/85` border re-measured at >=3:1 against both the page
          background and this fill (WCAG 1.4.11), Send/Stop moved inside as round icon-only
          buttons, and the provider/model/effort readout along the bottom. `focus-within` replaces
          the Textarea's own (now removed) focus ring so the whole field, not just the text area,
          shows the focus state. */}
      <div className="flex flex-col gap-1 rounded-lg border border-muted-foreground/85 bg-muted/60 pt-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
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
            aria-describedby={disabled ? `${stopReasonId} ${ghostHintId}` : ghostHintId}
            value={text}
            onChange={(event) => {
              const value = event.target.value
              const cursor = event.target.selectionStart ?? value.length
              setText(value)
              setSlashDismissed(false)
              scheduleGhostCheck(value, cursor)
            }}
            onSelect={(event) => {
              // A cursor move with no accompanying edit (click, arrow keys) that lands away from
              // where a shown suggestion was requested invalidates it too (FR-058); onChange
              // already handles the edit case, so this is a no-op (dismissGhost checks `ghost`)
              // when nothing actually moved away from it.
              if (!ghost) return
              const target = event.target as HTMLTextAreaElement
              if (target.selectionStart !== ghost.cursor || target.selectionEnd !== ghost.cursor) dismissGhost(false)
            }}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder={placeholder}
            className="max-h-48 min-h-16 resize-none overflow-y-auto border-none bg-transparent pr-20 shadow-none focus-visible:border-none focus-visible:ring-0 dark:bg-transparent"
          />
          {/* Ghost-text overlay (T103, FR-058): an inert sibling, not part of the textarea's own
              accessible value -- matching its box model exactly (same padding/font classes) so
              the invisible leading span reserves the same space the real draft occupies, landing
              the dimmed suffix immediately after the cursor. */}
          {ghost && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-2.5 py-2 pr-20 text-base md:text-sm"
            >
              <span className="invisible">{text.slice(0, ghost.cursor)}</span>
              <span className="text-muted-foreground/60">{ghost.suffix}</span>
            </div>
          )}
          {/* Discoverable per FR-058 without firing on every keystroke: only changes text when a
              suggestion actually becomes shown or is cleared, not on every debounce tick. */}
          <div id={ghostHintId} role="status" aria-live="polite" className="sr-only">
            {ghost ? 'Suggestion available. Press Tab to accept, Escape to dismiss.' : ''}
          </div>
          <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1">
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
                  <SendIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <Kbd>Enter</Kbd>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        <p className="truncate px-2.5 pb-1 text-xs text-muted-foreground">{modelReadout}</p>
      </div>
    </div>
  )
}
