import { describe, expect, it } from 'vitest'
import { messageImageTileLabel } from './messageImageTileLabel'

describe('messageImageTileLabel', () => {
  it('names the "+N" tile for what it opens: the first hidden image', () => {
    expect(messageImageTileLabel({ status: 'ready', index: 3, total: 6, overflow: 2, mimeType: 'image/png', byteLength: 2048 })).toBe('2 more images, open from image 5 of 6')
  })

  it('names a "+1" tile in the singular', () => {
    expect(messageImageTileLabel({ status: 'loading', index: 3, total: 5, overflow: 1 })).toBe('1 more image, open from image 5 of 5')
  })

  it('keeps the "+N" name when the image under the chip is gone, so the tile stays reachable', () => {
    expect(messageImageTileLabel({ status: 'unavailable', index: 3, total: 6, overflow: 2 })).toBe('2 more images, open from image 5 of 6')
  })

  it('describes a ready tile with its position, type and size', () => {
    expect(messageImageTileLabel({ status: 'ready', index: 1, total: 3, overflow: 0, mimeType: 'image/webp', byteLength: 1536 })).toBe(
      'Image 2 of 3 attached to your message, WEBP, 1.5 KB. Open larger view'
    )
  })

  it('omits the position for a single image and says it is loading before the bytes arrive', () => {
    expect(messageImageTileLabel({ status: 'loading', index: 0, total: 1, overflow: 0 })).toBe('Image attached to your message, loading. Open larger view')
  })

  it('names a plain unavailable tile as gone', () => {
    expect(messageImageTileLabel({ status: 'unavailable', index: 0, total: 2, overflow: 0 })).toBe('Image no longer available')
  })
})
