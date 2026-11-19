import { describe, expect, it } from 'vitest'
import { fileName, splitDocumentPath } from './document-path'

describe('document-path', () => {
  it('Given a nested path, Then the name is the last segment and the directory is the rest', () => {
    expect(splitDocumentPath('src/renderer/App.tsx')).toEqual({ name: 'App.tsx', directory: 'src/renderer' })
    expect(fileName('src/renderer/App.tsx')).toBe('App.tsx')
  })

  it('Given a root file, Then there is no directory', () => {
    expect(splitDocumentPath('README.md')).toEqual({ name: 'README.md', directory: '' })
    expect(fileName('README.md')).toBe('README.md')
  })

  it('Given a Windows-looking backslash, Then it is part of the name (paths are POSIX)', () => {
    expect(splitDocumentPath('a\\b.ts')).toEqual({ name: 'a\\b.ts', directory: '' })
  })
})
