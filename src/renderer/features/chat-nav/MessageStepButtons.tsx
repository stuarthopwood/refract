import { useEffect, useRef, useState } from 'react'
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { FloatingLayer } from '@/components/floating-layer'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { EMPTY_CHAT_NAV, useChatNavStore } from '@/state/chat-nav-store'
import { stepToMessage, type StepDirection } from './stepToMessage'
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

const STEPS: readonly { direction: StepDirection; label: string; Icon: typeof ChevronUpIcon; key: string }[] = [
  { direction: 'previous', label: 'Previous message', Icon: ChevronUpIcon, key: '↑' },
  { direction: 'next', label: 'Next message', Icon: ChevronDownIcon, key: '↓' }
]

/** Previous / Next message buttons, floating at the transcript's right edge. Render inside the
 * transcript's `MessageScroller` root (the positioned container). Also wires Alt+Up / Alt+Down. */
export function MessageStepButtons({ sessionId }: { sessionId: string }) {
  useMessageStepShortcut(sessionId)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const recentScroll = useRecentScrollActivity(anchorRef)
  const scrollable = useChatNavStore((state) => (state.bySession[sessionId] ?? EMPTY_CHAT_NAV).view.scrollable)
  const shown = STEPS.filter((step) => (step.direction === 'previous' ? scrollable.start : scrollable.end))
  return (
    <>
      <span ref={anchorRef} hidden />
      {shown.length > 0 && (
        <FloatingLayer visible={recentScroll} className="inset-e-4 bottom-16" role="group" aria-label="Message navigation">
          {shown.map(({ direction, label, Icon, key }) => (
            <Tooltip key={direction}>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={label} onClick={() => stepToMessage(sessionId, direction)}>
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
      )}
    </>
  )
}
