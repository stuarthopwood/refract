# Implementation Plan: Split chat pane

**Branch**: `005-split-chat-pane` (no branch created; work lands on `main`) | **Date**: 2026-10-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/005-split-chat-pane/spec.md`

## Summary

Generalise Refract's single-visible-session chat area (spec 001) into at most two side-by-side
panes. A developer puts a second session beside the first from a session row's "Open in split"
item or Ctrl+click; exactly one pane is focused at a time and every pane-scoped control (message
box, Stop, queue, approvals) acts only on its own session; either pane closes independently back
to one full-width pane; and the whole arrangement — both sessions, the divider position, and
which pane was focused — survives an app restart without starting either agent. Design decisions
and the react-resizable-panels verification are in [research.md](research.md); the changed/added
IPC surface is in [contracts/ipc.md](contracts/ipc.md).

## Technical Context

**Language/Version**: TypeScript (`strict: true`) on Node 24.21.0 as bundled by Electron 44.5.1; React 19.3.0 in the renderer. Same as spec 001; no change.

**Primary Dependencies**: no new dependency. Reuses `react-resizable-panels` 4.14.1 (already installed, already used for the session-list/chat divider) and the existing `shadcn/ui` components (`Badge`, `DropdownMenuItem`, `Tooltip`).

**Storage**: adds one field, `split: SplitLayout | null`, to the existing `settings.json` row (data-model.md). No new file.

**Testing**: none. Refract is a prototype (constitution, Development Workflow); each story is verified by running the app per [quickstart.md](quickstart.md). Typecheck and production build must pass before a change lands on `main`.

**Target Platform**: Windows 11 only.

**Project Type**: desktop-app (Electron: main, preload, renderer). Same project as spec 001; no new source root.

**Performance Goals**: from the spec: both panes' turns stream live with no observable delay introduced by the other, for the full duration of both turns (FR-004, SC-002) — met by each pane subscribing only to its own session's already-per-session `queue-store`/`pending-requests-store`/`commands-store` entries and the newly per-session `transcript-store`, so one session's patches never touch the other's React state.

**Constraints**: a live Session still costs about 1.1 to 1.9 GB (spec 001 FINDINGS item 13); restoring a split MUST NOT start either agent (FR-014), so a restored split costs nothing until the developer actually opens a pane.

**Scale/Scope**: exactly two panes maximum, app-wide (not per-Repository); 23 requirements across 4 user stories.

## Constitution Check

*GATE: passes before Phase 0; re-checked after Phase 1 design. Constitution v1.7.1.*

| Principle | Status | How the design meets it |
|---|---|---|
| I. OMP is the engine | Pass | No change to how OMP is launched or driven; a second pane is a second already-existing `SessionAgent`/`OmpProcess` (spec 001 US5 already supports several live Sessions at once), never a new transport. |
| II. RPC wire contract | Pass | No new RPC usage; both panes use the same `prompt`/`abort`/`extension_ui_request` flow spec 001 already verified, one `SessionAgent` per session as today. |
| III. Session and process lifecycle | Pass | No new process-launch or reattach path. Restoring a split explicitly does **not** reattach or start any agent (FR-014, research.md Decision 4) — stricter than spec 001's existing reattach-on-open, never looser. |
| IV. Evidence before design | Pass | This spec introduces no new OMP, Electron, GitHub CLI, or Windows behaviour to probe: it reuses spec 001's already-verified process/IPC/security primitives. The one third-party-library behaviour it newly relies on (keyboard-operable resize handle, layout-change persistence) is sourced from the installed library's own documentation (research.md Decision 5), not a constitution-IV-scoped probe. |
| V. Electron security baseline | Pass | No new preload surface crosses main/renderer except two small, typed additions (`sessions.setVisible` becomes array-valued; `settings.setSplit` takes a plain `{ sessionIds, dividerPercent, focusedIndex }` record) — both main-validated, no new file, process, or git access from the renderer. |
| Platform and Stack | Pass | Same Electron + Vite + React stack, Windows 11 only; no new source root. |
| Development Workflow | Pass | Spec Kit order followed; no automated tests added (prototype); typecheck and build gate unchanged. |

No violations, so the Complexity Tracking table is empty.

## Project Structure

### Documentation (this feature)

```text
specs/005-split-chat-pane/
├── spec.md
├── plan.md              # this file
├── research.md          # decisions (including the two conservative, unconfirmed-with-Stuart reads)
├── data-model.md         # SplitLayout, generalised stores
├── quickstart.md         # how to run and verify each story
├── contracts/
│   └── ipc.md            # only what this spec adds or changes over spec 001's contracts/ipc.md
├── checklists/requirements.md
└── tasks.md              # produced by /speckit.tasks
```

### Source code (repository root, existing project — paths touched by this spec only)

```text
src/
├── shared/
│   ├── ipc.ts                       # sessions.setVisible -> string[]; + settings.setSplit
│   └── model.ts                     # Settings.split: SplitLayout | null
├── main/
│   ├── index.ts                     # validate/drop stale split entries at startup (no agent start)
│   ├── SessionManager.ts            # visibleSessionId -> visibleSessionIds: Set<string>
│   ├── ipc/
│   │   ├── sessions.ts              # setVisible handler takes string[]
│   │   └── settings.ts              # + setSplit handler
│   └── store/
│       └── settings.ts              # + setSplit persistence
├── preload/
│   └── index.ts                     # bridge the two changed/added methods
└── renderer/
    ├── App.tsx                      # chat region renders one or two ChatPanes + a divider
    ├── state/
    │   ├── split-store.ts           # NEW: paneSessionIds, focusedIndex, dividerPercent, pristine
    │   ├── sessions-store.ts        # visibleSessionId removed; split-store owns pane targeting
    │   ├── transcript-store.ts      # single {sessionId, items} -> Record<sessionId, items>
    │   └── index.ts                 # export the new store
    └── features/
        ├── chat/
        │   ├── ChatPane.tsx         # takes (sessionId, paneIndex, focused) instead of reading a singleton
        │   ├── ChatHeader.tsx       # focused marker, narrow-width "other session" chip (Decision 6)
        │   └── MessageInput.tsx     # unchanged contract; already per-sessionId and already handles not-started
        └── sessions/
            └── SessionList.tsx      # SessionRow: "Open in split" menu item, Ctrl+click, pane-aware click rule
