import {
  DEFAULT_RIGHT_PANE,
  MAX_DOCUMENT_PATH_BYTES,
  MAX_DOCUMENT_TABS_PER_SESSION,
  normaliseRelativePath,
  type PersistedDiffGroup,
  type PersistedDocumentTab,
  type PersistedSessionDocumentTabs,
  type RightPaneSettings
} from '../../../shared/rightPane'
import {
  documentTabId,
  useDocumentTabsStore,
  type DocumentTabIdentity,
  type RestorableSessionDocuments
} from '../../state/document-tabs-store'
import {
  RIGHT_PANE_MIN_WIDTH_PX,
  RIGHT_PANE_SANITY_MAX_WIDTH_PX,
  useRightPaneStore
} from '../../state/right-pane-store'
import { HOSTED_PANELS, isPinnedPanelId, type PanelId } from './panel-registry'

// Spec 024 FR-005 to FR-007 (#538): the single writer of `Settings.rightPane`, mirroring
// `pull-requests-layout-store.ts`'s debounced persist. `restoreRightPane` seeds the store from
// the saved row without writing back; the subscription then saves only genuine changes.

function isPanelId(id: string): id is PanelId {
  return HOSTED_PANELS.some((panel) => panel.id === id)
}

const DIFF_GROUPS: readonly PersistedDiffGroup[] = ['conflicts', 'staged', 'changes', 'untracked']

let lastSaved = ''
let timer: number | undefined
let started = false

/** The same rules as `parse_tab` in right_pane.rs: a stored path must already be canonical, so a hand-edited `a\b` is dropped, not rewritten. */
function validateTab(raw: unknown): DocumentTabIdentity | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { kind, group, path } = raw as Record<string, unknown>
  if (typeof path !== 'string' || normaliseRelativePath(path) !== path || new TextEncoder().encode(path).length > MAX_DOCUMENT_PATH_BYTES) return null
  if (kind === 'file' && (group === undefined || group === null)) return { kind: 'file', path }
  if (kind === 'diff' && DIFF_GROUPS.includes(group as PersistedDiffGroup)) return { kind: 'diff', group: group as PersistedDiffGroup, path }
  return null
}

function validateSession(raw: unknown): RestorableSessionDocuments | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { tabs: rawTabs, activeId, recency: rawRecency } = raw as Record<string, unknown>
  // A Session over the cap is a corrupt row, not one to trim: drop it whole, as the Rust side does.
  if (!Array.isArray(rawTabs) || rawTabs.length > MAX_DOCUMENT_TABS_PER_SESSION) return null
  const tabs: DocumentTabIdentity[] = []
  const ids = new Set<string>()
  for (const candidate of rawTabs) {
    const tab = validateTab(candidate)
    if (tab && !ids.has(documentTabId(tab))) {
      ids.add(documentTabId(tab))
      tabs.push(tab)
    }
  }
  if (tabs.length === 0) return null
  const recency = Array.isArray(rawRecency) ? [...new Set(rawRecency.filter((id): id is string => typeof id === 'string' && ids.has(id)))] : []
  return { tabs, activeId: typeof activeId === 'string' && ids.has(activeId) ? activeId : null, recency }
}

/** Drops what cannot be a tab; a malformed Session entry is dropped, never the whole row. */
export function validateDocumentTabs(raw: unknown): Record<string, RestorableSessionDocuments> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const restored: Record<string, RestorableSessionDocuments> = {}
  for (const [sessionId, entry] of Object.entries(raw)) {
    const session = sessionId === '' ? null : validateSession(entry)
    if (session) restored[sessionId] = session
  }
  return restored
}

function snapshotDocumentTabs(): Record<string, PersistedSessionDocumentTabs> {
  const saved: Record<string, PersistedSessionDocumentTabs> = {}
  for (const [sessionId, entry] of Object.entries(useDocumentTabsStore.getState().bySession)) {
    if (entry.tabs.length === 0) continue
    const tabs = entry.tabs.map((tab): PersistedDocumentTab => (tab.kind === 'diff' ? { kind: 'diff', group: tab.group, path: tab.path } : { kind: 'file', path: tab.path }))
    saved[sessionId] = { tabs, activeId: entry.activeId, recency: [...entry.recency] }
  }
  return saved
}

export function snapshotRightPane(): RightPaneSettings {
  const { open, widthPx, openPanelIds, activePanelId, panelOrder, chatCollapsed } = useRightPaneStore.getState()
  // Pinned panels are per-window and transient, so they never reach the saved row.
  const savedIds = openPanelIds.filter((id) => !isPinnedPanelId(id))
  const savedActive = activePanelId && !isPinnedPanelId(activePanelId) ? activePanelId : (savedIds.at(-1) ?? null)
  return {
    open,
    widthPx: Math.round(widthPx),
    openPanelIds: savedIds,
    activePanelId: savedActive,
    panelOrder: [...panelOrder],
    documentTabs: snapshotDocumentTabs(),
    chatCollapsed
  }
}

export function restoreRightPane(saved: RightPaneSettings | undefined): void {
  const source = saved ?? DEFAULT_RIGHT_PANE
  const openPanelIds = Array.isArray(source.openPanelIds) ? source.openPanelIds.filter(isPanelId) : []
  const active = source.activePanelId
  useDocumentTabsStore.getState().restore(validateDocumentTabs(source.documentTabs))
  useRightPaneStore.getState().restore({
    open: source.open,
    widthPx: Math.min(RIGHT_PANE_SANITY_MAX_WIDTH_PX, Math.max(RIGHT_PANE_MIN_WIDTH_PX, source.widthPx)),
    openPanelIds,
    activePanelId: active && openPanelIds.includes(active as PanelId) ? (active as PanelId) : (openPanelIds.at(-1) ?? null),
    // Unregistered ids stay (a panel a later build adds); `mergePanelOrder` handles them on read.
    panelOrder: Array.isArray(source.panelOrder) ? source.panelOrder.filter((id) => typeof id === 'string') : [],
    // The store normalises `open: false` with a collapsed chat, so a hand-edited row cannot hide both.
    chatCollapsed: source.chatCollapsed === true
  })
  lastSaved = JSON.stringify(snapshotRightPane())
}

function save(): void {
  timer = undefined
  const next = snapshotRightPane()
  const serialised = JSON.stringify(next)
  if (serialised === lastSaved) return
  lastSaved = serialised
  window.refract.settings.setRightPane(next).then(
    (result) => {
      if (!result.ok) console.error('settings.setRightPane failed', result.error)
    },
    (err: unknown) => console.error('settings.setRightPane threw', err)
  )
}

function scheduleSave(): void {
  clearTimeout(timer)
  timer = window.setTimeout(save, 300)
}

/** Call once after `restoreRightPane`; later calls are no-ops. */
export function startRightPanePersistence(): void {
  if (started) return
  started = true
  window.addEventListener('pagehide', () => {
    if (timer === undefined) return
    clearTimeout(timer)
    save()
  })
  useRightPaneStore.subscribe((state, prev) => {
    if (
      state.open === prev.open &&
      state.widthPx === prev.widthPx &&
      state.openPanelIds === prev.openPanelIds &&
      state.activePanelId === prev.activePanelId &&
      state.panelOrder === prev.panelOrder &&
      state.chatCollapsed === prev.chatCollapsed
    ) {
      return
    }
    scheduleSave()
  })
  // View-state edits (scroll, wrap) replace `bySession` too; `save` drops them because they are not in the snapshot.
  useDocumentTabsStore.subscribe((state, prev) => {
    if (state.bySession !== prev.bySession) scheduleSave()
  })
}
