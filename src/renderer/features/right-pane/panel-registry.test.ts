import { describe, expect, it, vi } from 'vitest'
import { FileDiffIcon, FileIcon } from 'lucide-react'
import type { DocumentTab } from '@/state/document-tabs-store'
import { documentTabIcon, getPanelDescriptor, tabItemIcon, tabItemName } from './panel-registry'
import { buildTabItems } from './tab-items'

// The registry pulls the whole store barrel, which needs a browser `window`; the name and icon lookups need none of it.
vi.mock('@/state', () => ({ EMPTY_READOUT_ENTRY: {}, useGitChangesStore: () => undefined, useReadoutStore: () => undefined }))

const file: DocumentTab = { kind: 'file', path: 'src/a.ts', id: 'file:src/a.ts', dead: false }
const diff: DocumentTab = { kind: 'diff', group: 'staged', path: 'src/a.ts', id: 'diff:staged:src/a.ts', dead: false }
const [panel, fileItem, diffItem] = buildTabItems(['outline'], [file, diff])

describe('tabItemName', () => {
  it('names a panel from its descriptor', () => {
    expect(tabItemName(panel!, {})).toBe('Outline')
  })

  it('names a document from its label, falling back to its path', () => {
    expect(tabItemName(fileItem!, { [file.id]: 'a.ts' })).toBe('a.ts')
    expect(tabItemName(diffItem!, {})).toBe('src/a.ts')
  })
})

describe('tabItemIcon', () => {
  it('picks the panel icon, the file icon or the diff icon by kind', () => {
    expect(tabItemIcon(panel!)).toBe(getPanelDescriptor('outline')?.icon)
    expect(tabItemIcon(fileItem!)).toBe(FileIcon)
    expect(tabItemIcon(diffItem!)).toBe(FileDiffIcon)
    expect(documentTabIcon('diff')).toBe(FileDiffIcon)
  })
})
