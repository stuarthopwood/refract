import * as React from 'react'
import { loadMessageImage } from '@/lib/messageImageCache'
import { cn } from '@/lib/utils'
import type { MessageImageData, TranscriptImageRef } from '../../shared/ipc-images'
import { ImageThumbnail } from './ImageThumbnail'
import { messageImageTileLabel } from './messageImageTileLabel'
import { ImageViewer, type ViewerItem } from './ImageViewer'

const MAX_VISIBLE_TILES = 4
const SINGLE_IMAGE_MAX_HEIGHT_PX = 320
const NEAR_VIEW_MARGIN = '200px'
const INVALID_ID = 'invalid'
// Whole class strings, because Tailwind only emits classes it can read literally. `gap-2` is on the 8px grid.
const MULTI_GRID_CONTAINER_CLASS = '@container w-[30rem] max-w-full'
const GRID_CLASS = 'grid grid-cols-2 gap-2 @md:grid-cols-4'
// The group takes focus when the viewer closes over an opener that has since unmounted.
const GROUP_FOCUS_CLASS = 'outline-none focus-visible:outline-(length:--focus-ring-width) focus-visible:outline-offset-2 focus-visible:outline-ring'

type TileState = { status: 'loading' } | { status: 'ready'; data: MessageImageData } | { status: 'unavailable' }

/** True once the element has come within ~200 px of the viewport; stays true after that. */
function useNearView(ref: React.RefObject<Element | null>): boolean {
  const [near, setNear] = React.useState(false)
  React.useEffect(() => {
    const element = ref.current
    if (near || !element) return
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return
    }
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && setNear(true), { rootMargin: NEAR_VIEW_MARGIN })
    observer.observe(element)
    return () => observer.disconnect()
  }, [near, ref])
  return near
}

function useMessageImage(id: string, enabled: boolean): TileState {
  const [state, setState] = React.useState<TileState>(id === INVALID_ID ? { status: 'unavailable' } : { status: 'loading' })
  React.useEffect(() => {
    if (id === INVALID_ID) {
      setState({ status: 'unavailable' })
      return
    }
    if (!enabled) return
    let cancelled = false
    setState({ status: 'loading' })
    loadMessageImage(id).then(
      (data) => !cancelled && setState({ status: 'ready', data }),
      () => !cancelled && setState({ status: 'unavailable' })
    )
    return () => {
      cancelled = true
    }
  }, [id, enabled])
  return state
}

interface TileProps {
  image: TranscriptImageRef
  index: number
  total: number
  single: boolean
  overflow: number
  onOpen: (index: number) => void
}

function ImageTile({ image, index, total, single, overflow, onOpen }: TileProps) {
  const cell = React.useRef<HTMLDivElement>(null)
  const near = useNearView(cell)
  const state = useMessageImage(image.id, near)
  const label = messageImageTileLabel({
    status: state.status,
    index,
    total,
    overflow,
    mimeType: state.status === 'ready' ? state.data.mimeType : undefined,
    byteLength: state.status === 'ready' ? state.data.byteLength : undefined
  })

  return (
    <div ref={cell} className={single ? 'max-w-full' : undefined}>
      <ImageThumbnail
        state={state.status}
        src={state.status === 'ready' ? state.data.dataUrl : undefined}
        label={label}
        single={single}
        maxHeight={SINGLE_IMAGE_MAX_HEIGHT_PX}
        width={image.width ?? (state.status === 'ready' ? state.data.width : undefined)}
        height={image.height ?? (state.status === 'ready' ? state.data.height : undefined)}
        overflow={overflow}
        onClick={() => onOpen(overflow > 0 ? MAX_VISIBLE_TILES : index)}
      />
    </div>
  )
}

export interface MessageImageGridProps {
  images: TranscriptImageRef[]
  className?: string
}

/** The images of one user message (Message image, CONTEXT.md): a single image at its natural size
 * (never upscaled, 320 px tall at most), several in a 2-across grid (4 when the bubble is wide)
 * with "+N" past four. Tiles fetch only when scrolled near view. Click opens the Image viewer over
 * all of them, not just the visible tiles; the "+N" tile opens at the first hidden image. */
export function MessageImageGrid({ images, className }: MessageImageGridProps) {
  const [viewerIndex, setViewerIndex] = React.useState<number | null>(null)
  const [lastIndex, setLastIndex] = React.useState(0)
  if (images.length === 0) return null

  const single = images.length === 1
  const visible = images.slice(0, MAX_VISIBLE_TILES)
  const items: ViewerItem[] = images.map((image) => ({ key: image.id, resolve: () => loadMessageImage(image.id).then((d) => ({ ...d, src: d.dataUrl })) }))
  const open = (index: number) => {
    setLastIndex(index)
    setViewerIndex(index)
  }

  return (
    <div role="group" tabIndex={-1} aria-label="Attached images" className={cn(GROUP_FOCUS_CLASS, !single && MULTI_GRID_CONTAINER_CLASS, className)}>
      <div className={single ? undefined : GRID_CLASS}>
        {visible.map((image, index) => (
          <ImageTile key={image.id + index} image={image} index={index} total={images.length} single={single} overflow={index === visible.length - 1 ? images.length - visible.length : 0} onOpen={open} />
        ))}
      </div>
      <ImageViewer
        open={viewerIndex !== null}
        onOpenChange={(next) => !next && setViewerIndex(null)}
        items={items}
        index={viewerIndex ?? lastIndex}
        onIndexChange={open}
        title="Image"
      />
    </div>
  )
}
