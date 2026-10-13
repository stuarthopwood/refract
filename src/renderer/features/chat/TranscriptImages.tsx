// Issue #513: the responsive image row/grid rendered above a `user` bubble's text
// (`Transcript.tsx`'s `case 'user'`). Each `TranscriptImageRef` is resolved on demand through
// `images.get` (main-process only reads OMP's blob store or a Session's own live cache,
// constitution Principle V) -- never for every image in a long history, and never past
// `MAX_VISIBLE_TILES` per message (issue's own "a 40 MB history with many images must not stall
// opening" note): the rest sit behind the "+N" tile, unresolved.
import { useEffect, useState } from 'react'
import { ImageOffIcon } from 'lucide-react'
import { cn } from 'cn'
import type { TranscriptImageRef } from '../../../shared/model'
import { ImagePreviewModal, type ViewerImage } from './ImagePreviewModal'

/** Issue #513 decision comment's own conservative default: 2-across (3 when the pane is wide
 * enough), "+N" on the last visible tile past this many shown. Rules of Hooks: `useResolvedImage`
 * below is called exactly this many times, unconditionally, per render -- never in a loop/map. */
const MAX_VISIBLE_TILES = 4
/** Single-image cap (issue requirement 1): natural proportions up to the bubble width, never
 * upscaled, capped at this height. */
const SINGLE_IMAGE_MAX_HEIGHT_PX = 320

type ResolvedState =
  | { status: 'pending' }
  | { status: 'ready'; src: string; mimeType: string; byteLength: number; width: number; height: number }
  | { status: 'unavailable' }
  | { status: 'absent' }

const PENDING: ResolvedState = { status: 'pending' }
const ABSENT: ResolvedState = { status: 'absent' }

/** Resolves one image on demand (`enabled` gates the `images.get` call so a tile past
 * `MAX_VISIBLE_TILES`, or one this message does not actually have, never fetches at all).
 * `ref`/`enabled` may legitimately be stable-but-inert placeholders (an out-of-range slot) --
 * `enabled: false` short-circuits before ever touching `ref.id`. */
