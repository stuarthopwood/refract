# Data Model: Right pane shell

## `HostedPanelDescriptor` (static registry, not persisted)

A build-time array, one entry per available panel, read by the rail, the tab bar, and the
launcher — the single source of which panels exist, so none of the three renders its own list.

```ts
interface HostedPanelDescriptor {
  id: PanelId                         // 'subagents' | 'fdb-knowledge' | 'agent-builder'
  name: string                        // "Subagents" | "FDB Knowledge" | "Agent Builder"
  icon: LucideIcon                    // BotIcon | LibraryIcon | HammerIcon (research.md decision 8)
  hasCount: boolean                   // true only for 'subagents' in this spec (FR-013)
}

type PanelId = 'subagents' | 'fdb-knowledge' | 'agent-builder'
```

Adding a future panel (Git changes, side chat, Terminal, file explorer, Jira — every row in
`docs/PLAN.md` phase C/C2/C3 that builds on this spec) is one new array entry plus one new
component; nothing in `RightPaneState`/`OpenPanelsState` below changes shape.

## `RightPaneState` (new store, `right-pane-store.ts`, zustand, in-memory — FR-002, FR-003)

```ts
interface RightPaneState {
  open: boolean                       // the pane itself, collapsed or not (FR-003, FR-004)
  widthPx: number                     // current rendered width; default 320 (FR-004)
  openPanelIds: PanelId[]             // ordered; tab order when 2+ (FR-008)
  activePanelId: PanelId | null       // which open panel is shown; null only with openPanelIds = []
  openPanel(id: PanelId): void        // opens pane if collapsed; adds id if absent; makes it active
  closePanel(id: PanelId): void       // removes id; if it was active, activates the new last id,
                                       // or null if openPanelIds is now empty (never collapses `open`)
  // FR-005/FR-006 (openPanel if not open-and-active, closePanel if open-and-active) is
  // implemented as `toggleHostedPanelFromRail` in `features/right-pane/hosted-panel-actions.ts`,
  // not a method on this store -- it also needs a panel's own binding (e.g. subagent-store.ts's
  // Session bind), which this store deliberately never imports (research.md decision 3).
  setWidth(widthPx: number): void     // drag handle AND the width-preset buttons (FR-025) both call this
  syncRenderedState(open: boolean, widthPx: number): void
    // generalises App.tsx's existing onResize desync guard (research.md decision 2) from the
    // Subagents-only case to any hosted panel; called from the shell's ResizablePanel onResize,
    // never from a click handler
}
```

Collapsed-pane invariant: `open === false` never implies `openPanelIds` is cleared — collapsing
and reopening the pane within the same session restores the same tabs (FR-003), which is why
`openPanelIds`/`activePanelId` are separate from `open`/`widthPx` rather than folded into one
"closed" state the way the old `useSubagentPanelStore.open` boolean was.

Zero panels open (`openPanelIds = []`, `activePanelId = null`) with `open === true` is the
launcher state (User Story 2); it is a valid, reachable, non-transient state, not an edge case —
closing the last panel always lands here (FR-009).

## `OpenPanelsState` (derived, not separately stored)

Whether the header shows a title row, a tab bar, or the launcher is a pure function of
`openPanelIds.length` (`0` -> launcher, `1` -> title row, `2+` -> tab bar) — there is no separate
"header mode" field to keep in sync.

## `PanelCount` (per-render, computed — not stored on `HostedPanelDescriptor`)

```ts
type PanelCount =
  | { kind: 'running'; value: number }          // Subagents today (FR-013); value > 0 to render at all
  | { kind: 'additions-deletions'; additions: number; deletions: number } // future Git panel (FR-014)
  | null                                          // no meaningful count (FR-012) — renders nothing

function usePanelCount(id: PanelId, sessionId: string | null): PanelCount
// implemented as a reactive hook in `panel-registry.ts` (every render site needs to re-render
// live, not just read a snapshot):
// 'subagents': reads useReadoutStore's bySession[sessionId].readout.subagentCount.running (FR-013);
//   null if sessionId is null or running === 0 (zero is "not meaningful" here, matching the
//   issue://538 rule "A panel with no meaningful count shows none")
// 'fdb-knowledge' | 'agent-builder': always null in this spec (neither issue defines a count)
```

`sessionId` here is the shell's own notion of "whichever Session's data should back a per-Session
panel's count" — for `subagents` this is `frontSessionId` (the focused chat pane's Session,
`App.tsx`'s existing computed value), matching FR-013 and User Story 3 Acceptance Scenario 5. A
future global Agents panel (issue://490) would supply a different, cross-Session source here
(future/open-questions.md) without changing `PanelCount`'s shape.

## `Settings.showSampleData` (persisted — FR-020 to FR-022, research.md decision 6)

```ts
// src/shared/model.ts, Settings interface addition:
showSampleData: boolean // spec 013 FR-020 to FR-022: default false
```

Migration: same as every prior `Settings` field addition (spec 004 `sessionReadout`, spec 007
`theme`, spec 012 `watermarkEnabled`) — `src/main/store/settings.ts`'s existing read-time merge
against `DEFAULT_SETTINGS` supplies `showSampleData: false` for any `settings.json` written before
this spec, with no dedicated migration step.

## `SettingsSectionId` addition

```ts
// src/renderer/state/view-store.ts
export type SettingsSectionId = 'session-readout' | 'appearance' | 'right-pane' // + 'right-pane'
```

`SECTIONS` in `SettingsScreen.tsx` gains `{ id: 'right-pane', label: 'Right pane' }`
(research.md decision 7); `openSettings`'s validation switch gains the third case.

## Relationship to spec 004's `SessionReadout`/`SubagentSummary`

Unchanged. `readout-store.ts`'s `bySession` map, `SessionReadout.subagentCount`, and
`SubagentSummary[]` are read by `getPanelCount` and by the migrated `SubagentPanel` exactly as they
are today; this spec adds no new field to either shape.
