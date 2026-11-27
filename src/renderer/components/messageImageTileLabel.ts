import { formatByteSize, imageTypeLabel } from '@/lib/formatBytes'

export interface MessageImageTileLabelInput {
  status: 'loading' | 'ready' | 'unavailable'
  /** Zero-based position of the tile among all of the message's images. */
  index: number
  total: number
  /** Images hidden behind this tile's "+N" chip; 0 for an ordinary tile. */
  overflow: number
  mimeType?: string
  byteLength?: number
}

/** Accessible name of one tile. The "+N" tile opens the first hidden image, so it is named for
 * that action rather than for the visible image under its chip. */
export function messageImageTileLabel({ status, index, total, overflow, mimeType, byteLength }: MessageImageTileLabelInput): string {
  if (overflow > 0) return `${overflow} more ${overflow === 1 ? 'image' : 'images'}, open from image ${index + 2} of ${total}`
  if (status === 'unavailable') return 'Image no longer available'
  const position = total > 1 ? `Image ${index + 1} of ${total} attached to your message` : 'Image attached to your message'
  if (status === 'ready' && mimeType !== undefined && byteLength !== undefined) return `${position}, ${imageTypeLabel(mimeType)}, ${formatByteSize(byteLength)}. Open larger view`
  return `${position}, loading. Open larger view`
}
