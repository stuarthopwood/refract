export interface DrawnSize {
  width: number
  height: number
}

/** The largest CSS-pixel box an image may be drawn at without the browser upscaling it: one device
 * pixel per image pixel, so `natural / devicePixelRatio` per side (floored, so the box can never
 * pass 100% of the image's pixels). `maxHeight` (CSS px) further caps it while keeping the aspect
 * ratio. Every side is at least 1 so a tiny image never collapses to nothing. */
export function maxDrawnSize(naturalWidth: number, naturalHeight: number, devicePixelRatio: number, maxHeight?: number): DrawnSize {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  let width = Math.max(1, Math.floor(naturalWidth / ratio))
  let height = Math.max(1, Math.floor(naturalHeight / ratio))
  if (maxHeight !== undefined && maxHeight > 0 && height > maxHeight) {
    width = Math.max(1, Math.floor((width * maxHeight) / height))
    height = Math.floor(maxHeight)
  }
  return { width, height }
}

/** How a grid tile shows its image: an image whose drawn size fits inside the (square) tile sits
 * centred at that size, since scaling it up would blur it; a larger one fills the tile (a downscale
 * is sharp, and cropping is the long-standing behaviour). */
export function tileImageFit(drawn: DrawnSize | undefined, tileSize: number): 'natural' | 'cover' {
  if (!drawn || tileSize <= 0) return 'cover'
  return drawn.width <= tileSize && drawn.height <= tileSize ? 'natural' : 'cover'
}

/** CSS `width` for an image that must also stay within a viewport-relative height. `maxHeightCss`
 * is a CSS length (for example `calc(100dvh - 14rem)`). With the intrinsic aspect ratio and
 * `height: auto`, the browser derives the height from this width, so both limits hold without
 * letterboxing. */
export function widthWithinHeight(drawn: DrawnSize, maxHeightCss: string): string {
  return `min(${drawn.width}px, calc((${maxHeightCss}) * ${drawn.width} / ${drawn.height}))`
}
