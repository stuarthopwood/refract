import { create } from 'zustand'
import type { GitChangesGroupKind } from '../../shared/model'
import { MAX_DOCUMENT_TABS_PER_SESSION } from '../../shared/rightPane'
import type { PanelId } from '../features/right-pane/panel-registry'

// Issue #2075: the right pane's file and diff tabs, kept per Session so a Session switch swaps the set.

export type DocumentTabIdentity = { kind: 'file'; path: string } | { kind: 'diff'; group: GitChangesGroupKind; path: string }

/** `id` is the identity string, so two identities can never share a key; `dead` is not persisted. */
export type DocumentTab = DocumentTabIdentity & { id: string; dead: boolean }

export type TabKey = { kind: 'panel'; id: PanelId } | { kind: 'document'; sessionId: string; id: string }

/** Per-tab view state; unset means the view's own default. Not persisted. */
export interface DocumentViewState {
  wrap?: boolean
  source?: boolean
  scrollTop?: number
}

export interface SessionDocuments {
  tabs: DocumentTab[]
  /** The Session's selected document tab; null while a panel tab is selected. */
  activeId: string | null
  /** Tab ids, least recently active first. */
  recency: string[]
  /** What was selected when the tab opened, so closing it returns there. */
  openedFrom: Record<string, TabKey>
  view: Record<string, DocumentViewState>
}

export interface OpenResult {
  id: string
  /** The tab closed to stay under the cap, for the caller to announce. */
  evicted: DocumentTab | null
}

export interface CloseResult {
  closed: DocumentTab[]
  activeChanged: boolean
  /** Where the selection goes when `activeChanged`; null means no document tab is left to select. */
  next: TabKey | null
}

export interface RestorableSessionDocuments {
  tabs: DocumentTabIdentity[]
  activeId: string | null
  recency: string[]
}

export const EMPTY_SESSION_DOCUMENTS: SessionDocuments = { tabs: [], activeId: null, recency: [], openedFrom: {}, view: {} }

export function documentTabId(identity: DocumentTabIdentity): string {
  return identity.kind === 'file' ? `file:${identity.path}` : `diff:${identity.group}:${identity.path}`
}

/** A tab id can hold spaces and slashes, which `aria-controls` cannot; this is the DOM-safe form. */
export function documentTabDomId(id: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193)
  return `doc-tab-${(hash >>> 0).toString(36)}`
}

/** Dead tab first, then the least recently active; never the protected (active) tab. */
export function pickEviction(tabs: readonly DocumentTab[], recency: readonly string[], protectedId: string | null): string | null {
  const candidates = tabs.filter((tab) => tab.id !== protectedId)
  const leastRecent = (list: DocumentTab[]) => list.reduce<DocumentTab | null>((best, tab) => (best === null || recency.indexOf(tab.id) < recency.indexOf(best.id) ? tab : best), null)
  return (leastRecent(candidates.filter((tab) => tab.dead)) ?? leastRecent(candidates))?.id ?? null
}

/** Where the selection goes when the active tab closes: its opener if still there, else the nearest surviving neighbour. */
export function nextAfterClose(
  tabs: readonly DocumentTab[],
  closing: ReadonlySet<string>,
  activeId: string,
  openedFrom: Record<string, TabKey>,
  sessionId: string
): TabKey | null {
  const opener = openedFrom[activeId]
  if (opener && (opener.kind === 'panel' || (!closing.has(opener.id) && tabs.some((tab) => tab.id === opener.id)))) return opener
  const index = tabs.findIndex((tab) => tab.id === activeId)
  const survivors = tabs.map((tab, i) => ({ tab, i })).filter(({ tab }) => !closing.has(tab.id))
  const neighbour = survivors.find(({ i }) => i > index) ?? survivors.findLast(({ i }) => i < index)
  return neighbour ? { kind: 'document', sessionId, id: neighbour.tab.id } : null
}

const touch = (recency: readonly string[], id: string): string[] => [...recency.filter((entry) => entry !== id), id]

