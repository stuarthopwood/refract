import { LoaderCircleIcon, type LucideProps } from 'lucide-react'
import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const SPIN_CLASS = 'animate-spin motion-reduce:animate-none'

/** The app's one in-flight indicator (#1848): every spinner renders this, so the glyph, rotation and reduced-motion behaviour never drift. Decorative: the caller's visible text or live region names the work. Size comes from the caller's class (a Button or menu item may size its icons). */
export function Spinner({ className, ...props }: LucideProps) {
  return <LoaderCircleIcon aria-hidden {...props} className={cn(SPIN_CLASS, className)} />
}

/** The same rotation drawn as a ring, for a marker that keeps its own content (the Stepper's numbered circle). Position and size come from the caller. */
export function SpinnerRing({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span aria-hidden {...props} className={cn(SPIN_CLASS, 'rounded-full border-2 border-transparent border-r-accent-text border-t-accent-text', className)} />
}
