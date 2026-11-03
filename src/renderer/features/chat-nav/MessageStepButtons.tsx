import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { FloatingLayer } from '@/components/floating-layer'
import { Button } from '@/components/ui/button'
import { FLOATING_ICON_BUTTON_CLASS } from '@/components/ui/message-scroller'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { EMPTY_CHAT_NAV, useChatNavStore } from '@/state/chat-nav-store'
import { focusTranscriptViewport } from './focusChatFallback'
import type { StepDirection } from './messageIndex'
import { stepToMessage } from './stepToMessage'
import { useMessageStepShortcut } from './useMessageStepShortcut'

const FADE_OUT_DELAY_MS = 2000

/** True while the user has scrolled within the last 2 s. Listens on the pane's scroller viewport
 * (found from `anchorRef`'s scroller root), ignoring the scroller's own autoscroll. */
function useRecentScrollActivity(anchorRef: React.RefObject<HTMLElement | null>): boolean {
  const [active, setActive] = useState(false)
  useEffect(() => {
    const viewport = anchorRef.current?.parentElement?.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
    if (!viewport) return
    let timer: number | undefined
    function poke() {
      setActive(true)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setActive(false), FADE_OUT_DELAY_MS)
    }
    function onScroll() {
      if (!viewport?.hasAttribute('data-autoscrolling')) poke()
    }
    viewport.addEventListener('scroll', onScroll, { passive: true })
    viewport.addEventListener('wheel', poke, { passive: true })
    viewport.addEventListener('keydown', poke)
    viewport.addEventListener('pointerdown', poke)
    return () => {
      window.clearTimeout(timer)
      viewport.removeEventListener('scroll', onScroll)
      viewport.removeEventListener('wheel', poke)
      viewport.removeEventListener('keydown', poke)
      viewport.removeEventListener('pointerdown', poke)
    }
  }, [anchorRef])
  return active
}

const STEPS: readonly { direction: StepDirection; label: string; Icon: typeof ChevronUpIcon; key: string; shortcut: string }[] = [
  { direction: 'previous', label: 'Previous message', Icon: ChevronUpIcon, key: '↑', shortcut: 'Alt+ArrowUp' },
  { direction: 'next', label: 'Next message', Icon: ChevronDownIcon, key: '↓', shortcut: 'Alt+ArrowDown' }
]

/** Previous / Next message buttons, stacked above "Scroll to end" in the transcript's right-edge
 * column. Both stay mounted in fixed slots: an inapplicable one is `invisible` and `inert`, and if
 * it held focus, focus moves to its sibling (or the transcript) first so it never drops to the
 * body. Render inside the transcript's `MessageScroller` root. Also wires Alt+Up / Alt+Down. */
export function MessageStepButtons({ sessionId }: { sessionId: string }) {
  useMessageStepShortcut(sessionId)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const buttonRefs = useRef<Record<StepDirection, HTMLButtonElement | null>>({ previous: null, next: null })
  const recentScroll = useRecentScrollActivity(anchorRef)
  const scrollable = useChatNavStore((state) => (state.bySession[sessionId] ?? EMPTY_CHAT_NAV).view.scrollable)
  const applicable: Record<StepDirection, boolean> = { previous: scrollable.start, next: scrollable.end }

  useLayoutEffect(() => {
    for (const { direction } of STEPS) {
      const button = buttonRefs.current[direction]
      if (applicable[direction] || !button || document.activeElement !== button) continue
      const sibling = buttonRefs.current[direction === 'previous' ? 'next' : 'previous']
      const other = direction === 'previous' ? 'next' : 'previous'
      if (applicable[other] && sibling) sibling.focus({ preventScroll: true })
      else focusTranscriptViewport(sessionId)
    }
  }, [applicable.previous, applicable.next])

  return (
    <>
      <span ref={anchorRef} hidden />
      <FloatingLayer bare visible={recentScroll} className="inset-e-6 bottom-[3.25rem]" role="group" aria-label="Message navigation">
        {STEPS.map(({ direction, label, Icon, key, shortcut }) => (
          <Tooltip key={direction}>
            <TooltipTrigger asChild>
              <Button
                ref={(node) => {
                  buttonRefs.current[direction] = node
                }}
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={label}
                aria-keyshortcuts={shortcut}
                inert={!applicable[direction]}
                onClick={() => stepToMessage(sessionId, direction)}
                className={cn(FLOATING_ICON_BUTTON_CLASS, !applicable[direction] && 'invisible')}
              >
                <Icon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">
              {label}
              <KbdGroup>
                <Kbd>Alt</Kbd>
                <Kbd>{key}</Kbd>
              </KbdGroup>
            </TooltipContent>
          </Tooltip>
        ))}
      </FloatingLayer>
    </>
  )
}
