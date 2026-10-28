import type { CSSProperties, MouseEventHandler } from 'react'
import { cn } from '@/lib/utils'
import { ImageUnavailable } from './ImageUnavailable'

export interface ImageThumbnailProps {
  state: 'loading' | 'ready' | 'unavailable'
  src?: string
  /** Accessible name of the tile button (or of the placeholder when unavailable). */
  label: string
  /** Absent for a non-interactive tile. The loading and ready states are buttons; unavailable never is. */
  onClick?: MouseEventHandler<HTMLButtonElement>
  /** One image at natural size (never upscaled, `maxHeight` tall at most) instead of a square tile. */
  single?: boolean
  maxHeight?: number
  /** Known pixel size, used to reserve the tile's space while it loads. */
  width?: number
  height?: number
  /** "+N" chip for images hidden past the last visible tile; renders in every state. */
  overflow?: number
  className?: string
}

/** One image tile (Message image, CONTEXT.md): a bordered button with loading, ready and
 * unavailable states and an optional "+N" overflow chip. Used by `MessageImageGrid` and by the
 * composer's pending-paste thumbnail. */
export function ImageThumbnail({ state, src, label, onClick, single, maxHeight, width, height, overflow = 0, className }: ImageThumbnailProps) {
  const frame = cn('relative overflow-hidden rounded-md border border-border bg-muted', single ? 'inline-block max-w-full' : 'aspect-square w-full', className)
  const badge =
    overflow > 0 ? (
      <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="rounded-full border border-border bg-popover/90 px-2 py-1 text-sm font-medium text-popover-foreground forced-colors:border-[CanvasText] forced-colors:bg-[Canvas] forced-colors:text-[CanvasText]">
          +{overflow}
        </span>
      </span>
    ) : null

  if (state === 'unavailable') {
    return (
      <div role="img" aria-label={label} className={cn(frame, 'min-h-16 min-w-16 p-2')}>
        <ImageUnavailable className="size-full" />
        {badge}
      </div>
    )
  }

  const ready = state === 'ready'
  let reserve: CSSProperties | undefined
  if (!ready && width && height) {
    reserve = { aspectRatio: `${width} / ${height}` }
    if (single) reserve.width = Math.min(width, ((maxHeight ?? height) * width) / height)
  } else if (!ready && single) {
    reserve = { width: 96, height: 96 }
  }

  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(frame, 'block min-h-6 min-w-6 cursor-zoom-in focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring', !ready && 'animate-pulse motion-reduce:animate-none')}
      style={reserve}
    >
      {ready && <img src={src} alt="" loading="lazy" className={single ? 'max-w-full object-contain' : 'size-full object-cover'} style={single && maxHeight ? { maxHeight } : undefined} />}
      {badge}
    </button>
  )
}
