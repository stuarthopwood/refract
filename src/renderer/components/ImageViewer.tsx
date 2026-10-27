import * as React from 'react'
import { ChevronLeftIcon, ChevronRightIcon, Loader2Icon } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatByteSize, imageTypeLabel } from '@/lib/formatBytes'
import { ImageUnavailable } from './ImageUnavailable'

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

/** Full-size viewer for one or more images (Image viewer, CONTEXT.md). Controlled so a grid tile
 * or a thumbnail can open it at its own index. Left/Right switch image, Esc closes; Radix returns
 * focus to the element that opened it. Only the current image is resolved, so a long list never
 * loads every image. */
export function ImageViewer({ open, onOpenChange, items, index, onIndexChange, title }: ImageViewerProps) {
  const item = items[index]
  const [loaded, setLoaded] = React.useState<Loaded | null>(null)
  const itemKey = item?.key
  const openerRef = React.useRef<HTMLElement | null>(null)
  const openerGroupRef = React.useRef<HTMLElement | null>(null)
  // Radix only restores focus to a `DialogTrigger`; this dialog is opened by a tile's own state, so remember the opener (and its group, for when the opener unmounts) before focus moves into the dialog.
  React.useLayoutEffect(() => {
    if (!open) return
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    openerRef.current = active
    openerGroupRef.current = active?.closest<HTMLElement>('[role=group]') ?? null
  }, [open])

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
  const typeAndSize = current?.state === 'ready' ? [imageTypeLabel(current.data.mimeType), current.data.byteLength !== undefined ? formatByteSize(current.data.byteLength) : ''].filter(Boolean).join(', ') : ''
  const dimensions = current?.state === 'ready' && current.data.width && current.data.height ? `${current.data.width}×${current.data.height}` : ''
  const meta = [typeAndSize, dimensions].filter(Boolean).join(', ')
  const position = total > 1 ? `Image ${index + 1} of ${total}` : 'Image'
  const navButton = (label: string, side: string, delta: number, icon: React.ReactNode) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} className={`absolute top-1/2 ${side} z-10 -translate-y-1/2 bg-popover/80`} onClick={() => go(delta)}>
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[calc(100vw-4rem)] sm:max-w-[calc(100vw-4rem)]"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const opener = openerRef.current
          if (opener?.isConnected) opener.focus()
          else openerGroupRef.current?.focus()
        }}
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
        <span aria-live="polite" className="sr-only">
          {typeAndSize ? `${position}, ${typeAndSize}` : ''}
        </span>
        <div className="relative flex h-[calc(100vh-14rem)] min-h-40 items-center justify-center">
          {total > 1 && navButton('Previous image', 'left-0', -1, <ChevronLeftIcon aria-hidden />)}
          {current === null && (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2Icon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
              Loading image…
            </p>
          )}
          {current?.state === 'ready' && <img src={current.data.src} alt="Attached image, full size" className="max-h-full max-w-full rounded-md object-contain" />}
          {current?.state === 'unavailable' && <ImageUnavailable role="status" />}
          {total > 1 && navButton('Next image', 'right-0', 1, <ChevronRightIcon aria-hidden />)}
        </div>
      </DialogContent>
    </Dialog>
  )
}