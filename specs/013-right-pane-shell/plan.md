# Implementation Plan: Right pane shell

**Branch**: `013-right-pane-shell` (implementation lands on an issue-named branch, e.g.
`feat/538-right-pane-shell`, per `docs/PLAN.md`'s existing convention) | **Date**: 2026-10-08 |
**Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/013-right-pane-shell/spec.md`

## Summary

Replace the single-purpose `subagents` `ResizablePanel` in `App.tsx` with a generalised right pane
shell: one permanent icon rail (Subagents, FDB Knowledge, Agent Builder), one collapsible pane
whose open/width/open-panels/active-panel state lives in one new store (`right-pane-store.ts`,
data-model.md), a header that is a title row for one open panel or an ARIA-tabs bar for two or
more, and a centred launcher list when the pane is open with none. The existing Subagents panel
(spec 004 FR-017 to FR-020) becomes the shell's first hosted panel with its session-binding,
streaming, and reconciliation logic in `subagent-store.ts` completely unchanged — only its
open/closed presentation moves. Two new placeholder panels (FDB Knowledge, Agent Builder) ship
with an honest empty state by default and, behind one new `Settings.showSampleData` boolean
(default off, following `watermarkEnabled`'s exact pattern), clearly labelled sample content. The
pane header reserves the window-controls corner while open, fixing issue://394's reported bug
where `ChatHeader` always reserved it regardless. Design rationale is in [research.md](research.md);
the one new IPC method is in [contracts/ipc.md](contracts/ipc.md).

## Technical Context

**Language/Version**: TypeScript (`strict: true`) on Node 24.21.0 as bundled by Electron 44.5.1;
React 19.3.0 in the renderer. Same stack as spec 001; no new runtime added.

**Primary Dependencies**: none new. `react-resizable-panels` (already a dependency, spec 004) and
`lucide-react` (already the only icon import) cover the shell's panel/handle mechanics and every
new icon; no new npm package.

**Storage**: extends the existing `settings.json` (spec 001 data-model.md) with one new field,
`showSampleData: boolean`. The shell's own open/width/active-panel state is renderer-only zustand
state, never persisted (spec.md Assumptions, future/open-questions.md).

**Testing**: none. Refract is a prototype (constitution, Development Workflow); each story is
verified by running the app per [quickstart.md](quickstart.md). `pnpm typecheck` and `pnpm build`
must pass before a change lands on `main`.

**Target Platform**: Windows 11 only.

**Project Type**: desktop-app (Electron: main, preload, renderer) — extends spec 001's shell and
spec 004's right-side region; adds no new process type.

**Performance Goals**: from the spec: opening a second panel produces a tab bar within the same
render (SC-002); toggling "Show sample data" updates every open placeholder panel immediately,
with no restart (User Story 5, Acceptance Scenario 1).

**Constraints**: the pane header must reserve the window-controls corner whenever the pane is
open, and exactly one header (pane or chat) reserves it at a time (FR-011); the Subagents panel's
existing collapse-desync guard (`App.tsx`'s `onResize`) must generalise to every hosted panel
without regressing its own existing behaviour (FR-017, SC-004); neither placeholder may make a
network call or store state with the sample-data switch off (FR-018); every icon-only control the
shell adds needs the full icon-only bundle, not a partial one (FR-026).

**Scale/Scope**: one new renderer-only store, one new IPC method plus its main/preload/shared
plumbing, one new Settings section, three new/moved panel components (a generalised pane shell,
and two new placeholder panels), 26 functional requirements across 6 user stories.

## Constitution Check

*GATE: passes before Phase 0; re-checked after Phase 1 design. Constitution v1.9.0.*

| Principle | Status | How the design meets it |
|---|---|---|
| I. OMP is the engine | Pass (not applicable) | This spec touches no OMP process, flag, or frame; it is a renderer/main UI and settings feature. |
| II. RPC wire contract | Pass (not applicable) | No RPC traffic is added or changed. The Subagents panel's own RPC-adjacent data (`subagent-store.ts`'s `selectSubagent`/`applyPatch`) is unchanged — this spec only relocates where its open/closed state is read from. |
| III. Session and process lifecycle | Pass (not applicable) | No Session, worktree, or process lifecycle is touched; `showSampleData` is app-wide, matching `watermarkEnabled`'s own scope (Assumptions). |
| IV. Evidence before design | Pass (not applicable) | Nothing this spec depends on is an OMP/RPC behaviour. Every research.md decision is a direct read of existing code or a cited, already-decided design-system page (PR #580), never an assumption about OMP/RPC. No UNVERIFIED items. |
| V. Electron security baseline | Pass | The one new IPC method (`settings.setShowSampleData`) follows the existing typed, allowlisted `contextBridge` pattern, persisted only by main (`SettingsStore`), identical in shape to `setWatermarkEnabled`. The shell adds no new remote content, no new native module, and no new renderer-to-filesystem path. |
| Platform and Stack | Pass | Windows 11 only; Electron + Vite + React, strict TypeScript. |
| Development Workflow | Pass | Spec Kit order (`/speckit.plan` → `/speckit.tasks`, this pass); no automated tests; typecheck and build gate; verified by running the app (quickstart.md). |

No violations, so the Complexity Tracking table is empty. No constitution amendment is needed.

## Project Structure

### Documentation (this feature)

```text
specs/013-right-pane-shell/
├── spec.md
├── plan.md                 # this file
├── research.md              # 13 decisions, no UNVERIFIED items
├── data-model.md             # HostedPanelDescriptor, RightPaneState, PanelCount, Settings.showSampleData
├── quickstart.md             # how to run and verify each story
├── contracts/
│   └── ipc.md                # settings.setShowSampleData
├── checklists/requirements.md
├── future/open-questions.md  # 4 carved-out, deferred issue://538 items
└── tasks.md                   # produced by /speckit.tasks
```

### Source code (repository root, additions/changes to spec 001/004's layout)

```text
src/
├── shared/
│   ├── model.ts                                 # EDIT: Settings gains `showSampleData: boolean`
│   └── ipc.ts                                   # EDIT: SETTINGS_SET_SHOW_SAMPLE_DATA, RefractApi.settings.setShowSampleData
├── main/
│   ├── store/
│   │   └── settings.ts                          # EDIT: default `showSampleData: false`, migration merge, setShowSampleData(), validation-on-read
│   └── ipc/
│       └── settings.ts                          # EDIT: registerSettings() gains the setShowSampleData handler
├── preload/
│   └── index.ts                                 # EDIT: expose settings.setShowSampleData
└── renderer/
    ├── state/
    │   ├── right-pane-store.ts                  # NEW: RightPaneState (data-model.md) — open, widthPx, openPanelIds, activePanelId, openPanel/closePanel/setWidth/syncRenderedState (FR-005/006's toggle lives in hosted-panel-actions.ts, see below)
    │   ├── settings-store.ts                     # EDIT: DEFAULT_SETTINGS.showSampleData, setShowSampleData action
    │   ├── view-store.ts                         # EDIT: SettingsSectionId gains 'right-pane'
    │   ├── subagent-store.ts                     # EDIT: drop `open`/`sessionId`'s "is the panel showing" role (superseded by right-pane-store); keep selectedId/streams/openPanel(now binds session)/closePanel/selectSubagent/applyPatch/reset/resetForNewTurn, now driven by right-pane-store's openPanelIds
    │   └── index.ts                               # EDIT: export the new store
    ├── features/
    │   ├── right-pane/
    │   │   ├── RightPaneShell.tsx                 # NEW: the generalised ResizablePanel content — header (title row / tab bar / launcher switch) + active panel's content
    │   │   ├── IconRail.tsx                        # NEW: the permanent rail, one button per HostedPanelDescriptor, aria-pressed, tooltip bundle
    │   │   ├── PanelTabBar.tsx                      # NEW: ARIA tabs pattern, per-tab close, live count, window-controls corner spacer
    │   │   ├── PanelLauncher.tsx                    # NEW: centred list, one row per available panel
    │   │   ├── panel-registry.ts                    # NEW: HostedPanelDescriptor[] (data-model.md), usePanelCount() (reactive hook)
    │   │   ├── hosted-panel-actions.ts               # NEW: openHostedPanel/closeHostedPanel/toggleHostedPanelFromRail/suspendHostedPanels/resumeHostedPanels — the one place that knows both right-pane-store.ts and a hosted panel's own store (research.md decision 3)
    │   │   ├── WidthPresetControl.tsx               # NEW: FR-025 non-drag resize alternative, calls the shell's ResizablePanel ref
    │   │   └── placeholders/
    │   │       ├── FdbKnowledgePanel.tsx            # NEW: empty state + sample content behind Settings.showSampleData
    │   │       └── AgentBuilderPanel.tsx            # NEW: empty state + sample content behind Settings.showSampleData
    │   ├── subagents/
    │   │   └── SubagentPanel.tsx                    # EDIT: drop its own `h-10` title-row/Close-button header (now the shell's), keep list + stream content unchanged
    │   ├── chat/
    │   │   ├── ReadoutChips.tsx                      # EDIT: SubagentsChip's onActivate calls right-pane-store's openPanel('subagents') bound to sessionId, not useSubagentPanelStore.openPanel
    │   │   └── ChatHeader.tsx                        # no shape change; App.tsx now computes its `reservesWindowControls` prop from `!rightPaneOpen` (research.md decision 4)
    │   └── settings/
    │       ├── SettingsScreen.tsx                    # EDIT: SECTIONS gains { id: 'right-pane', label: 'Right pane' }, openSettings validation gains the case
    │       └── RightPaneSection.tsx                  # NEW: the "Show sample data" switch + one-line description (mirrors AppearanceSection.tsx's layout convention)
    └── App.tsx                                        # EDIT: the `subagents` ResizablePanel's id/content become the shell (`RightPaneShell`); `panelRef`/`onResize` generalise from `useSubagentPanelStore` to `right-pane-store`; right-most ChatPane's `reservesWindowControls` becomes `!rightPaneOpen`
docs/
└── PLAN.md                                              # EDIT: row C1 status only (this story's own row)
```

**Structure Decision**: no new process type and no new top-level directory beyond
`src/renderer/features/right-pane/`. The shell is additive around spec 004's existing
`ResizablePanel`/`SubagentPanel`/`subagent-store.ts`, which are edited, never replaced wholesale —
`subagent-store.ts` keeps every action it has today (research.md decision 3); only its
`open`/`sessionId` pair's role as "is the panel currently showing" is superseded by
`right-pane-store.ts`'s `openPanelIds`/`activePanelId`, with `subagent-store.ts`'s `sessionId`
field repurposed to mean "which Session this panel's content is bound to" (still set by the same
`openPanel` call, now invoked by the shell rather than read as the shell's own open/closed flag).

## Design overview

- **One store owns the shell; one store owns each panel's own data.** `right-pane-store.ts` never
  imports from `subagent-store.ts` or either placeholder's own state (there is none) — it only
  knows panel ids, order, active id, and the pane's open/width (research.md decision 3). This is
  the same separation `view-store.ts` (app-wide) already keeps from `readout-store.ts`
  (per-Session).
- **The rail, tab bar, and launcher all read one static registry, never their own list.**
  `panel-registry.ts`'s `HostedPanelDescriptor[]` is the only place "which panels exist" is
  spelled out; adding a future panel (Git changes, side chat, Terminal) is one array entry plus
  one component, touching none of the three renderers (data-model.md).
- **The Subagents panel's existing collapse-desync guard is generalised, not duplicated.**
  `App.tsx`'s current `onResize` handler (lines 366-394 on `main` today) already solves "a direct
  drag must keep the store in sync with the real rendered size"; this spec moves that logic to
  read/write `right-pane-store.ts`'s `open`/`widthPx` instead of `useSubagentPanelStore.open`,
  with the same guard conditions (`prevSize === undefined` is the initial mount; collapsed/open
  transition only; the no-focused-Session fallback forcing a real re-collapse) — not a rewritten
  algorithm.
- **Sample data is a rendering choice inside two already-separate components, never a shared
  "maybe fake" wrapper.** `FdbKnowledgePanel.tsx`/`AgentBuilderPanel.tsx` each read
  `Settings.showSampleData` directly and render one of two fixed JSX trees (empty state, or sample
  content with the "Sample data" label on every element) — no generic "fake data provider"
  abstraction that could leak into a real panel later.
- **The window-controls corner is reserved exactly once, by construction.** `App.tsx` computes
  `reservesWindowControls` for the right-most `ChatPane` as `!rightPaneOpen` and the shell's own
  header always reserves it while `rightPaneOpen` — the two are complementary booleans driven by
  the same `right-pane-store.open`, so there is no third state where both or neither reserve it
  (research.md decision 4, FR-011).

### Build order and dependencies on other specs

1. **Spec 004's Subagents panel and `subagent-store.ts`** are already built on `main` in this
   checkout (confirmed by direct read, research.md decisions 1 and 3) — no sequencing risk; this
   spec edits them in place.
2. **Spec 012's `watermarkEnabled` precedent** for `Settings.showSampleData`'s shape is already
   built on `main` — no sequencing risk (research.md decision 6).
3. Within this spec: the Foundational phase (the shell's own store, registry, rail, header modes,
   and the `App.tsx`/`ChatHeader.tsx` window-controls wiring) must land before the Subagents
   migration (User Story 3), because the migration retargets `SubagentsChip`'s `onActivate` at the
   new store. The two placeholder panels (User Story 4/5) and the Settings section are independent
   of the Subagents migration (disjoint files) and can be built in parallel with it, but both need
   the Foundational phase's registry and shell first. The non-drag resize control (User Story 6)
   depends only on the Foundational phase's `ResizablePanel` ref, not on any other story.
4. This maps directly to the assignment's four slices:
   - **Slice 1 (shell and store)**: Foundational phase below.
   - **Slice 2 (launcher and tabs, Subagents hosted)**: User Story 1, 2, 3.
   - **Slice 3 (FDB placeholders and the Settings switch)**: User Story 4, 5.
   - **Slice 4 (non-drag resize, tests/live verification)**: User Story 6, plus quickstart.md run
     and gate commands across every prior slice.

## Phase 1 re-check (post-design)

The data model and contracts introduce no new process, native module, or renderer capability
beyond those already covered by the Constitution Check: the one new IPC method is an ordinary,
already-allowlisted pattern extended to one more boolean fact, and every new component is a plain
React/Tailwind panel reusing existing tokens and the existing `ResizablePanel` primitive. There are
no open evidence gaps and no UNVERIFIED items (Phase 0 found none needing a probe, since nothing in
this spec touches OMP/RPC).

## Complexity Tracking

None — the Constitution Check above has no violations.
