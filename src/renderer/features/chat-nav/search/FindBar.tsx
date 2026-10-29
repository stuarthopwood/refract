import { useEffect, useId, useRef, useState } from 'react'
import { CaseSensitiveIcon, ChevronDownIcon, ChevronUpIcon, XIcon } from 'lucide-react'
import { FloatingLayer } from '@/components/floating-layer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { closeChatFind, EMPTY_CHAT_FIND, useChatFindStore } from '@/state/chat-find-store'
import { FindResultsList } from './FindResultsList'
import { useChatFind } from './useChatFind'

const SETTLE_MS = 400

/** Delays a live-region message until typing has paused, so a screen reader is not interrupted per keystroke. */
function useSettledText(text: string): string {
  const [settled, setSettled] = useState(text)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(text), SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [text])
  return settled
}

function stepButton(label: string, key: string[], Icon: typeof ChevronUpIcon, disabled: boolean, onClick: () => void) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} disabled={disabled} onClick={onClick}>
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        <KbdGroup>
          {key.map((part) => (
            <Kbd key={part}>{part}</Kbd>
          ))}
        </KbdGroup>
      </TooltipContent>
    </Tooltip>
  )
}

/** The chat Find bar and its results list (spec 041, #753). Mounted only while the bar is open. */
export function FindBar({ sessionId }: { sessionId: string }) {
  const entry = useChatFindStore((state) => state.bySession[sessionId] ?? EMPTY_CHAT_FIND)
  const { query, matchCase, focusTick } = entry
  const inputRef = useRef<HTMLInputElement>(null)
  const returnTo = useRef<HTMLElement | null>(entry.returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null))
  const helpId = useId()
  const find = useChatFind(sessionId, query, matchCase)
  const announced = useSettledText(find.status)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusTick])

  function close() {
    closeChatFind(sessionId)
    const target = returnTo.current
    requestAnimationFrame(() => {
      if (target?.isConnected) target.focus({ preventScroll: true })
    })
  }

  function setQuery(value: string) {
    useChatFindStore.getState().setQuery(sessionId, value)
  }

  return (
    <FloatingLayer
      role="search"
      aria-label="Find in chat"
      data-chat-find=""
      className="inset-e-4 top-2 w-[min(30rem,calc(100%-2rem))]"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        close()
      }}
    >
      <div className="flex items-center gap-1 p-1">
        <Input
          ref={inputRef}
          type="text"
          role="searchbox"
          aria-label="Find in chat"
          aria-describedby={helpId}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            find.flush()
            if (event.shiftKey) find.previous()
            else find.next()
          }}
        />
        <span role="status" aria-live="polite" className="min-w-16 shrink-0 text-center text-compact text-muted-foreground">
          {announced}
        </span>
        {stepButton('Previous match', ['Shift', 'Enter'], ChevronUpIcon, find.matches.length === 0, find.previous)}
        {stepButton('Next match', ['Enter'], ChevronDownIcon, find.matches.length === 0, find.next)}
        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle
              size="sm"
              aria-label="Match case"
              pressed={matchCase}
              onPressedChange={(pressed) => useChatFindStore.getState().setMatchCase(sessionId, pressed)}
            >
              <CaseSensitiveIcon />
            </Toggle>
          </TooltipTrigger>
          <TooltipContent>Match case</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Close find" onClick={close}>
              <XIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Close
            <Kbd>Esc</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>
      <p id={helpId} className="px-2 pb-1 text-compact text-muted-foreground">
        Searches your messages and the agent&apos;s replies
      </p>
      <FindResultsList matches={find.matches} cursor={find.cursor} capped={find.capped} onSelect={find.select} />
    </FloatingLayer>
  )
}