function useResolvedImage(sessionId: string, ref: TranscriptImageRef | undefined, enabled: boolean): ResolvedState {
  const [state, setState] = useState<ResolvedState>(enabled && ref ? PENDING : ABSENT)
  useEffect(() => {
    if (!enabled || !ref) {
      setState(ABSENT)
      return
    }
    setState(PENDING)
    let cancelled = false
    void window.refract.images.get(sessionId, ref.id, ref.mimeType, 'thumbnail').then((result) => {
      if (cancelled) return
      if (!result.ok) {
        setState({ status: 'unavailable' })
        return
      }
      setState({
        status: 'ready',
        src: result.value.dataUrl,
        mimeType: result.value.mimeType,
        byteLength: result.value.byteLength,
        width: result.value.width,
        height: result.value.height
      })
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, ref?.id, ref?.mimeType, enabled])
  return state
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${Math.round(kib)} KB`
  return `${(kib / 1024).toFixed(1)} MB`
}

function formatLabel(mimeType: string): string {
  const slash = mimeType.indexOf('/')
  return (slash === -1 ? mimeType : mimeType.slice(slash + 1)).toUpperCase()
}

interface TileProps {
  state: ResolvedState
  imageRef: TranscriptImageRef | undefined
  index: number
  total: number
  viewerImages: ViewerImage[]
  single: boolean
  overlayCount: number
}

/** One thumbnail. An `unavailable` image is a static placeholder (not a button): there is
 * nothing to open, so it carries a real, accurate visible/accessible label instead of a
 * misleading "Open larger view" (issue accessibility section's "a text alternative exists for a
 * failed image"). A `pending`/`absent` tile is a real but `aria-disabled` button with a generic
 * fallback name (nothing to open YET). A `ready` tile is wrapped in `ImagePreviewModal`. */
function ImageTile({ state, imageRef, index, total, viewerImages, single, overlayCount }: TileProps) {
  const tileClassName = cn('overflow-hidden rounded-md border border-border bg-muted', single ? 'inline-block max-h-80 max-w-full' : 'aspect-square size-full')

  if (state.status === 'unavailable') {
    return (
      <div
        className={cn(tileClassName, 'flex flex-col items-center justify-center gap-1 p-2 text-center text-xs text-muted-foreground')}
        style={!single ? { aspectRatio: '1 / 1' } : undefined}
      >
        <ImageOffIcon aria-hidden className="size-5 shrink-0" />
        <span>Image no longer available</span>
      </div>
    )
  }

  const accessibleName =
    state.status === 'ready'
      ? total > 1
        ? `Image ${index + 1} of ${total} attached to your message, ${formatLabel(state.mimeType)}, ${formatFileSize(state.byteLength)}. Open larger view`
        : `Image attached to your message, ${formatLabel(state.mimeType)}, ${formatFileSize(state.byteLength)}. Open larger view`
      : 'Open larger view'

  const reservedStyle = state.status !== 'ready' && single && imageRef?.width && imageRef.height ? { aspectRatio: `${imageRef.width} / ${imageRef.height}` } : undefined

  const thumbnail = (
    <button
      type="button"
      aria-label={accessibleName}
      aria-disabled={state.status !== 'ready'}
      disabled={state.status !== 'ready'}
      className={cn(tileClassName, 'relative block focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default')}
      style={reservedStyle}
    >
      {state.status === 'ready' && (
        <img src={state.src} alt="" loading="lazy" className={single ? 'max-h-80 max-w-full object-contain' : 'size-full object-cover'} />
      )}
      {overlayCount > 0 && (
        <span aria-hidden className="absolute inset-0 flex items-center justify-center bg-black/50 text-sm font-medium text-white">
          +{overlayCount}
        </span>
      )}
    </button>
  )

  if (state.status !== 'ready') return thumbnail
  return <ImagePreviewModal images={viewerImages} initialIndex={index} titlePrefix="Image" trigger={thumbnail} />
}

export interface TranscriptImagesProps {
  sessionId: string
  images: TranscriptImageRef[]
}

/** Issue #513 requirement 1/2/5/6: renders above a `user` bubble's text, inside the same bubble,
 * only on `user` items. One image: natural size, bubble width, 320px max height, never upscaled.
 * Several: a responsive 2-/3-across grid (Tailwind's native container query, matching this
 * `@container` + `[container-type:size]` pattern already used elsewhere, e.g. `App.tsx`'s empty
 * state) with "+N" on the last visible tile past `MAX_VISIBLE_TILES`. */
export function TranscriptImages({ sessionId, images }: TranscriptImagesProps) {
  const visibleCount = Math.min(images.length, MAX_VISIBLE_TILES)
  // Rules of Hooks: always exactly MAX_VISIBLE_TILES calls, in the same order, every render --
  // an out-of-range slot (index >= visibleCount, or this message has fewer than MAX_VISIBLE_TILES
  // images at all) passes `enabled: false` and stays `'absent'` forever, never fetching.
  const slot0 = useResolvedImage(sessionId, images[0], 0 < visibleCount)
  const slot1 = useResolvedImage(sessionId, images[1], 1 < visibleCount)
  const slot2 = useResolvedImage(sessionId, images[2], 2 < visibleCount)
  const slot3 = useResolvedImage(sessionId, images[3], 3 < visibleCount)
  if (images.length === 0) return null

  const single = images.length === 1
  const hiddenCount = images.length - visibleCount
  const slots = [slot0, slot1, slot2, slot3].slice(0, visibleCount)
  const viewerImages: ViewerImage[] = slots.map((state, i) => ({
    src: state.status === 'ready' ? state.src : '',
    mimeType: state.status === 'ready' ? state.mimeType : images[i]?.mimeType,
    byteLength: state.status === 'ready' ? state.byteLength : images[i]?.byteLength
  }))

  return (
    <div
      className={cn('@container mb-1.5', single ? '' : 'grid grid-cols-2 gap-1 @[28rem]:grid-cols-3')}
      style={single ? { maxHeight: SINGLE_IMAGE_MAX_HEIGHT_PX } : undefined}
    >
      {slots.map((state, i) => (
        <ImageTile
          key={images[i]!.id}
          state={state}
          imageRef={images[i]}
          index={i}
          total={images.length}
          viewerImages={viewerImages}
          single={single}
          overlayCount={i === visibleCount - 1 ? hiddenCount : 0}
        />
      ))}
    </div>
  )
}
