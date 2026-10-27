import * as React from 'react'
import { ChevronLeftIcon, ChevronRightIcon, ImageOffIcon } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatByteSize } from '@/features/chat/attachments'

export interface ViewerImageData {
  src: string
  mimeType?: string
  byteLength?: number
  width?: number
  height?: number
}

export interface ViewerItem {
  key: string
  /** Set when the bytes are already in hand (a pending paste). */
  data?: ViewerImageData
  /** Loads the bytes on demand (a message image); rejects when the image is gone. */
  resolve?: () => Promise<ViewerImageData>
}

export interface ImageViewerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: ViewerItem[]
  index: number
  onIndexChange: (index: number) => void
  /** Dialog title; the position ("2 of 5") is appended when there are several images. */
  title: string
}

type Loaded = { key: string; state: 'ready'; data: ViewerImageData } | { key: string; state: 'unavailable' }

function typeLabel(mimeType: string | undefined): string {
  if (!mimeType) return ''
  const slash = mimeType.indexOf('/')
  return (slash === -1 ? mimeType : mimeType.slice(slash + 1)).toUpperCase()
}

/** Full-size viewer for one or more images (Image viewer, CONTEXT.md). Controlled so a grid tile
 * or a thumbnail can open it at its own index. Left/Right switch image, Esc closes; Radix returns
 * focus to the element that opened it. Only the current image is resolved, so a long list never
 * loads every image. */
export function ImageViewer({ open, onOpenChange, items, index, onIndexChange, title }: ImageViewerProps) {
  const item = items[index]
  const [loaded, setLoaded] = React.useState<Loaded | null>(null)
  const itemKey = item?.key

  React.useEffect(() => {
    if (!open || !item) return
    if (item.data) {
      setLoaded({ key: item.key, state: 'ready', data: item.data })
      return
    }
    setLoaded(null)
    let cancelled = false
    item.resolve?.().then(
      (data) => !cancelled && setLoaded({ key: item.key, state: 'ready', data }),
      () => !cancelled && setLoaded({ key: item.key, state: 'unavailable' })
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the item's identity
  }, [open, itemKey])

  const total = items.length
  const go = (delta: number) => onIndexChange((index + delta + total) % total)
  const current = loaded && loaded.key === itemKey ? loaded : null
  const meta =
    current?.state === 'ready'
      ? [typeLabel(current.data.mimeType), current.data.byteLength !== undefined ? formatByteSize(current.data.byteLength) : '', current.data.width && current.data.height ? `${current.data.width}×${current.data.height}` : '']
          .filter(Boolean)
          .join(', ')
      : ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl"
        onKeyDown={(event) => {
          if (total < 2) return
          if (event.key === 'ArrowLeft') go(-1)
          else if (event.key === 'ArrowRight') go(1)
        }}
      >
        <DialogHeader>
          <DialogTitle>{total > 1 ? `${title} ${index + 1} of ${total}` : title}</DialogTitle>
          <DialogDescription>{meta || 'Loading image'}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-40 items-center justify-center gap-2">
          {total > 1 && (
            <Button type="button" variant="ghost" size="icon" aria-label="Previous image" onClick={() => go(-1)}>
              <ChevronLeftIcon aria-hidden />
            </Button>
          )}
          <div className="flex min-w-0 flex-1 items-center justify-center">
            {current?.state === 'ready' && <img src={current.data.src} alt="Attached image, full size" className="max-h-[70vh] max-w-full rounded-md object-contain" />}
            {current?.state === 'unavailable' && (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <ImageOffIcon aria-hidden className="size-4" />
                Image no longer available
              </p>
            )}
          </div>
          {total > 1 && (
            <Button type="button" variant="ghost" size="icon" aria-label="Next image" onClick={() => go(1)}>
              <ChevronRightIcon aria-hidden />
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