function removeTabs(entry: SessionDocuments, ids: ReadonlySet<string>): SessionDocuments {
  const dropsId = ([id, from]: [string, TabKey]) => ids.has(id) || (from.kind === 'document' && ids.has(from.id))
  return {
    tabs: entry.tabs.filter((tab) => !ids.has(tab.id)),
    activeId: entry.activeId !== null && ids.has(entry.activeId) ? null : entry.activeId,
    recency: entry.recency.filter((id) => !ids.has(id)),
    openedFrom: Object.fromEntries(Object.entries(entry.openedFrom).filter((pair) => !dropsId(pair))),
    view: Object.fromEntries(Object.entries(entry.view).filter(([id]) => !ids.has(id)))
  }
}

function closeFrom(entry: SessionDocuments, sessionId: string, closing: ReadonlySet<string>, keepId?: string): { entry: SessionDocuments; result: CloseResult } {
  const closed = entry.tabs.filter((tab) => closing.has(tab.id))
  const activeClosing = entry.activeId !== null && closing.has(entry.activeId)
  const keep: TabKey | null = keepId ? { kind: 'document', sessionId, id: keepId } : null
  const next = keep ?? (activeClosing && entry.activeId ? nextAfterClose(entry.tabs, closing, entry.activeId, entry.openedFrom, sessionId) : null)
  const activeChanged = keepId ? keepId !== entry.activeId : activeClosing
  const base = removeTabs(entry, closing)
  const activeId = next?.kind === 'document' && activeChanged ? next.id : base.activeId
  return { entry: { ...base, activeId }, result: { closed, activeChanged, next: activeChanged ? next : null } }
}

function renameTab(entry: SessionDocuments, from: string, to: DocumentTab): SessionDocuments {
  const rename = (id: string) => (id === from ? to.id : id)
  const remap = (key: TabKey): TabKey => (key.kind === 'document' && key.id === from ? { ...key, id: to.id } : key)
  return {
    tabs: entry.tabs.map((tab) => (tab.id === from ? to : tab)),
    activeId: entry.activeId === null ? null : rename(entry.activeId),
    recency: entry.recency.map(rename),
    openedFrom: Object.fromEntries(Object.entries(entry.openedFrom).map(([id, key]) => [rename(id), remap(key)])),
    view: Object.fromEntries(Object.entries(entry.view).map(([id, state]) => [rename(id), state]))
  }
}

interface DocumentTabsState {
  bySession: Record<string, SessionDocuments>
  /** Opens or finds a tab; `activate: false` is a background open. Over the cap it evicts (see `pickEviction`). */
  openDocumentTab(sessionId: string, identity: DocumentTabIdentity, options: { activate: boolean; openedFrom?: TabKey }): OpenResult
  closeDocumentTab(sessionId: string, id: string): CloseResult
  closeOthers(sessionId: string, keepId: string): CloseResult
  closeAllDocuments(sessionId: string): CloseResult
  closeDead(sessionId: string): CloseResult
  /** Staging or unstaging moved the file to another group: the tab follows, or merges into the tab already there. */
  retargetDiff(sessionId: string, id: string, group: GitChangesGroupKind): { id: string; merged: boolean } | null
  markDead(sessionId: string, id: string, dead: boolean): void
  /** Selects a document tab (recording its recency) or, with null, hands the selection back to the panel tabs. */
  setActiveDocument(sessionId: string, id: string | null): void
  setViewState(sessionId: string, id: string, patch: DocumentViewState): void
  /** Input must already be validated (`right-pane-persistence.ts`). */
  restore(saved: Record<string, RestorableSessionDocuments>): void
  dropSession(sessionId: string): void
  pruneSessions(keepIds: ReadonlySet<string>): void
}

