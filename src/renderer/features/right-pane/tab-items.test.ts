import { describe, expect, it } from 'vitest'
import type { DocumentTab } from '@/state/document-tabs-store'
import { activeItemKey, buildTabItems, bulkCloseEnabled, closeButtonLabel, tabDomIds, tabKeyAction } from './tab-items'

const file: DocumentTab = { kind: 'file', path: 'src/a.ts', id: 'file:src/a.ts', dead: false }
const diff: DocumentTab = { kind: 'diff', group: 'staged', path: 'src/a.ts', id: 'diff:staged:src/a.ts', dead: false }

describe('buildTabItems', () => {
  it('lists panel tabs first, then document tabs in order', () => {
    const items = buildTabItems(['outline', 'git-changes'], [file, diff])
    expect(items.map((item) => item.key)).toEqual(['panel:outline', 'panel:git-changes', 'file:src/a.ts', 'diff:staged:src/a.ts'])
    expect(items.map((item) => item.kind)).toEqual(['panel', 'panel', 'file', 'diff'])
  })
})

describe('activeItemKey', () => {
  it('maps a panel and a document selection to their item keys, and null to null', () => {
    expect(activeItemKey({ kind: 'panel', id: 'outline' })).toBe('panel:outline')
    expect(activeItemKey({ kind: 'document', sessionId: 's1', id: file.id })).toBe(file.id)
    expect(activeItemKey(null)).toBeNull()
  })
})

describe('tabDomIds', () => {
  it('gives a document tab a DOM-safe id with a distinct panel id', () => {
    const { tabId, panelId } = tabDomIds({ kind: 'document', sessionId: 's1', id: 'file:src/my file.ts' })
    expect(tabId).toMatch(/^doc-tab-[a-z0-9]+$/)
    expect(panelId).toBe(`${tabId}-panel`)
  })

  it('keeps the existing panel ids', () => {
    expect(tabDomIds({ kind: 'panel', id: 'outline' })).toEqual({ tabId: 'panel-tab-outline', panelId: 'panel-content-outline' })
  })
})

describe('closeButtonLabel', () => {
  it('names the close button from the item kind', () => {
    const [panel, doc, changed] = buildTabItems(['outline'], [file, diff])
    expect(closeButtonLabel(panel!, 'Outline')).toBe('Close Outline panel')
    expect(closeButtonLabel(doc!, 'a.ts')).toBe('Close a.ts file')
    expect(closeButtonLabel(changed!, 'a.ts')).toBe('Close a.ts diff')
  })
})

describe('tabKeyAction', () => {
  const items = buildTabItems(['outline'], [file, diff])
  const select = (index: number, key: string) => {
    const action = tabKeyAction(items, index, key)
    return action?.kind === 'select' ? action.item.key : action
  }

  it('moves with Arrow keys and wraps at both ends', () => {
    expect(select(0, 'ArrowRight')).toBe(file.id)
    expect(select(2, 'ArrowRight')).toBe('panel:outline')
    expect(select(0, 'ArrowLeft')).toBe(diff.id)
  })

  it('jumps to the first and last tab with Home and End', () => {
    expect(select(1, 'Home')).toBe('panel:outline')
    expect(select(0, 'End')).toBe(diff.id)
  })

  it('closes with Delete and ignores other keys', () => {
    expect(tabKeyAction(items, 1, 'Delete')).toEqual({ kind: 'close' })
    expect(tabKeyAction(items, 1, 'a')).toBeNull()
    expect(tabKeyAction([], 0, 'ArrowRight')).toBeNull()
  })
})

describe('bulkCloseEnabled', () => {
  const dead: DocumentTab = { ...diff, dead: true }

  it('turns everything off without a Session', () => {
    expect(bulkCloseEnabled(buildTabItems(['outline'], [file, dead]), file.id, false)).toEqual({ others: false, all: false, stale: false })
  })

  it('offers Close others only for an active document with another document open', () => {
    expect(bulkCloseEnabled(buildTabItems([], [file]), file.id, true).others).toBe(false)
    expect(bulkCloseEnabled(buildTabItems(['outline'], [file, diff]), 'panel:outline', true).others).toBe(false)
    expect(bulkCloseEnabled(buildTabItems(['outline'], [file, diff]), file.id, true).others).toBe(true)
  })

  it('offers Close all with any document and the stale close only with a dead one', () => {
    expect(bulkCloseEnabled(buildTabItems(['outline'], []), 'panel:outline', true)).toEqual({ others: false, all: false, stale: false })
    expect(bulkCloseEnabled(buildTabItems(['outline'], [file]), file.id, true)).toEqual({ others: false, all: true, stale: false })
    expect(bulkCloseEnabled(buildTabItems(['outline'], [file, dead]), file.id, true).stale).toBe(true)
  })
})
