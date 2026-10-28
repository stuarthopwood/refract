import { ImageOffIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/** The "image is gone" placeholder, shared by a message-image tile and the Image viewer so both
 * show the same icon at the same size. The caller adds the role and any sizing. */
export function ImageUnavailable({ className, role }: { className?: string; role?: 'status' | 'img' }) {
  return (
    <div role={role} className={cn('flex flex-col items-center justify-center gap-1 text-center text-xs text-muted-foreground', className)}>
      <ImageOffIcon aria-hidden className="size-4 shrink-0" />
      <span aria-hidden>Image no longer available</span>
    </div>
  )
}