export const useDocumentTabsStore = create<DocumentTabsState>((set, get) => {
  const entryOf = (sessionId: string) => get().bySession[sessionId] ?? EMPTY_SESSION_DOCUMENTS
  const write = (sessionId: string, entry: SessionDocuments) => set((state) => ({ bySession: { ...state.bySession, [sessionId]: entry } }))
  const close = (sessionId: string, closing: ReadonlySet<string>, keepId?: string): CloseResult => {
    const { entry, result } = closeFrom(entryOf(sessionId), sessionId, closing, keepId)
    if (result.closed.length > 0) write(sessionId, entry)
    return result
  }

  return {
    bySession: {},

    openDocumentTab: (sessionId, identity, { activate, openedFrom }) => {
      const id = documentTabId(identity)
      const entry = entryOf(sessionId)
      if (entry.tabs.some((tab) => tab.id === id)) {
        write(sessionId, { ...entry, recency: touch(entry.recency, id), activeId: activate ? id : entry.activeId })
        return { id, evicted: null }
      }
      const evictId = entry.tabs.length >= MAX_DOCUMENT_TABS_PER_SESSION ? pickEviction(entry.tabs, entry.recency, entry.activeId) : null
      const evicted = entry.tabs.find((tab) => tab.id === evictId) ?? null
      const base = evictId ? removeTabs(entry, new Set([evictId])) : entry
      write(sessionId, {
        ...base,
        tabs: [...base.tabs, { ...identity, id, dead: false }],
        recency: touch(base.recency, id),
        activeId: activate ? id : base.activeId,
        openedFrom: activate && openedFrom ? { ...base.openedFrom, [id]: openedFrom } : base.openedFrom
      })
      return { id, evicted }
    },

    closeDocumentTab: (sessionId, id) => close(sessionId, new Set([id])),

    closeOthers: (sessionId, keepId) => {
      const tabs = entryOf(sessionId).tabs
      if (!tabs.some((tab) => tab.id === keepId)) return { closed: [], activeChanged: false, next: null }
      return close(sessionId, new Set(tabs.filter((tab) => tab.id !== keepId).map((tab) => tab.id)), keepId)
    },

    closeAllDocuments: (sessionId) => close(sessionId, new Set(entryOf(sessionId).tabs.map((tab) => tab.id))),

    closeDead: (sessionId) =>
      close(
        sessionId,
        new Set(
          entryOf(sessionId)
            .tabs.filter((tab) => tab.dead)
            .map((tab) => tab.id)
        )
      ),

    retargetDiff: (sessionId, id, group) => {
      const entry = entryOf(sessionId)
      const tab = entry.tabs.find((candidate) => candidate.id === id)
      if (!tab || tab.kind !== 'diff' || tab.group === group) return null
      const moved: DocumentTab = { kind: 'diff', group, path: tab.path, id: documentTabId({ kind: 'diff', group, path: tab.path }), dead: false }
      if (entry.tabs.some((candidate) => candidate.id === moved.id)) {
        const base = removeTabs(entry, new Set([id]))
        const wasActive = entry.activeId === id
        write(sessionId, { ...base, activeId: wasActive ? moved.id : base.activeId, recency: wasActive ? touch(base.recency, moved.id) : base.recency })
        return { id: moved.id, merged: true }
      }
      write(sessionId, renameTab(entry, id, moved))
      return { id: moved.id, merged: false }
    },

    markDead: (sessionId, id, dead) => {
      const entry = entryOf(sessionId)
      if (!entry.tabs.some((tab) => tab.id === id && tab.dead !== dead)) return
      write(sessionId, { ...entry, tabs: entry.tabs.map((tab) => (tab.id === id ? { ...tab, dead } : tab)) })
    },

    setActiveDocument: (sessionId, id) => {
      const entry = entryOf(sessionId)
      if (id === null) {
        if (entry.activeId !== null) write(sessionId, { ...entry, activeId: null })
        return
      }
      if (!entry.tabs.some((tab) => tab.id === id)) return
      write(sessionId, { ...entry, activeId: id, recency: touch(entry.recency, id) })
    },

    setViewState: (sessionId, id, patch) => {
      const entry = entryOf(sessionId)
      if (!entry.tabs.some((tab) => tab.id === id)) return
      write(sessionId, { ...entry, view: { ...entry.view, [id]: { ...entry.view[id], ...patch } } })
    },

    restore: (saved) =>
      set({
        bySession: Object.fromEntries(
          Object.entries(saved).map(([sessionId, { tabs, activeId, recency }]) => [
            sessionId,
            { ...EMPTY_SESSION_DOCUMENTS, tabs: tabs.map((identity) => ({ ...identity, id: documentTabId(identity), dead: false })), activeId, recency }
          ])
        )
      }),

    dropSession: (sessionId) =>
      set((state) => {
        if (!(sessionId in state.bySession)) return state
        const bySession = { ...state.bySession }
        delete bySession[sessionId]
        return { bySession }
      }),

    pruneSessions: (keepIds) =>
      set((state) => {
        const kept = Object.entries(state.bySession).filter(([sessionId]) => keepIds.has(sessionId))
        return kept.length === Object.keys(state.bySession).length ? state : { bySession: Object.fromEntries(kept) }
      })
  }
})
