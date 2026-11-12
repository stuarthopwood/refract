// Pause mode (#477): wraps the chat body (transcript, composer, banners above it). While the
// Session is Paused the body is blurred and inert and an overlay offers Resume; Space resumes the
// paused pane the keyboard is in. A Pausing Session (turn still running) stays interactive: new
// messages are held, and a slim banner above the body reads "Pausing after this turn" with Cancel.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { PauseIcon, PlayIcon } from 'lucide-react'
import { PaneBanner } from '@/components/PaneBanner'
import { Button } from '@/components/ui/button'
import { LoadingOverlay } from '@/components/ui/loading-overlay'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Kbd } from '@/components/ui/kbd'
import { focusSessionPane } from '@/lib/focus'
import { EMPTY_TRANSCRIPT, useSessionsStore, useSplitStore, useTranscriptStore } from '@/state'
import { setSessionPaused } from './pauseActions'
import { pausedNoticeAnnouncement } from './pausedNotices'

// Space must keep its meaning in text fields, buttons, menus, dialogs and anything focusable.
const SPACE_OWNERS =
  'input, textarea, select, button, a[href], summary, [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"]), [role="menu"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="dialog"], [role="alertdialog"], [role="listbox"], [role="option"], [role="combobox"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="button"], [role="treeitem"], [role="row"], [role="gridcell"], [role="slider"], [role="spinbutton"]'

export function PausedBody({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const pause = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.pause)
  const stopped = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status === 'stopped')
  const paused = pause === 'paused'
  const resumeRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const previous = useRef(pause)
  // Queued, not replaced: a notice and the status change land in either order and both must be
  // spoken. One child per message, so a screen reader reads only what was added.
  const [announcements, setAnnouncements] = useState<{ key: number; text: string }[]>([])
  const nextKey = useRef(0)
  const timers = useRef<number[]>([])
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), [])
  const announce = useCallback((text: string) => {
    setAnnouncements((q) => [...q, { key: nextKey.current++, text }])
    timers.current.push(window.setTimeout(() => setAnnouncements((q) => q.slice(1)), 6000))
  }, [])
  const items = useTranscriptStore((s) => s.bySession[sessionId]?.items ?? EMPTY_TRANSCRIPT.items)
  const seenNotices = useRef<Set<string> | null>(null)

  // Notices already in the transcript on mount are history, not news.
  useEffect(() => {
    const known = seenNotices.current
    if (!known) {
      seenNotices.current = new Set(items.filter((i) => i.kind === 'notice').map((i) => i.id))
      return
    }
    const { text, ids } = pausedNoticeAnnouncement(items, known)
    for (const id of ids) known.add(id)
    if (text) announce(text)
  }, [items, announce])

  useEffect(() => {
    if (previous.current === pause) return
    const was = previous.current
    previous.current = pause
    if (pause === 'pausing') announce('Pausing after the current turn')
    else if (pause === 'paused') announce('Session paused')
    else if (was) announce('Session resumed')
    const active = document.activeElement
    const lost = !active || active === document.body || rootRef.current?.contains(active)
    if (pause === 'paused') {
      if (lost) resumeRef.current?.focus()
    } else if (was === 'paused' && lost) {
      // The overlay's Resume button unmounts; put focus back in the composer, not <body>.
      requestAnimationFrame(() => focusSessionPane(sessionId))
    }
  }, [pause, sessionId, announce])

  useEffect(() => {
    if (!paused) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== ' ' || event.defaultPrevented || event.repeat) return
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
      const target = event.target
      if (target instanceof Element && target.closest(SPACE_OWNERS)) return
      // Focus-scoped (WCAG 2.1.4): only from inside this pane, or from <body> when this is the focused pane.
      const pane = rootRef.current?.closest('[data-session-pane]') ?? rootRef.current
      const inside = target instanceof Node && !!pane?.contains(target)
      const split = useSplitStore.getState()
      const focusedHere = split.paneSessionIds.length < 2 || split.paneSessionIds[split.focusedIndex] === sessionId
      if (!inside && !(target === document.body && focusedHere)) return
      event.preventDefault()
      void setSessionPaused(sessionId, false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [paused, sessionId])

  function handleStart() {
    useSplitStore.getState().markOpened(sessionId)
    void useSessionsStore.getState().open(sessionId, true)
  }

  return (
    <div ref={rootRef} className="relative flex min-h-0 flex-1 flex-col">
      {pause === 'pausing' && (
        <PaneBanner role="region" aria-label="Pausing" severity="warning" title="Pausing after this turn" className="shrink-0 px-4 py-2">
          <Button type="button" variant="ghost" size="xs" onClick={() => void setSessionPaused(sessionId, false)}>
            Cancel pause
          </Button>
        </PaneBanner>
      )}
      <LoadingOverlay
        loading={paused}
        delayMs={0}
        className="flex min-h-0 flex-1 flex-col"
        contentClassName="flex min-h-0 flex-1 flex-col"
        overlay={
          <div role="group" aria-label="Session paused" className="rounded-md bg-background shadow-md">
            <Empty className="flex-none">
              <EmptyHeader>
                <EmptyMedia>
                  <PauseIcon aria-hidden className="size-16 text-state-paused" />
                </EmptyMedia>
                <EmptyTitle>Paused</EmptyTitle>
                <EmptyDescription className="text-foreground">
                  Press <Kbd>Space</Kbd> or select Resume
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button ref={resumeRef} type="button" variant={stopped ? 'ghost' : 'default'} onClick={() => void setSessionPaused(sessionId, false)}>
                  <PlayIcon aria-hidden />
                  Resume
                </Button>
                {stopped && (
                  <Button type="button" onClick={handleStart}>
                    Start agent
                  </Button>
                )}
              </EmptyContent>
            </Empty>
          </div>
        }
      >
        {children}
      </LoadingOverlay>
      <div aria-live="polite" aria-atomic="false" aria-relevant="additions" className="sr-only">
        {announcements.map((a) => (
          <span key={a.key}>{a.text}</span>
        ))}
      </div>
    </div>
  )
}
