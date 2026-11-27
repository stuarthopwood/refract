// The repo has no DOM, so the tab renders to a string.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
vi.mock('@/state', () => ({}))
import type { ChangedFile } from '../../../shared/github'
import { ChangesTab } from './ChangesTab'

const tooLarge: ChangedFile = { path: 'src/big.ts', additions: 900, deletions: 1, patch: null }
const render = (changedFilesCount: number): string =>
  renderToStaticMarkup(createElement(ChangesTab, { additions: 900, deletions: 1, changedFilesCount, files: [tooLarge], url: 'https://github.com/o/r/pull/1' }))

describe('ChangesTab', () => {
  test('Given fewer files listed than the pull request changed, Then a polite inline-status note offers Open in browser', () => {
    const html = render(5)
    const note = html.match(/<p[^>]*data-slot="inline-status"[^>]*role="status"[^>]*>(?:(?!<\/p>).)*changed files are shown\.(?:(?!<\/p>).)*<\/p>/)?.[0] ?? ''
    expect(note).toContain('Only 1 of 5 changed files are shown.')
    expect(note).toContain('href="https://github.com/o/r/pull/1/files"')
    expect(note).toContain('Open in browser')
  })

  test('Given every changed file listed, Then no truncation note shows', () => {
    expect(render(1)).not.toContain('changed files are shown')
  })
})
