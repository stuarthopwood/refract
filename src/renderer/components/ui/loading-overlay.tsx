import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface LoadingOverlayProps {
  /** Blur and lock the content and show the centred card. Callers pass it only while content exists. */
  loading: boolean
  children: ReactNode
  className?: string
}

/** Blurs non-interactive content behind a centred "Loading" card while a refetch is in flight. */
export function LoadingOverlay({ loading, children, className }: LoadingOverlayProps) {
  return (
    <div className={cn('relative', className)} aria-busy={loading}>
      {loading && (
        // Zero-height sticky anchor keeps the card in view when the content scrolls.
        <div className="sticky top-0 z-10 h-0">
          <div
            role="status"
            aria-live="polite"
            className="absolute top-16 left-1/2 -translate-x-1/2 rounded-md border border-border bg-background/90 px-4 py-2 text-sm shadow-md backdrop-blur-sm"
          >
            Loading
          </div>
        </div>
      )}
      <div
        className={cn(
          'transition-[filter] duration-150 motion-reduce:transition-none',
          loading && 'pointer-events-none blur-sm select-none'
        )}
        inert={loading}
      >
        {children}
      </div>
    </div>
  )
}
