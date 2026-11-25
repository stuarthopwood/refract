import * as React from 'react'
import { Loader2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Retry for a refused send. It stays mounted, aria-disabled and busy, while its send is in flight, so focus is
 * not dropped to the page; once it goes, a focused Retry hands focus to `handoffTo` first.
 */
export function RetryButton({ busy, onRetry, handoffTo }: { busy: boolean; onRetry: () => void; handoffTo: React.RefObject<HTMLElement | null> }) {
  const ref = React.useRef<HTMLButtonElement>(null)
  React.useLayoutEffect(() => {
    return () => {
      if (ref.current && document.activeElement === ref.current) handoffTo.current?.focus()
    }
  }, [handoffTo])
  return (
    <Button ref={ref} size="sm" variant="ghost" aria-disabled={busy} aria-busy={busy} className="aria-disabled:opacity-50" onClick={() => !busy && onRetry()}>
      {busy && <Loader2Icon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
      Retry
    </Button>
  )
}