docs/DESIGN.md                        # Layout, Chat, Keyboard, Backlog sections updated
CONTEXT.md                            # no new vocabulary needed (Chat pane/Split/Divider already spec-only)
```

**Structure Decision**: no new source root or package; every change is additive/generalising
inside the existing `src/main`, `src/preload`, `src/renderer`, `src/shared` layout spec 001
established. The one new file is `src/renderer/state/split-store.ts`.

## Design overview

- **Main only ever tracks a set of visible ids, never pane identity.** `SessionManager` keeps
  `visibleSessionIds: Set<string>` instead of one id; `isVisible()` and patch-forwarding become
  set-membership checks. Pane layout (which id is in which pane, which is focused, the divider
  position) is a renderer-only concern, in the new `split-store.ts`.
- **Every per-session store either already supports two sessions, or is generalised to.**
  `queue-store.ts`, `pending-requests-store.ts`, `commands-store.ts` need no change (already
  `Record<sessionId, ...>`); only `transcript-store.ts` changes shape.
- **Restoring a split is deliberately not "opening" either session.** `split-store.ts` marks a
  restored pane "pristine" until a real action (first message sent, explicit row interaction)
  opens it for real — see research.md Decision 4. This is the one genuinely new control-flow
  branch in the whole feature; everything else is routing today's single-pane logic per pane.
- **The divider is the same `react-resizable-panels` component already in the app**, just nested
  one level deeper (session-list | [chat-pane-A | chat-pane-B]), with its own `onLayoutChanged`
  feeding persistence instead of hand-rolled resize code.
- **Cross-spec surfaces stay stubs until their spec ships.** The readout chip row (spec 004) and
  Subagents panel (spec 004) are not built by this spec; a pane simply has no chip row and no
  Subagents panel yet, exactly as spec.md's Assumptions say. No task in this spec edits spec 003
  or spec 004 files.

## Phase 1 re-check (post-design)

`data-model.md` and `contracts/ipc.md` introduce one new settings field and one changed/one new
IPC method, both already covered by the existing preload allowlist pattern (constitution V) — no
new process, network access, or renderer capability. The `react-resizable-panels` keyboard/
persistence behaviour relied on in research.md Decision 5 is sourced from the library's own
documentation, not run-time probed, and is not in constitution IV's named scope (OMP, Electron,
GitHub CLI, Windows) — recorded for transparency, not as a gap.

## Complexity Tracking

None.

## Cross-spec dependencies (not built here)

- **Spec 001** (US5 "several sessions at once", FR-006 unread, FR-018/FR-019 approvals and
  questions stay visible and answerable, FR-049 full-width chat text): this spec's panes reuse
  those behaviours per-session; no spec 001 file is edited beyond the generalisations listed above
  under "Source code".
- **Spec 004** (session readout chip row, Subagents panel): referenced by FR-003/FR-020 as
  "once spec 004 exists"; until then a pane simply omits both. No spec 004 file exists yet to
  depend on or edit.
- **Spec 003** (Pull requests view) and the Settings screen (also spec 004): FR-021 requires the
  split's own state to be kept, unchanged, while either view replaces the chat area. This spec
  implements that by never tearing down `split-store`'s state when the chat region unmounts (it
  is a module-level zustand store, already outlives any one component the same way
  `sessions-store` does today); no spec 003/004 file is edited.
