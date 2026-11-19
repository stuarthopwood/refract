import { describe, expect, it } from 'vitest'
import { rowOpenOptions } from '../file-explorer/row-open'
import { clickActivation, diffOpenAnnouncement } from './diff-row-open'

const click = (over: Partial<{ detail: number; ctrlKey: boolean; metaKey: boolean }> = {}) => clickActivation({ detail: 1, ctrlKey: false, metaKey: false, ...over })

describe('clickActivation', () => {
  it('treats a pointer click as a foreground open that leaves focus alone', () => {
    expect(rowOpenOptions(click())).toEqual({ background: false, focus: false })
  })

  it('opens Ctrl+click in the background', () => {
    expect(rowOpenOptions(click({ ctrlKey: true })).background).toBe(true)
  })

  it('treats a click with no pointer detail, which Enter and Space produce, as keyboard activation', () => {
    expect(rowOpenOptions(click({ detail: 0 }))).toEqual({ background: false, focus: true })
  })

  it('opens Ctrl+Enter in the background', () => {
    expect(rowOpenOptions(click({ detail: 0, ctrlKey: true })).background).toBe(true)
  })
})

describe('diffOpenAnnouncement', () => {
  it('names the file when a diff opens in the background, and says nothing for a foreground open', () => {
    expect(diffOpenAnnouncement('src/a.ts', true)).toBe('Opened diff of a.ts in the background')
    expect(diffOpenAnnouncement('src/a.ts', false)).toBeUndefined()
  })
})
