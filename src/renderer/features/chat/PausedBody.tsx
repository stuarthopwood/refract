// Pause mode (#477): wraps the chat body (transcript, composer, banners above it). While the
// Session is Paused the body is blurred and inert and an overlay offers Resume; Space resumes the
// focused paused pane. A Pausing Session (turn still running) stays interactive: new messages
// are held, and the header reads "Pausing…".
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { PauseIcon, PlayIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import { useSessionsStore, useSplitStore } from '@/state'
import { setSessionPaused } from './pauseActions'

// Space must keep its meaning in text fields, buttons, menus and dialogs.
const SPACE_OWNERS = 'input, textarea, select, button, a[href], summary, [contenteditable]:not([contenteditable="false"]), [role="menu"], [role="menuitem"], [role="dialog"], [role="alertdialog"], [role="listbox"], [role="option"], [role="combobox"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"]'

function isFocusedPane(sessionId: string): boolean {
  const { paneSessionIds, focusedIndex } = useSplitStore.getState()
  return paneSessionIds.length < 2 || paneSessionIds[focusedIndex] === sessionId
}

export function PausedBody({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const pause = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.pause)
  const paused = pause === 'paused'
  const resumeRef = useRef<HTMLButtonElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const previous = useRef(pause)
  const [announcement, setAnnouncement] = useState('')

  useEffect(() => {
    if (previous.current === pause) return
    const was = previous.current
    previous.current = pause
    if (pause === 'pausing') setAnnouncement('Pausing after the current turn')
    else if (pause === 'paused') setAnnouncement('Session paused')
    else if (was) setAnnouncement('Session resumed')
    if (pause === 'paused') {
      const active = document.activeElement
      if (!active || active === document.body || bodyRef.current?.contains(active)) resumeRef.current?.focus()
    }
  }, [pause])

  useEffect(() => {
    if (!paused) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== ' ' || event.defaultPrevented || event.repeat) return
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
      if (event.target instanceof Element && event.target.closest(SPACE_OWNERS)) return
      if (!isFocusedPane(sessionId)) return
      event.preventDefault()
      void setSessionPaused(sessionId, false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [paused, sessionId])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={bodyRef}
        inert={paused}
        className={cn('flex min-h-0 flex-1 flex-col', paused && 'pointer-events-none select-none blur-sm motion-reduce:blur-none motion-reduce:opacity-40')}
      >
        {children}
      </div>
      {paused && (
        <div
          role="group"
          aria-label="Session paused"
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/40 text-center"
        >
          <PauseIcon aria-hidden className="size-16 text-state-paused" />
          <p className="text-lg font-medium">Paused</p>
          <p className="text-sm text-muted-foreground">
            Press <Kbd>Space</Kbd> or select Resume
          </p>
          <Button ref={resumeRef} type="button" onClick={() => void setSessionPaused(sessionId, false)}>
            <PlayIcon aria-hidden />
            Resume
          </Button>
        </div>
      )}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}
