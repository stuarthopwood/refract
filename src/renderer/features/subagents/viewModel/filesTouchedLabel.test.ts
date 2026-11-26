import { describe, expect, it } from 'vitest'
import { FILES_TOUCHED_EMPTY_TEXT, FILES_TOUCHED_LABEL, filesTouchedDisplay } from './filesTouchedLabel'

describe('filesTouchedDisplay', () => {
  it('labels the list "Files touched", never "Changed files"', () => {
    expect(FILES_TOUCHED_LABEL).toBe('Files touched')
    expect(filesTouchedDisplay(['a.ts']).label).not.toMatch(/changed/i)
  })

  it('returns the files without an empty-state text when some are known', () => {
    expect(filesTouchedDisplay(['a.ts', 'b.ts'])).toEqual({ label: 'Files touched', files: ['a.ts', 'b.ts'] })
  })

  it.each([undefined, []])('says nothing is known (not "none touched") for %j', (input) => {
    const result = filesTouchedDisplay(input)
    expect(result.files).toEqual([])
    expect(result.emptyText).toBe(FILES_TOUCHED_EMPTY_TEXT)
    expect(FILES_TOUCHED_EMPTY_TEXT).not.toMatch(/\bnone\b|no files (?:were )?touched/i)
  })
})
