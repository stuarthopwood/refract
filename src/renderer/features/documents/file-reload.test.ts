import { describe, expect, it } from 'vitest'
import { gitEntry } from '../right-pane/git-changes/git-changes-test-fixtures'
import { gitSnapshot as snapshot } from './documents-test-fixtures'
import { fileChangeSignature } from './file-reload'

describe('fileChangeSignature', () => {
  it('reads the same for an untouched file with or without a snapshot, and differs once the file is changed', () => {
    const untouched = fileChangeSignature(null, 'a.ts')
    expect(fileChangeSignature(snapshot({ changes: [gitEntry('b.ts')] }), 'a.ts')).toBe(untouched)
    expect(fileChangeSignature(snapshot({ changes: [gitEntry('a.ts')] }), 'a.ts')).not.toBe(untouched)
  })

  it('changes when the file is edited, staged or stops being changed', () => {
    const edited = fileChangeSignature(snapshot({ changes: [gitEntry('a.ts')] }), 'a.ts')
    expect(fileChangeSignature(snapshot({ changes: [gitEntry('a.ts', { additions: 9 })] }), 'a.ts')).not.toBe(edited)
    expect(fileChangeSignature(snapshot({ staged: [gitEntry('a.ts')] }), 'a.ts')).not.toBe(edited)
    expect(fileChangeSignature(snapshot({}), 'a.ts')).not.toBe(edited)
  })

  it('is stable while the snapshot says nothing new about the file', () => {
    const entry = gitEntry('a.ts')
    expect(fileChangeSignature(snapshot({ changes: [entry] }), 'a.ts')).toBe(fileChangeSignature(snapshot({ changes: [{ ...entry }, gitEntry('b.ts')] }), 'a.ts'))
  })
})
