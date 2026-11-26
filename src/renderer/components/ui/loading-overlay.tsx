import { useEffect, useState } from 'react'
import { LoaderCircleIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { BLUR_TRANSITION_CLASS, BLURRED_CONTENT_CLASS } from './blur-content'
import { cn } from '@/lib/utils'

interface LoadingOverlayProps {
  /** Lock the content (`aria-busy`, `inert`) at once; blur it and show the card once `delayMs` has passed. Callers pass it only while content exists. */
  loading: boolean
  children: ReactNode
  className?: string
  /** Classes for the wrapper around `children`, for example to keep a flex column. */
  contentClassName?: string
  /** Replaces the centred "Loading" card with a full-cover interactive overlay, for example a Resume prompt. */
  overlay?: ReactNode
  /** Quiet period before the blur and card appear, so fast fetches never flash them. */
  delayMs?: number
}

/** Blurs non-interactive content behind a centred card while a refetch is in flight. The default card is visual only; the caller's polite status announces it. */
export function LoadingOverlay({ loading, children, className, contentClassName, overlay, delayMs = 150 }: LoadingOverlayProps) {
  const [elapsed, setElapsed] = useState(false)
  useEffect(() => {
    if (!loading || delayMs <= 0) {
      setElapsed(false)
      return
    }
    const timer = setTimeout(() => setElapsed(true), delayMs)
    return () => clearTimeout(timer)
  }, [loading, delayMs])
  const visible = loading && (delayMs <= 0 || elapsed)
  return (
    <div className={cn('relative', className)} aria-busy={loading && !overlay}>
      {visible &&
        (overlay ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-scrim-bg">{overlay}</div>
        ) : (
          // Zero-height sticky anchor keeps the card in view when the content scrolls.
          <div className="sticky top-0 z-10 h-0">
            {/* Same surface as the chat start-up notice (`SessionStartNotice`), so every loading card in the app looks alike. */}
            <div
              aria-hidden
              className="absolute top-16 left-1/2 flex w-max -translate-x-1/2 items-center gap-2 rounded-xl bg-background/90 px-6 py-4 text-base text-muted-foreground backdrop-blur-sm"
            >
              <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin" />
              Loading
            </div>
          </div>
        ))}
      <div
        className={cn(
          BLUR_TRANSITION_CLASS,
          visible && cn('pointer-events-none select-none', BLURRED_CONTENT_CLASS),
          contentClassName
        )}
        inert={loading}
      >
        {children}
      </div>
    </div>
  )
}
