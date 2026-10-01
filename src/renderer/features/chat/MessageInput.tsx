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
import { cn } from '@/lib/utils'
import { EMPTY_QUEUE, notify, useCommandsStore, useQueueStore, useSessionsStore } from '@/state'
import type { SessionStatusEvent, SlashCommand } from '../../../shared/ipc'
import { applySnapshot, describeStopReason } from './ChatPane'
import { filterSlashCommands, parseSlashQuery, SlashMenu, slashOptionId } from './SlashMenu'

type StopReason = SessionStatusEvent['stopReason']

// Stable reference so the zustand selector below never returns a fresh array when there is no
// match; a new `[]` literal every call breaks useSyncExternalStore's snapshot stability and
// causes an infinite re-render loop.
const EMPTY_COMMANDS: SlashCommand[] = []

interface QueuedChip {
  key: string
  text: string
}

interface MessageInputProps {
  sessionId: string
  stopReason?: StopReason
  stopDetail?: string
}

export function MessageInput({ sessionId, stopReason, stopDetail }: MessageInputProps) {
  const status = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status ?? 'stopped')
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
      void window.pinion.chat.stop(sessionIdRef.current).then((result) => {
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
    // Unknown `/name` text is rejected by chat.send with `unknown-command` (FR-033); notify below
    // shows it as a toast, same as any other IPC error.
    const result = await window.pinion.chat.send(sessionId, message)
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
    const result = await window.pinion.chat.stop(sessionId)
    if (!result.ok) notify(result.error)
  }

  async function handleRemoveQueued(queuedText: string) {
    const result = await window.pinion.chat.removeQueued(sessionId, queuedText)
    if (!result.ok) notify(result.error)
  }

  async function handleSendNow(queuedText: string) {
    const result = await window.pinion.chat.sendNow(sessionId, queuedText)
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
      <div className="relative flex items-end gap-2">
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
          role="combobox"
          aria-label="Message"
          aria-autocomplete="list"
          aria-expanded={showSlashMenu && slashMatches.length > 0}
          aria-controls={showSlashMenu && slashMatches.length > 0 ? slashMenuId : undefined}
          aria-activedescendant={
            showSlashMenu && slashMatches.length > 0 ? slashOptionId(slashMenuId, clampedSlashActiveIndex) : undefined
          }
          aria-describedby={disabled ? stopReasonId : undefined}
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setSlashDismissed(false)
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          className="max-h-48 min-h-16 resize-none overflow-y-auto"
        />
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {isWorking && (
            <div className="flex items-center gap-1.5">
              <KbdGroup className="text-muted-foreground">
                <Kbd>Ctrl</Kbd>
                <Kbd>Shift</Kbd>
                <Kbd>X</Kbd>
              </KbdGroup>
              <Button type="button" variant="outline" size="sm" onClick={() => void handleStop()}>
                <SquareIcon />
                Stop
              </Button>
            </div>
          )}
          <Button type="button" size="sm" disabled={disabled || starting || !text.trim()} onClick={() => void handleSend()}>
            <SendIcon />
            Send
          </Button>
        </div>
      </div>
    </div>
  )
}
