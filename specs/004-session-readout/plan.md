# Implementation Plan: Session readout

**Branch**: `004-session-readout` (no branch created; work lands on `main`) | **Date**: 2026-10-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-session-readout/spec.md`

## Summary

Add a chip row above the message box, directly after spec 001's Approval mode pill, that reads a
Session's state at a glance: file-change counts, context-window usage, the running turn's
elapsed time, the wall clock, an open pull request's number, a running-turn subagent count, and
task-list progress. A single app-wide Settings screen lets the developer show or hide each
readout, applied live to every open Session. Activating the Subagents chip opens the app's first
use of the reserved right-side pane: a closeable panel listing the turn's subagents with a live
stream for whichever one is selected. Design rationale and probe results are in
[research.md](research.md); the two interface contracts are in [contracts/](contracts/).

## Technical Context

**Language/Version**: TypeScript (`strict: true`) on Node 24.21.0 as bundled by Electron 44.5.1; React 19.3.0 in the renderer (unchanged from spec 001).

**Primary Dependencies**: no new npm packages. Readout formatting uses the platform `Intl.NumberFormat` (abbreviated counts, FR-002) and `Intl.DateTimeFormat` (Current time, FR-005); the pull request lookup calls the `gh` executable directly with `execFile` (argument arrays, no shell), the same pattern as spec 001's git helper (research.md decision 7) and the stance in specs 003/008 (GitHub access comes from the developer's own signed-in GitHub CLI, no stored token).

**Storage**: extends the existing `settings.json` (data-model.md "settings.json") with one new field, `sessionReadout`. No new storage file.

**Testing**: none. Refract is a prototype (constitution, Development Workflow); each story is verified by running the app per [quickstart.md](quickstart.md). `pnpm typecheck` and `pnpm build` must pass before a change lands on `main`.

**Target Platform**: Windows 11 only (unchanged).

**Project Type**: desktop-app (Electron: main, preload, renderer) — same app as spec 001, this feature extends it.

**Performance Goals**: from the spec: a developer reads Changes, Context window usage, and Turn time within 2 s of looking (SC-001); a Settings change reaches every open Session's chip row within 1 s (SC-002); the Subagents chip shows its list within 1 s and a selected stream reflects new output within 2 s (SC-006).

**Constraints**: every chip update follows spec 001's coalescing convention (at most one patch per 50 ms per Session) so a ticking clock or a fast-streaming subagent cannot flood IPC; the renderer never calls `gh` or touches git itself (constitution V); PR and GitHub-availability failures are silent to the user (FR-006, SC-007) — never a toast.

**Scale/Scope**: 7 readout kinds, 1 Settings section, 1 right-pane panel; the same handful of Repositories and tens of Sessions as spec 001.

## Constitution Check

*GATE: passes before Phase 0; re-checked after Phase 1 design. Constitution v1.7.1.*

| Principle | Status | How the design meets it |
|---|---|---|
| I. OMP is the engine | Pass | No new launch flags; the context-usage and todo-progress readouts and the subagent stream read OMP's existing RPC surface (`get_state`, a new subscription/update frame) once probed; nothing is reimplemented client-side that OMP already reports. |
| II. RPC wire contract | Pass | No change to the prompt, abort, or dialog contracts. The new reads are additional `get_state` fields and a subagent progress frame, layered beside the existing frame decoder. |
| III. Session and process lifecycle | Pass | No new process or reattach behaviour; readouts are derived state recomputed from the same `get_state`/frame stream spec 001 already reads, and are dropped (not persisted) like the rest of `SessionRuntime` on a restart. |
| IV. Evidence before design | Pass, with named gaps | Three OMP behaviours this spec depends on are unverified on 18.4.x: context-window usage, task-list ("todo") progress, and per-subagent id/status/stream data beyond FINDINGS C6's proof that subagent progress exists at all. Each gets its own first-phase probe task (Phase 1) before any chip or panel code is built on it, per the Unknowns table in research.md. |
| V. Electron security baseline | Pass | The `gh` lookup runs in main via `execFile`, argument arrays, no shell; the renderer only receives the already-sanitised `{ number, url }` pair and opens it with `shell.openExternal`, never a loaded URL. Subagent stream text goes through the same sanitised markdown path as the main transcript (no new raw-HTML surface). |
| Platform and Stack | Pass | Windows 11 only; same Electron/Vite/React stack, no new native module. |
| Development Workflow | Pass | Spec Kit order (this plan is produced by `/speckit.plan`); no automated tests; typecheck and build gate. |

No violations, so the Complexity Tracking table is empty.

## Project Structure

### Documentation (this feature)

```text
specs/004-session-readout/
├── spec.md
├── plan.md              # this file
├── research.md          # decisions, probe Unknowns table
├── data-model.md         # Settings extension, SessionReadout, SubagentSummary
├── quickstart.md         # how to run and verify each story
├── contracts/
│   ├── ipc.md            # new renderer<->main channels and events
│   └── omp-usage.md      # the three unverified OMP reads this spec probes
├── checklists/requirements.md
└── tasks.md              # produced by /speckit.tasks
```

### Source code (repository root, extending spec 001's layout)

```text
src/
├── shared/
│   ├── model.ts                 # + ReadoutKind, Settings.sessionReadout, SessionReadout, SubagentSummary, SessionRuntime.turnStartedAt
│   ├── ipc.ts                   # + settings.setReadoutVisibility, chat.setVisibleSubagent, chat.subagentSnapshot, SessionSnapshot.readout, readout:update, subagents:update, subagent:patch
│   └── frames.ts                # + the subagent-progress frame and get_state fields the Phase 1 probes resolve
├── main/
│   ├── omp/
│   │   ├── SessionAgent.ts      # + turnStartedAt tracking, subagent tracking (id/name/status/stream), readout assembly trigger
│   │   └── readout.ts           # new: assembles SessionReadout from diffStat, get_state, turnStartedAt, the PR lookup, subagent counts, todo progress
│   ├── git/
│   │   └── github.ts            # new: `gh pr view --json number,url,state` for a branch, read-only, cached per Session
│   └── ipc/
│       ├── settings.ts          # + setReadoutVisibility
│       └── sessions.ts          # SessionSnapshot now includes `readout`
└── renderer/
    ├── state/
    │   ├── settings-store.ts    # + sessionReadout
    │   ├── view-store.ts        # new, shared with spec 003 and spec 008 (unified shape agreed during planning, see research.md decision 6): this spec builds the full ViewState (all four `view` members) but only implements the 'chat'/'settings' behaviour it owns
    │   └── readout-store.ts     # new: SessionReadout + subagent list/stream per Session, fed by the new events
    ├── features/
    │   ├── chat/
    │   │   ├── MessageInput.tsx # chip row already added by spec 001 T098; this spec appends readout chips after the Approval mode pill
    │   │   └── readout/
    │   │       ├── ReadoutChip.tsx    # new: shared chip baseline (icon, label, value, optional activation)
    │   │       └── ReadoutChips.tsx   # new: ChangesChip, ContextUsageChip, TurnTimeChip, CurrentTimeChip, PullRequestChip, SubagentsChip, TodoProgressChip
    │   ├── settings/
    │   │   └── SettingsScreen.tsx     # new: Session readout section, FR-012 to FR-016
    │   └── subagents/
    │       └── SubagentPanel.tsx      # new: right-pane list + live stream, FR-017 to FR-020
    └── App.tsx                        # + the right-pane ResizablePanel hosting SubagentPanel (first occupant of the region reserved in spec 001 plan.md)
