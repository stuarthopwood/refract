import * as React from 'react'
import { ImageOffIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { loadMessageImage } from '@/lib/messageImageCache'
import { formatByteSize } from '@/features/chat/attachments'
import type { MessageImageData, TranscriptImageRef } from '../../shared/ipc-images'
import { ImageViewer, type ViewerItem } from './ImageViewer'

const MAX_VISIBLE_TILES = 4
const SINGLE_IMAGE_MAX_HEIGHT_PX = 320
const INVALID_ID = 'invalid'

type TileState = { status: 'loading' } | { status: 'ready'; data: MessageImageData } | { status: 'unavailable' }

function useMessageImage(id: string): TileState {
  const [state, setState] = React.useState<TileState>(id === INVALID_ID ? { status: 'unavailable' } : { status: 'loading' })
  React.useEffect(() => {
    if (id === INVALID_ID) {
      setState({ status: 'unavailable' })
      return
    }
    let cancelled = false
    setState({ status: 'loading' })
    loadMessageImage(id).then(
      (data) => !cancelled && setState({ status: 'ready', data }),
      () => !cancelled && setState({ status: 'unavailable' })
    )
    return () => {
      cancelled = true
    }
  }, [id])
  return state
}

function typeLabel(mimeType: string): string {
  return mimeType.slice(mimeType.indexOf('/') + 1).toUpperCase()
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
  const state = useMessageImage(image.id)
  const frame = cn('overflow-hidden rounded-md border border-border bg-muted', single ? 'inline-block max-w-full' : 'aspect-square w-full')

  if (state.status === 'unavailable') {
    return (
      <div role="img" aria-label="Image no longer available" className={cn(frame, 'flex min-h-16 min-w-16 flex-col items-center justify-center gap-1 p-2 text-center text-xs text-muted-foreground')}>
        <ImageOffIcon aria-hidden className="size-5 shrink-0" />
        <span aria-hidden>Image no longer available</span>
      </div>
    )
  }

  const ready = state.status === 'ready'
  const position = total > 1 ? `Image ${index + 1} of ${total}` : 'Image'
  const label = ready ? `${position}, ${typeLabel(state.data.mimeType)}, ${formatByteSize(state.data.byteLength)}. Open larger view` : `${position}, loading`
  const reserve = !ready && image.width && image.height ? { aspectRatio: `${image.width} / ${image.height}` } : undefined

  return (
    <button
      type="button"
      aria-label={label}
      disabled={!ready}
      onClick={() => onOpen(index)}
      className={cn(frame, 'relative block min-h-6 min-w-6 cursor-zoom-in focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default', !ready && 'animate-pulse motion-reduce:animate-none')}
      style={reserve}
    >
      {ready && <img src={state.data.dataUrl} alt="" loading="lazy" className={single ? 'max-w-full object-contain' : 'size-full object-cover'} style={single ? { maxHeight: SINGLE_IMAGE_MAX_HEIGHT_PX } : undefined} />}
      {overflow > 0 && (
        <span aria-hidden className="absolute inset-0 flex items-center justify-center bg-black/50 text-sm font-medium text-white">
          +{overflow}
        </span>
      )}
    </button>
  )
}

export interface MessageImageGridProps {
  images: TranscriptImageRef[]
  className?: string
}

/** The images of one user message (Message image, CONTEXT.md): a single image at its natural size
 * (never upscaled, 320 px tall at most), several in a 2-across grid (3 when the bubble is wide)
 * with "+N" past four. Click opens the Image viewer over all of them, not just the visible tiles. */
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
    <div role="group" aria-label="Attached images" className={cn('@container', className)}>
      <div className={single ? undefined : 'grid grid-cols-2 gap-1 @md:grid-cols-3'}>
        {visible.map((image, index) => (
          <ImageTile key={image.id + index} image={image} index={index} total={images.length} single={single} overflow={index === visible.length - 1 ? images.length - visible.length : 0} onOpen={open} />
        ))}
      </div>
      <ImageViewer
        open={viewerIndex !== null}
        onOpenChange={(next) => !next && setViewerIndex(null)}
        items={items}
        index={viewerIndex ?? lastIndex}
        onIndexChange={(next) => {
          setLastIndex(next)
          setViewerIndex(next)
        }}
        title="Image"
      />
    </div>
  )
}
