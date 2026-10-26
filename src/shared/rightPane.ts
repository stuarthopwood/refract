// Spec 024 (#538): the right pane's persisted state, one object on `Settings.rightPane`. The
// renderer's `right-pane-persistence.ts` is the only writer; the Rust side (`right_pane.rs`)
// validates and clamps the same shape. Panel ids stay plain strings here: the renderer's panel
// registry owns the real id set and drops unknown ids on restore.
export interface RightPaneSettings {
  open: boolean
  widthPx: number
  openPanelIds: string[]
  activePanelId: string | null
}

export const DEFAULT_RIGHT_PANE: RightPaneSettings = {
  open: false,
  widthPx: 320,
  openPanelIds: [],
  activePanelId: null
}
