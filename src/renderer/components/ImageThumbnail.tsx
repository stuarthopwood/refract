import * as React from 'react'
import type { CSSProperties, MouseEventHandler } from 'react'
import { useDevicePixelRatio } from '@/hooks/useDevicePixelRatio'
import { maxDrawnSize, tileImageFit } from '@/lib/imageSize'
import { cn } from '@/lib/utils'
import { ImageUnavailable } from './ImageUnavailable'

/** The frame's 1 px border on both sides; the reserved loading box adds it so it matches the final tile. */
const FRAME_BORDER_TOTAL_PX = 2
/** Loading box of a single image whose pixel size is not known yet. */
const UNKNOWN_SIZE_PLACEHOLDER_PX = 96

export interface ImageThumbnailProps {
  state: 'loading' | 'ready' | 'unavailable'
  src?: string
  /** Accessible name of the tile button (or of the placeholder when unavailable). */
  label: string
  /** Absent for a non-interactive tile. The loading and ready states are buttons; an unavailable tile is one only as the "+N" tile (`overflow` > 0), so the hidden images stay reachable. */
  onClick?: MouseEventHandler<HTMLButtonElement>
  /** One image at its own size (never drawn above 100% of its pixels, `maxHeight` tall at most) instead of a square tile. */
  single?: boolean
  maxHeight?: number
  /** Known pixel size, used to reserve the tile's space while it loads and to size the image. Read from the loaded image when absent. */
  width?: number
  height?: number
  /** "+N" chip for images hidden past the last visible tile; renders in every state. */
  overflow?: number
  className?: string
}

/** Width of the element's content box, kept current while it resizes. */
function useContentWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [contentWidth, setContentWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setContentWidth(element.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return contentWidth
}

/** One image tile (Message image, CONTEXT.md): a bordered button with loading, ready and
 * unavailable states and an optional "+N" overflow chip. Used by `MessageImageGrid` and by the
 * composer's pending-paste thumbnail. */
export function ImageThumbnail({ state, src, label, onClick, single, maxHeight, width, height, overflow = 0, className }: ImageThumbnailProps) {
  const tile = React.useRef<HTMLButtonElement>(null)
  const tileWidth = useContentWidth(tile)
  const devicePixelRatio = useDevicePixelRatio()
  const [loadedSize, setLoadedSize] = React.useState<{ width: number; height: number } | null>(null)

  const frame = cn('relative overflow-hidden rounded-md border border-border bg-muted', single ? 'inline-block max-w-full' : 'aspect-square w-full', className)
  const badge =
    overflow > 0 ? (
      <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="rounded-md border border-border bg-popover/90 px-2 py-1 text-sm font-medium text-popover-foreground forced-colors:border-[CanvasText] forced-colors:bg-[Canvas] forced-colors:text-[CanvasText]">
          +{overflow}
        </span>
      </span>
    ) : null

  if (state === 'unavailable') {
    const placeholder = (
      <>
        <ImageUnavailable className="size-full" />
        {badge}
      </>
    )
    const unavailableFrame = cn(frame, 'min-h-16 min-w-16 p-2')
    if (overflow > 0 && onClick) {
      return (
        <button type="button" aria-label={label} onClick={onClick} className={cn(unavailableFrame, 'block cursor-zoom-in focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring')}>
          {placeholder}
        </button>
      )
    }
    return (
      <div role="img" aria-label={label} className={unavailableFrame}>
        {placeholder}
      </div>
    )
  }

  const ready = state === 'ready'
  const natural = width && height ? { width, height } : loadedSize
  const drawn = natural ? maxDrawnSize(natural.width, natural.height, devicePixelRatio, single ? maxHeight : undefined) : undefined

  let reserve: CSSProperties | undefined
  if (!ready && single) {
    reserve = drawn
      ? { width: drawn.width + FRAME_BORDER_TOTAL_PX, aspectRatio: `${drawn.width + FRAME_BORDER_TOTAL_PX} / ${drawn.height + FRAME_BORDER_TOTAL_PX}` }
      : { width: UNKNOWN_SIZE_PLACEHOLDER_PX, height: UNKNOWN_SIZE_PLACEHOLDER_PX }
  }

  let imageClass: string
  let imageStyle: CSSProperties | undefined
  if (single) {
    imageClass = 'block h-auto max-w-full object-contain'
    imageStyle = drawn ? { width: drawn.width } : maxHeight ? { maxHeight } : undefined
  } else if (tileImageFit(drawn, tileWidth) === 'natural' && drawn) {
    imageClass = 'block object-contain'
    imageStyle = { width: drawn.width, height: drawn.height }
  } else {
    imageClass = 'size-full object-cover'
  }

  return (
    <button
      ref={tile}
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(frame, single ? 'block' : 'flex items-center justify-center', 'min-h-6 min-w-6 cursor-zoom-in focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring', !ready && 'animate-pulse motion-reduce:animate-none')}
      style={reserve}
    >
      {ready && (
        <img
          src={src}
          alt=""
          loading="lazy"
          className={imageClass}
          style={imageStyle}
          onLoad={(event) => {
            const image = event.currentTarget
            if (!width || !height) setLoadedSize({ width: image.naturalWidth, height: image.naturalHeight })
          }}
        />
      )}
      {badge}
    </button>
  )
}
