import { documentTabDomId, type DocumentTab, type TabKey } from '@/state/document-tabs-store'
import type { PanelId } from './panel-registry'

/** One entry of the tab strip: panel tabs first, then the Session's file and diff tabs. */
export type TabItem = { kind: 'panel'; key: string; id: PanelId } | { kind: 'file' | 'diff'; key: string; tab: DocumentTab }

export function buildTabItems(openPanelIds: readonly PanelId[], documents: readonly DocumentTab[]): TabItem[] {
  return [
    ...openPanelIds.map((id): TabItem => ({ kind: 'panel', key: `panel:${id}`, id })),
    ...documents.map((tab): TabItem => ({ kind: tab.kind, key: tab.id, tab }))
  ]
}

/** The item key a selection refers to; document ids already carry their `file:`/`diff:` prefix. */
export function activeItemKey(key: TabKey | null): string | null {
  if (!key) return null
  return key.kind === 'panel' ? `panel:${key.id}` : key.id
}

/** The DOM ids a tab and its panel share, for `aria-controls` and `aria-labelledby`. */
export function tabDomIds(key: TabKey): { tabId: string; panelId: string } {
  if (key.kind === 'panel') return { tabId: `panel-tab-${key.id}`, panelId: `panel-content-${key.id}` }
  const tabId = documentTabDomId(key.id)
  return { tabId, panelId: `${tabId}-panel` }
}

/** Names the close button from what it closes: "Close index.ts file", "Close Git changes panel" (FR-007). */
export function closeButtonLabel(item: TabItem, name: string): string {
  return `Close ${name} ${item.kind}`
}

export type TabKeyAction = { kind: 'select'; item: TabItem } | { kind: 'close' }

/** Roving-focus keys for a tab: Arrows wrap, Home and End jump, Delete closes. Any other key is the browser's. */
export function tabKeyAction(items: readonly TabItem[], index: number, key: string): TabKeyAction | null {
  if (items.length === 0) return null
  if (key === 'Delete') return { kind: 'close' }
  const target = key === 'ArrowRight' ? items[(index + 1) % items.length] : key === 'ArrowLeft' ? items[(index - 1 + items.length) % items.length] : key === 'Home' ? items[0] : key === 'End' ? items[items.length - 1] : undefined
  return target ? { kind: 'select', item: target } : null
}

/** Which "All tabs" footer actions have something to close; each is off without a Session. */
export function bulkCloseEnabled(items: readonly TabItem[], activeKey: string | null, hasSession: boolean): { others: boolean; all: boolean; stale: boolean } {
  const documents = items.filter((item): item is Exclude<TabItem, { kind: 'panel' }> => item.kind !== 'panel')
  return {
    others: hasSession && documents.length >= 2 && documents.some((item) => item.key === activeKey),
    all: hasSession && documents.length > 0,
    stale: hasSession && documents.some((item) => item.tab.dead)
  }
}
