import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusExplorerRow } from './row-focus-return'

function stubDocument(row: unknown) {
  const querySelector = vi.fn(() => row)
  vi.stubGlobal('document', { querySelector })
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/"/g, '\\"') })
  return querySelector
}

afterEach(() => vi.unstubAllGlobals())

describe('focusExplorerRow', () => {
  it('looks the row up by its escaped path', () => {
    const querySelector = stubDocument(null)
    focusExplorerRow('src/"odd".ts')
    expect(querySelector).toHaveBeenCalledWith('[data-tree-row-path="src/\\"odd\\".ts"]')
  })

  it('reports false while the row has not mounted, so the poll keeps trying', () => {
    stubDocument(null)
    expect(focusExplorerRow('a.ts')).toBe(false)
  })

  it('reports true only once focus actually landed on the row', () => {
    const row = { ownerDocument: { activeElement: null as unknown }, focus: vi.fn() }
    stubDocument(row)
    expect(focusExplorerRow('a.ts')).toBe(false)
    row.focus.mockImplementation(() => {
      row.ownerDocument.activeElement = row
    })
    expect(focusExplorerRow('a.ts')).toBe(true)
  })
})