```

**Structure Decision**: no new source root; this feature extends spec 001's existing `main`/`preload`/`renderer`/`shared` layout in place. The right-side pane this spec occupies is the region spec 001's `App.tsx` comment already reserves ("a reserved right region for the later changes, files, and side chat pane"); this is that pane's first tenant, not a new layout concept.

## Design overview

- **One bundle, one event.** All of a Session's per-moment readout values (changes, context usage, turn-time anchor, pull request, subagent counts, todo progress — not Current time, which is a pure client clock) are assembled into one `SessionReadout` object in main and pushed as one coalesced `readout:update` event, the same 50 ms/Session discipline as `transcript:patch`, so a ticking value cannot flood IPC and the renderer never has to reconcile seven independent partial updates.
- **Reuse, never rebuild, spec 001's own readouts.** The Changes chip calls spec 001 task T068's `sessions.diffStat(id)`; the chip row itself is appended after spec 001 task T098's Approval mode pill. This spec's Phase 2 (Foundational) work assumes both have already landed; it does not re-implement either (contracts/ipc.md notes this explicitly instead of redefining them).
- **Settings stay app-wide.** `sessionReadout` sits beside `approvalMode` in the same `Settings` row and the same `settings:changed` push, matching how Approval mode already applies to every Session (spec 001 FR-015, this spec's Assumptions).
- **The subagent panel is read-only UI over already-tracked state.** Main keeps one subagent-tracking structure per Session (id, name/task, status, stream) built from the `task` tool call and its progress frames; the panel requests a snapshot for whichever subagent is selected and then receives patches, mirroring `sessions.open` + `transcript:patch` rather than inventing a new pattern.
- **One view-switch store, not a Settings-only special case.** `view-store.ts` holds `view: 'chat' | 'pull-requests' | 'settings' | 'manage-sessions'`, `repositoryId: string | null` (spec 003's field), and `settingsSection: SettingsSectionId | null` (this spec's field), with four actions (`openChat`, `openPullRequests`, `openSettings(section?)`, `openManageSessions`); `App.tsx` swaps its main-area render on `view`, the same way it already swaps on `showReadiness`. This spec's task builds the whole typed shape (so whichever of specs 003/004/008 lands first does not clobber the others' fields) but only implements real behaviour for `'chat'`/`'settings'`: `openPullRequests`/`openManageSessions` exist as typed, no-op-beyond-setting-`view` stubs, ready for spec 003/008 to add their own `App.tsx` render branch without touching the store's shape again. `SettingsScreen.tsx` is a left-section-list layout (one section today, "Session readout") that reads `settingsSection` to focus the right one, defaulting safely when it names a section that does not exist yet. Agreed with the parallel `Plan008Profile` and `Plan003PullRequests` planning sessions so exactly one store exists, not three.
- **A temporary, spec-004-owned Settings entry point.** FR-011 ties the real entry to spec 008's profile-item cog, which is Draft with no tasks yet. Until spec 008 lands, this spec adds one small, plainly-labelled gear affordance of its own (not styled as a profile item) that calls `view-store`'s `openSettings()`, solely so this spec's own quickstart can reach the screen; spec 008's FR-002 supersedes it with the real cog, and removing the temporary affordance is noted as a follow-up in that spec, not built here.
- **Three OMP behaviours are unverified and gate the stories that need them**, per constitution IV: context-window usage and todo progress gate parts of User Story 1; per-subagent live-stream data gates User Story 3. Each has its own probe task before any chip or panel code names a real field.

## Phase 1 re-check (post-design)

Phase 1 design added no new process, no new renderer capability beyond what the Electron security
baseline already allows (main-only `gh` execution, no remote content), and no storage beyond one
new field in an existing file. The constitution gate that still has open items (Principle IV) is
unchanged by design and is resolved by the three Phase 1 probe tasks in tasks.md, which run before
any other task in this spec.

## Complexity Tracking

None.
