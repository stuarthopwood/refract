// Spec 024 (#538): the right pane's persisted state, one object on `Settings.rightPane`. The
// renderer's `right-pane-persistence.ts` is the only writer; the Rust side (`right_pane.rs`)
// validates and clamps the same shape. Panel ids stay plain strings here: the renderer's panel
// registry owns the real id set and drops unknown ids on restore.

// Caps mirrored by `right_pane.rs` (#2075).
export const MAX_DOCUMENT_TABS_PER_SESSION = 20
export const MAX_DOCUMENT_PATH_BYTES = 1024

export type PersistedDiffGroup = 'conflicts' | 'staged' | 'changes' | 'untracked'

/** `group` is set for a diff tab only. */
export interface PersistedDocumentTab {
  kind: 'file' | 'diff'
  group?: PersistedDiffGroup
  path: string
}

export interface PersistedSessionDocumentTabs {
  tabs: PersistedDocumentTab[]
  activeId: string | null
  /** Tab ids, least recently active first. */
  recency: string[]
}

export interface RightPaneSettings {
  open: boolean
  widthPx: number
  openPanelIds: string[]
  activePanelId: string | null
  /** Issue #730: the saved panel order. Empty means the default; may hold ids this build does
   * not register, which the renderer keeps and merges (`mergePanelOrder`). */
  panelOrder: string[]
  documentTabs: Record<string, PersistedSessionDocumentTabs>
  chatCollapsed: boolean
}

export const DEFAULT_RIGHT_PANE: RightPaneSettings = {
  open: false,
  widthPx: 320,
  openPanelIds: [],
  activePanelId: null,
  panelOrder: [],
  documentTabs: {},
  chatCollapsed: false
}
