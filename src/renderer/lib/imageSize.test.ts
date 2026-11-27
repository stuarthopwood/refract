import { describe, expect, it } from 'vitest'
import { maxDrawnSize, tileImageFit, widthWithinHeight } from './imageSize'

describe('maxDrawnSize', () => {
  it('draws at the pixel size at DPR 1, capped by the maximum height with the aspect ratio kept', () => {
    expect(maxDrawnSize(819, 200, 1, 320)).toEqual({ width: 819, height: 200 })
    expect(maxDrawnSize(1600, 800, 1, 320)).toEqual({ width: 640, height: 320 })
  })

  it.each([
    [1.25, { width: 655, height: 160 }],
    [1.5, { width: 546, height: 133 }],
    [2, { width: 409, height: 100 }]
  ])('divides a wide image by the ratio %s and floors, never passing 100%% of its pixels', (ratio, expected) => {
    const drawn = maxDrawnSize(819, 200, ratio, 320)
    expect(drawn).toEqual(expected)
    expect(drawn.width * ratio).toBeLessThanOrEqual(819)
    expect(drawn.height * ratio).toBeLessThanOrEqual(200)
  })

  it('caps a tall image by the maximum height after the ratio, keeping its aspect', () => {
    expect(maxDrawnSize(600, 1800, 1.5, 320)).toEqual({ width: 106, height: 320 })
    expect(maxDrawnSize(600, 1800, 2, 320)).toEqual({ width: 106, height: 320 })
  })

  it('leaves an image already smaller than the caps at its pixel size over the ratio', () => {
    expect(maxDrawnSize(64, 48, 1, 320)).toEqual({ width: 64, height: 48 })
    expect(maxDrawnSize(64, 48, 2, 320)).toEqual({ width: 32, height: 24 })
  })

  it('applies no height cap when none is given', () => {
    expect(maxDrawnSize(1000, 2000, 1)).toEqual({ width: 1000, height: 2000 })
  })

  it('never collapses a side to zero and ignores an unusable ratio', () => {
    expect(maxDrawnSize(1, 1, 4)).toEqual({ width: 1, height: 1 })
    expect(maxDrawnSize(100, 50, 0)).toEqual({ width: 100, height: 50 })
    expect(maxDrawnSize(100, 50, Number.NaN)).toEqual({ width: 100, height: 50 })
  })
})

describe('tileImageFit', () => {
  it('centres an image that fits the tile at its drawn size instead of scaling it up', () => {
    expect(tileImageFit({ width: 120, height: 90 }, 200)).toBe('natural')
  })

  it('fills the tile with an image larger than it', () => {
    expect(tileImageFit({ width: 400, height: 90 }, 200)).toBe('cover')
    expect(tileImageFit({ width: 90, height: 400 }, 200)).toBe('cover')
  })

  it('fills the tile until both the size and the tile are measured', () => {
    expect(tileImageFit(undefined, 200)).toBe('cover')
    expect(tileImageFit({ width: 10, height: 10 }, 0)).toBe('cover')
  })
})

describe('widthWithinHeight', () => {
  it('limits the width by the pixel size and by what the height allowance gives at the aspect ratio', () => {
    expect(widthWithinHeight({ width: 800, height: 400 }, '100dvh - 14rem')).toBe('min(800px, calc((100dvh - 14rem) * 800 / 400))')
  })
})
