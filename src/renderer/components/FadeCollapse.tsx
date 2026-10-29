// Fades a block out and collapses its height when `show` turns false, then unmounts it, so a row
// that vanishes (the settled turn line, the current-work banner; issue #1265) does not make the
// content below jump. Enter is immediate: callers that want an entrance animate their own
// content. Under `prefers-reduced-motion` the block unmounts at once. While leaving it keeps
// rendering the last children it was given and is hidden from assistive technology.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

const EXIT_MS = 200

export function FadeCollapse({ show, children, className }: { show: boolean; children: ReactNode; className?: string }) {
  const [mounted, setMounted] = useState(show)
  const [open, setOpen] = useState(show)
  const lastChildren = useRef(children)
  if (show) lastChildren.current = children

  useEffect(() => {
    if (show) {
      setMounted(true)
      setOpen(true)
      return
    }
    setOpen(false)
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setMounted(false)
      return
    }
    const timer = setTimeout(() => setMounted(false), EXIT_MS)
    return () => clearTimeout(timer)
  }, [show])

  if (!show && !mounted) return null
  const leaving = !show
  return (
    <div
      aria-hidden={leaving || undefined}
      inert={leaving || undefined}
      data-state={leaving ? 'leaving' : 'open'}
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
        open && show ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        className
      )}
    >
      <div className="min-h-0 overflow-hidden">{show ? children : lastChildren.current}</div>
    </div>
  )
}
