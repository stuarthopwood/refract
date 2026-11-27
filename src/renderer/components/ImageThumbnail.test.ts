// The repo has no jsdom: tiles are rendered to a string and the markup is asserted on. Without a
// `window` the device pixel ratio reads as 1; a stub stands in for a scaled display.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageThumbnail, type ImageThumbnailProps } from './ImageThumbnail'

function render(props: Partial<ImageThumbnailProps> = {}) {
  return renderToStaticMarkup(createElement(ImageThumbnail, { state: 'ready', src: 'data:image/png;base64,AA==', label: 'tile', onClick: () => {}, ...props }))
}

afterEach(() => vi.unstubAllGlobals())

describe('ImageThumbnail single image sizing', () => {
  const wide = { single: true, maxHeight: 320, width: 819, height: 200 }

  it('draws a wide image at its pixel size on a 100% display', () => {
    expect(render(wide)).toContain('style="width:819px"')
  })

  it('draws it at half the CSS size on a 200% display, so one image pixel covers one device pixel', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 })
    expect(render(wide)).toContain('style="width:409px"')
  })

  it('reserves the same box while loading, so nothing shifts when the image arrives', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 })
    const html = render({ ...wide, state: 'loading', src: undefined })
    expect(html).toContain('width:411px')
    expect(html).toContain('aspect-ratio:411 / 102')
  })

  it('falls back to the height cap alone when the pixel size is not known yet', () => {
    expect(render({ single: true, maxHeight: 320 })).toContain('style="max-height:320px"')
  })
})

describe('ImageThumbnail grid tiles', () => {
  it('reserves no aspect ratio while loading: a grid tile stays square in every state', () => {
    const html = render({ state: 'loading', src: undefined, width: 819, height: 200 })
    expect(html).toContain('aspect-square')
    expect(html).not.toContain('aspect-ratio')
  })
})

describe('ImageThumbnail unavailable tile', () => {
  it('is not interactive when there is nothing hidden behind it', () => {
    const html = render({ state: 'unavailable', src: undefined, label: 'Image no longer available' })
    expect(html).not.toContain('<button')
    expect(html).toContain('role="img"')
  })

  it('is a button with the "+N" name when it hides more images, so they stay reachable', () => {
    const html = render({ state: 'unavailable', src: undefined, label: '2 more images, open from image 5 of 6', overflow: 2 })
    expect(html).toContain('<button')
    expect(html).toContain('aria-label="2 more images, open from image 5 of 6"')
    expect(html).toMatch(/\+(<!-- -->)?2</)
  })
})
