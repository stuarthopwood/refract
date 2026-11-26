// The repo has no jsdom: components are rendered to a string and the markup is asserted on.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FILE_CHIP_LIMIT, FileChip, FileChipList, fileBasename, splitFileChips } from './FileChip'

describe('fileBasename (#1928)', () => {
  it('takes the last segment of a POSIX path', () => {
    expect(fileBasename('src/handlers/activation.handler.ts')).toBe('activation.handler.ts')
  })

  it('takes the last segment of a Windows path, and of a mixed-separator one', () => {
    expect(fileBasename('C:\\repo\\src\\PatientActivationModal.tsx')).toBe('PatientActivationModal.tsx')
    expect(fileBasename('C:\\repo/src\\a.ts')).toBe('a.ts')
  })

  it('returns a bare name unchanged and ignores a trailing separator', () => {
    expect(fileBasename('README.md')).toBe('README.md')
    expect(fileBasename('src/dir/')).toBe('dir')
  })
})

describe('FileChip (#1928)', () => {
  it('shows the basename in monospace with the full path in the title, composing the outline Badge', () => {
    const html = renderToStaticMarkup(createElement(FileChip, { path: 'C:\\repo\\src\\a.ts' }))
    expect(html).toContain('title="C:\\repo\\src\\a.ts"')
    expect(html).toContain('>a.ts<')
    expect(html).toContain('font-mono')
    expect(html).toContain('data-variant="outline"')
  })

  it('truncates a long basename instead of overflowing the row', () => {
    const html = renderToStaticMarkup(createElement(FileChip, { path: `src/${'x'.repeat(200)}.ts` }))
    expect(html).toMatch(/class="[^"]*truncate[^"]*"/)
    expect(html).toContain('max-w-full')
  })
})

describe('splitFileChips (#1928)', () => {
  const files = (n: number) => Array.from({ length: n }, (_, i) => `src/f${i}.ts`)

  it('shows everything when there are at most four files', () => {
    expect(splitFileChips(files(4))).toEqual({ shown: files(4), hidden: [] })
    expect(FILE_CHIP_LIMIT).toBe(4)
  })

  it('shows the first four and leaves the rest hidden', () => {
    expect(splitFileChips(files(7))).toEqual({ shown: files(4), hidden: files(7).slice(4) })
  })

  it('collapses duplicate paths so a repeated edit is one chip and does not inflate the "+N"', () => {
    expect(splitFileChips(['a.ts', 'a.ts', 'b.ts'])).toEqual({ shown: ['a.ts', 'b.ts'], hidden: [] })
  })

  it('handles no files', () => {
    expect(splitFileChips([])).toEqual({ shown: [], hidden: [] })
  })
})

describe('FileChipList (#1928)', () => {
  const render = (files: string[] | undefined) => renderToStaticMarkup(createElement(FileChipList, { files, label: 'Files touched' }))

  it('renders nothing for no files, leaving no empty row', () => {
    expect(render(undefined)).toBe('')
    expect(render([])).toBe('')
  })

  it('is a group labelled "Files touched" with no "+N" button at four files', () => {
    const html = render(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
    expect(html).toContain('role="group"')
    expect(html).toContain('aria-label="Files touched"')
    expect(html).not.toContain('<button')
  })

  it('shows four chips and a collapsed "+N" button with aria-expanded for the overflow', () => {
    const html = render(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'])
    expect(html.match(/data-slot="badge"/g)).toHaveLength(4)
    expect(html).not.toContain('>e.ts<')
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>\+2<span class="sr-only"> more files<\/span><\/button>/)
  })
})
