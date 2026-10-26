# Implementation Plan: Core session workspace

**Branch**: `001-core-session-workspace` (no branch created; work lands on `main`) | **Date**: 2026-09-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-core-session-workspace/spec.md`

## Summary

Build the first usable slice of Refract: an Electron desktop app whose left pane lists Repositories and their Sessions (one git worktree each) and whose centre pane chats with the OMP coding agent. Each Session runs its own `omp --mode rpc-ui` child process in its worktree; Refract normalises OMP's frame stream into a transcript, answers approvals and questions, queues follow-ups, reattaches saved Conversations after restarts, and keeps every agent inside a kill-on-close Windows Job Object. Design rationale and probe results are in [research.md](research.md); the two interface contracts are in [contracts/](contracts/).

## Technical Context

**Language/Version**: TypeScript (`strict: true`) on Node 24.21.0 as bundled by Electron 44.5.1; React 19.3.0 in the renderer.

**Primary Dependencies**: `electron` 44.5.1, `electron-vite` 5.0.0, `react` 19.3.0, `zustand` 5.0.15, `react-markdown` 10.1.0 + `remark-gfm` 4.0.1 + `rehype-sanitize` 6.0.0, `mermaid` 11.17.2 (lazy-loaded, `securityLevel: 'strict'`), `shiki` 4.4.3 (JS engine), `react-diff-view` 3.3.3, `react-virtuoso` 4.18.16, `react-resizable-panels` 4.14.1, `tailwindcss` 4.3.3, `shadcn/ui` (CLI `shadcn` 4.21.0; components copied into `src/renderer/components/ui/` and owned by the repository; style `radix-nova` — primitive base **Radix**, chosen over the CLI's own `base-nova` default because Base UI (`@base-ui-components/react`) is still `1.0.0-rc.0` on npm while Radix's unified `radix-ui` package is GA and both support React 19; runtime packages installed alongside the copied components: `radix-ui` 1.6.7, `cn` 0.4.0, `class-variance-authority` 0.7.1, `lucide-react` 1.49.0, `sonner` 2.0.8, `next-themes` 0.4.6, `@shadcn/react` 0.3.1 for Message Scroller, plus dev-only CSS imports `shadcn` 4.21.0 and `tw-animate-css` 1.4.0), `koffi` 3.3.2 (Windows Job Object; prebuilt binary, verified loading inside Electron 44.5.1's main process, T004).

**Storage**: three JSON files in `userData` (`registry.json`, `settings.json`, `processes.json`), atomic writes. Conversations are OMP's own files, not copied.

**Testing**: none. Refract is a prototype (constitution, Development Workflow); each story is verified by running the app per [quickstart.md](quickstart.md). Typecheck and production build must pass before a change lands on `main`.

**Target Platform**: Windows 11 only.

**Project Type**: desktop-app (Electron: main, preload, renderer).

**Performance Goals**: from the spec: agent ready within 30 s of opening a Session (measured about 16 s); approvals and questions visible within 1 s; Stop effective within 3 s; low-memory warning within 10 s; a 30-tool-call turn stays smooth (virtualised transcript, IPC patches coalesced to one per 50 ms per Session).

**Constraints**: a live Session costs about 1.1 to 1.9 GB on the reference 16 GB machine (FINDINGS item 13) and the user set no limit on live agents, so memory is a warning, not a cap; renderer is sandboxed and never touches processes, files, or git; every `omp` process is in a Job Object.

**Scale/Scope**: one developer; a handful of Repositories, tens of Sessions, up to about 5 live agents; 38 requirements across 7 user stories.

## Constitution Check

*GATE: passes before Phase 0; re-checked after Phase 1 design. Constitution v1.4.0.*

| Principle | Status | How the design meets it |
|---|---|---|
| I. OMP is the engine | Pass | Only `omp --mode rpc-ui` over stdio, one process per Session, full feature set, no forbidden flags. `--approval-mode` is passed explicitly from the global Approval mode ([omp-usage](contracts/omp-usage.md), Launch). Native commands limited to the absent set. |
| II. RPC wire contract | Pass | `message` field; wait for `session_settled` after `abort`; no literal `/btw`; approvals versus questions by the `Allow tool:` title; every dialog answered; slash commands checked against `available_commands_update`; v2 negotiated with an own chunk decoder (research 5). |
| III. Session and process lifecycle | Pass | No `--session-dir`; cwd is the worktree; reattach by `switch_session` with `get_state` verification (never `--resume`, FINDINGS item 17); main process joins a kill-on-close Job Object at start plus pid-and-start-time fallback; stdin close then `taskkill /T /F` (research 3, 4). |
| IV. Evidence before design | Pass, with named gaps | Every OMP behaviour used is probed (FINDINGS) or labelled unverified in research.md and contracts. Gaps are scheduled as first tasks: edit-diff source, signed-in detection, `koffi` in Electron, sandboxed preload. |
| V. Electron security baseline | Pass | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; main owns processes, files, git; typed allowlisted preload API ([ipc](contracts/ipc.md)); markdown through `rehype-sanitize`; no remote content; external links to the system browser. |
| Platform and Stack | Pass | Windows 11 only; process control isolated in `src/main/process/`; Electron + Vite + React, strict TypeScript. |
| Development Workflow | Pass | Spec Kit order; no automated tests; typecheck and build gate. |

No violations, so the Complexity Tracking table is empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-core-session-workspace/
├── spec.md
├── plan.md              # this file
├── research.md          # decisions and what is verified
├── data-model.md        # stored files, derived data, state machine
├── quickstart.md        # how to run and verify each story
├── contracts/
│   ├── omp-usage.md     # how Refract uses OMP's RPC
│   └── ipc.md           # renderer to main API
├── checklists/requirements.md
└── tasks.md             # produced by /speckit.tasks
```

### Source code (repository root)

```text
package.json
electron.vite.config.ts
tsconfig.json  tsconfig.node.json  tsconfig.web.json
src/
├── shared/
│   ├── ipc.ts                 # request and event types (contracts/ipc.md)
│   ├── model.ts               # Repository, Session, TranscriptItem, PendingRequest (data-model.md)
│   └── frames.ts              # the subset of OMP frame types Refract reads
├── main/
│   ├── index.ts               # app lifecycle, window, ipc registration, notifications
│   ├── omp/
│   │   ├── OmpProcess.ts      # spawn, JSONL reader, chunk decoder, request correlation
│   │   ├── SessionAgent.ts    # per-Session controller: status, turns, queue, dialogs, restart
│   │   ├── transcript.ts      # frames and history to TranscriptItem
│   │   └── dialogs.ts         # extension_ui_request classification and answers
│   ├── process/
│   │   ├── jobObject.ts       # koffi Job Object (Windows only lives here)
│   │   └── pidRecords.ts      # processes.json and start-up reaping
│   ├── git/
│   │   ├── git.ts             # execFile helper
│   │   └── worktrees.ts       # create, remove, list branches, status, names
│   ├── store/
│   │   ├── registry.ts        # registry.json
│   │   ├── settings.ts        # settings.json
│   │   └── atomicJson.ts
│   ├── conversations.ts       # scan sessionDir, titles, previews
│   ├── readiness.ts           # git, omp version, signed in
│   └── memory.ts              # free-memory sampling and warning
├── preload/
│   └── index.ts               # contextBridge: window.refract
└── renderer/
    ├── index.html
    ├── main.tsx
    ├── state/                 # zustand stores fed by ipc events
    ├── features/
    │   ├── readiness/         # first-run checklist
    │   ├── sessions/          # list, new-session dialog, archive, delete
    │   ├── chat/              # transcript, tool rows, input, queue chips, request cards
    │   ├── status-bar/        # Approval mode switch, memory warning
    │   └── palette/           # not in this spec (issue #5)
    └── styles/                # CSS variables: dark and light themes, fonts
docs/spike/                    # probe scripts and findings (already present)
```

**Structure Decision**: one Electron project with three source roots (`main`, `preload`, `renderer`) and one shared types folder, following electron-vite's default layout. All Windows-specific code sits in `src/main/process/`. The `palette` folder is listed only to mark where issue #5 goes; it is not created in this feature.

## Design overview

- **Main owns state.** `SessionAgent` per Session holds status, transcript, queue, and pending requests; it is the only code that talks to an `OmpProcess`. The renderer subscribes to patches and calls typed requests.
- **One job, joined at start.** `jobObject.ts` creates the kill-on-close job once and assigns Refract's own main process to it before anything is spawned; every `omp` inherits it. `OmpProcess` only records the pid.
- **Reattach is always verified.** Every `switch_session` is followed by `get_state` and the data-model checks; a mismatch is a visible stopped state, never a silent empty chat.
- **Mode changes and restarts share one path.** Approval mode change, Recover, and Stop-agent-then-reopen all go through `SessionAgent.restart()`.
- **Queue is OMP's queue.** Chips render from `queue_update`; Send now is `remove_queued_message` then `steer`.
- **Untrusted text everywhere.** Assistant text, tool output, and file contents render through the sanitiser or as plain text; links open externally.

## Phase 1 re-check (post-design)

The data model, contracts, and quickstart introduced no new process, network access, or renderer capability beyond those in the Constitution Check. `koffi` is a native module loaded only in main. The one constitution rule that needed evidence, Job Object versus survivors (Principle III), is now proven (FINDINGS items 10 and 12).

## Amendment 2026-10-06: Remove a repository

**Summary**: closes a data-loss gap in the existing `repositories.remove` IPC method (spec.md FR-059, Clarifications 2026-10-06): removal is now blocked while the Repository still owns any Session (active or archived), gets a real entry point and confirmation dialog in the session list, and the registry layer itself refuses to drop a Repository out from under a Session record instead of silently cascading that drop.

**Files to change**:
- `src/main/store/registry.ts` -- `removeRepository` refuses (throws a new `RegistryError` code) while the Repository owns any Session, instead of filtering `sessions` as a side effect.
- `src/main/ipc/repositories.ts` -- the `REPOSITORIES_REMOVE` handler checks the Repository's own Session count (not just running status) and returns the new `has-sessions` error before ever calling `removeRepository`.
- `src/shared/ipc.ts` -- `IpcErrorCode` drops `session-running` (its one caller is this handler) and adds `has-sessions`.
- `src/preload/index.ts` -- no signature change; `repositories.remove` keeps its existing `(id: string) => Promise<Result<void>>` shape.
- `src/renderer/state/repositories-store.ts` -- `remove` changes from `Promise<void>` to `Promise<boolean>` (a success flag), following the existing `add` → `Repository | null` pattern, so a dialog can tell whether to close itself; it still notifies and leaves state untouched on failure.
- `src/renderer/features/sessions/SessionList.tsx` -- `RepositoryGroup`'s header gains a third control: a "…" `DropdownMenu` (same component, same `EllipsisVerticalIcon` trigger and accessible-name pattern as `SessionRow`'s own menu) holding one destructive item, **Remove repository…**.
- `src/renderer/features/sessions/RemoveRepositoryDialog.tsx` (new) -- the confirmation dialog, built on `AlertDialog` like `DeleteDialog.tsx`, with the two states from Clarifications 2026-10-06.
- `specs/001-core-session-workspace/contracts/ipc.md`, `data-model.md`, `quickstart.md` -- documentation of the above (already amended with this plan update).

**Contract change**: `repositories.remove(id)` now errors `has-sessions` (replacing `session-running`) whenever the Repository still owns one or more Sessions, counted regardless of status; it never again errors solely because a Session merely happens to be running while every other Session of that Repository is already gone.

**Dialog/menu design**: the repository header's new "…" menu holds exactly one item, "Remove repository…" (destructive styling, matching the session row's "Delete…"), opening `RemoveRepositoryDialog`. With Sessions present, the dialog states the active and archived counts and offers only a way to close it -- no destructive action is rendered at all, rather than a disabled one, so there is nothing for a screen reader or a stray Enter press to activate by mistake. With none, it names exactly what happens (the Refract entry goes, the folder on disk does not) and offers Cancel / Remove, mirroring `DeleteDialog`'s Cancel / Delete footer. Focus: on open, trapped in the dialog per the existing `AlertDialog` behaviour; on cancel, back to the "…" trigger that opened it; on a successful removal, to another repository group's header trigger if one remains, else to the readiness screen's own first control (the whole workspace unmounts once `hasRepositories` goes false, per `App.tsx`'s existing `showReadiness = !ready || !hasRepositories`, so no new wiring is needed for the last-repository case -- it already falls out of that existing reactive condition). On failure, `notify()` as every other store method already does, with the repository left exactly as it was.

**Constitution check (re-run)**:

| Principle | Status | How this amendment meets it |
|---|---|---|
| I. OMP is the engine | Pass | No change to how OMP is launched or driven; removal never touches an `OmpProcess`. |
| II. RPC wire contract | Pass | Not touched. |
| III. Session and process lifecycle | Pass | Removal is refused whenever a Session (hence a possible live process) still exists for the Repository, so no live or reattachable agent can ever be orphaned by this flow. |
| IV. Evidence before design | Pass | No new OMP-facing behaviour; nothing to probe. |
| V. Electron security baseline | Pass | The new IPC method shape is the same typed, allowlisted `Result<T>` pattern as every other method; the renderer still never touches the registry or the file system directly. |
| Platform and Stack | Pass | No new dependency, no new process. |
| Development Workflow | Pass | Verified by running the app (quickstart.md Story 1), not an automated suite. |

No violations; the Complexity Tracking table stays empty.

## Amendment 2026-10-19: Delete leftover-files summary and worktree-held preflight

**Summary**: closes issue #891 (p1): Delete used to dead-end on a full, generated-file worktree (a `node_modules` tree with paths over 260 characters) or one still held open by a terminal or File Explorer window. The Delete dialog now runs a background leftover-files summary (from `git status`) as soon as it opens (spec.md FR-029, Clarifications 2026-10-19); before the agent is stopped, Refract preflights the worktree for a holder (Restart Manager, then a safe rename probe) and refuses rather than dead-ending; and the worktree's own removal is now `std::fs::remove_dir_all` (gate round 1: reversed from an earlier hand-rolled walker) behind Refract's own containment check, instead of `git worktree remove --force`.

**Files to change**:
- `src-tauri/src/fs/remove_tree.rs` (new) -- the containment gate (lstat refuses a link, canonicalises once, requires a strict-descendant match against the canonical worktrees root) wrapping `std::fs::remove_dir_all`, which replaces `git worktree remove --force` for this worktree's own files: handle-relative opens so a junction/symlink is never followed, no `MAX_PATH` limit, read-only cleared automatically (gate round 1 on PR #1038: reversed from an earlier hand-rolled `symlink_metadata`-per-entry walker to std's own implementation).
- `src-tauri/src/git/worktree_holders.rs` (new) -- the holder preflight: Windows Restart Manager naming a program and pid holding an open file (excluding this Session's own recorded `omp` pids from `process/pid_records.rs`), then, only if Restart Manager finds nobody, the safe rename-the-folder-and-back probe.
- `src-tauri/src/ipc/sessions_lifecycle.rs` -- registers the new `sessions.deleteLeftoverSummary(id)` channel (the background walk the dialog calls on open) and wires the holder preflight into `sessions.delete` ahead of stopping the agent, surfacing a refusal as the new `worktree-held` error code; `remove_session_worktree`'s own signature is unchanged (#476).
- `src/shared/ipc.ts` -- `IpcErrorCode` gains `worktree-held`; the `sessions` interface gains `deleteLeftoverSummary(id: string): Promise<Result<LeftoverSummary>>`.
- `src/renderer/features/sessions/DeleteDialog.tsx` -- fetches `deleteLeftoverSummary` alongside the existing `deleteCheck`, following the same cancelled-guard `useEffect` pattern, and renders the leftover-folders/other-files list with a "Checking files…" loading state; the existing `role="alert"` error paragraph is reused verbatim for a `worktree-held` refusal, and the confirm button relabels from Delete to Retry (gate round 1, ui-architect-v3).
- `specs/001-core-session-workspace/contracts/ipc.md` -- documents the new `sessions.deleteLeftoverSummary` channel and the `worktree-held` error code (already amended with this plan update).

**Contract change**: `sessions.deleteLeftoverSummary(id)` is a new, separate read-only channel (`Promise<Result<LeftoverSummary>>`, `LeftoverSummary = { generatedFolders: { name: string; fileCount: number }[]; otherFiles: string[]; moreCount: number }`) from the existing git-based `sessions.deleteCheck`; `sessions.delete`'s signature is unchanged (`Promise<Result<void>>`) and gains one new possible error code, `worktree-held`, alongside its existing codes.

**Dialog design**: `DeleteDialog.tsx` starts the leftover-files walk the instant it opens, independently of the existing uncommitted/unpushed check, and shows "Checking files…" until it resolves; Delete stays enabled throughout regardless of either check's own state, per spec.md FR-029. A `worktree-held` refusal from confirming Delete surfaces through the dialog's existing error paragraph, naming the holding program when Restart Manager found one, or the generic "close it, then Retry" wording when only the rename probe caught it; nothing is removed and the Session keeps running, so Retry is simply clicking Delete again, with no new control.

**Constitution check (re-run)**:

| Principle | Status | How this amendment meets it |
|---|---|---|
| I. OMP is the engine | Pass | No change to how OMP is launched or driven; the holder preflight never reads or ends a process, only names one via Restart Manager. |
| II. RPC wire contract | Pass | Not touched. |
| III. Session and process lifecycle | Pass | The holder preflight runs before the agent is stopped, so a refusal always leaves the Session's agent running, never orphaned mid-stop. |
| IV. Evidence before design | Pass | Grilled against the dead-ending code paths (`worktree_delete.rs:406-409`, `:554-589`) before design, per the 2026-10-19 grill. |
| V. Electron security baseline | Pass | `deleteLeftoverSummary` is the same typed, allowlisted `Result<T>` channel shape as every other method; the renderer still never walks the file system itself. |
| Platform and Stack | Pass | No new dependency; both new modules are plain Rust using existing Windows APIs already in use elsewhere in `src-tauri`. |
| Development Workflow | Pass | Verified by running the app (quickstart.md Story 6), not an automated suite. |

No violations; the Complexity Tracking table stays empty.

## Amendment 2026-10-23: Open stopped Sessions without starting the agent

**Summary**: closes issue #1205. Showing a stopped Session (a Session-row click, Ctrl+click into a Split, a notification click, or restoring saved panes at Refract start) no longer starts its agent. Its current Conversation is read from OMP's saved session file and shown through the normal transcript, with no `omp` process; a quiet "Agent stopped" bar above the composer offers **Start agent**, and sending a message starts the agent, waits for ready, then sends (spec.md FR-103 to FR-107, Clarifications 2026-10-23). The bar can be hidden with a new `showAgentStoppedBar` setting (Settings > Sessions, or **Don't show again** on the bar); the history-only behaviour cannot.

**Evidence (read-only probe, 2026-10-23)**:
- `src-tauri/src/ipc/sessions_agent.rs:45-65` (`can_auto_start`) and `:383-407` (`attach_snapshot_decision`) start the agent on a passive open; the passive path returns `conversations::build_snapshot` (`:439-460`) without loading any history. All renderer passive paths funnel through `ChatPane.tsx`'s snapshot effect (`useSessionsStore.getState().open(sessionId)`, about line 511); `MessageInput.tsx` already sends with `open(sessionId, true)` (about line 515). The renderer mirror is `ChatPane.tsx:205` (`canAutoStartSession`).
- `src-tauri/src/ipc/conversations.rs:47-93` (`build_snapshot`) returns `agent.runtime_view()`, whose transcript only a live agent fills. TS shapes: `SessionSnapshot` at `src/shared/ipc.ts:224-236`, `SessionRuntimeView.transcript` at about `:200-220`.
- `src-tauri/src/omp/transcript.rs` `TranscriptState::from_history` (about `:1642-1708`) already builds `TranscriptItem`s from OMP message objects (roles `user`/`assistant`/`toolResult`, `toolCall` content parts).
- `Session.session_dir` and `Session.current_conversation` (`src-tauri/src/store/registry.rs:35-44`) locate the `.jsonl`; `conversations.rs`'s `read_conversation_file` already reads its `type: "title"` line and `type: "message"` records with a nested `message.role`, per `omp://session.md` "File Format".
- Not confirmed: the full record format on a real file (no session file was on the probe machine), including whether a file can hold more than one branch (`id`/`parentId`), a FINDINGS open item. Per constitution Principle IV this is the first task, and the result is recorded in `docs/spike/FINDINGS.md`.

**Files to change**:
- `src-tauri/src/session/saved_history.rs` (new) -- reads the current Conversation's `.jsonl` (bounded, line by line, malformed lines skipped, as `read_conversation_file` does), collects the `message` objects, and returns `TranscriptState::from_history(&messages)` items. A new module because `sessions_agent.rs` (582 lines) and `transcript.rs` (baseline 1,813) are at or over the 600-line cap (#806).
- `src-tauri/src/ipc/sessions_agent.rs` -- `attach_snapshot_decision` starts only on `force_start` (`userAction: true` or `sessions.recover`); `can_auto_start` stays for choosing the stop banner.
- `src-tauri/src/ipc/conversations.rs` -- `build_snapshot` injects the saved-history items into `runtime.transcript` when the agent stays stopped, and reports a missing or empty file the same way the reattach path does (FR-024).
- `src-tauri/src/session/start_queue.rs` -- reused unchanged for the explicit start; the queued send waits on its ready signal (no new queue).
- `src-tauri/src/store/agent_stopped_bar.rs` (new, beside `chat_width.rs`/`holiday_touches.rs`), `src-tauri/src/store/settings.rs`, `src-tauri/src/ipc/settings.rs` -- the `showAgentStoppedBar` field (default `true`, absent reads `true`) and `settings.setShowAgentStoppedBar`.
- `src/shared/model.ts`, `src/shared/ipc.ts` -- `Settings.showAgentStoppedBar`, the new setter channel; `pnpm check:parity` covers the Rust side.
- `src/renderer/features/chat/AgentStoppedBar.tsx` (new) -- the bar ("Agent stopped", **Start agent**, **Don't show again**), built from shared `components/ui` primitives; not a live region.
- `src/renderer/features/chat/ChatPane.tsx` -- mounts the bar, drops `canAutoStartSession`'s role in deciding the "Starting agent" notice (shown only while a start runs), and announces the start once. It is a cap-exempt offender (baseline 1,445), so it must not grow: extract a block to stay at or under the baseline.
- `src/renderer/features/chat/MessageInput.tsx` -- sending to a stopped Session keeps the draft until the agent is ready, then sends (already `open(sessionId, true)`).
- `src/renderer/features/settings/SessionsSection.tsx` (new), `SettingsScreen.tsx`, `src/renderer/state/view-store.ts` -- the Settings > Sessions section and its `SettingsSectionId`.
- `specs/001-core-session-workspace/contracts/ipc.md`, `data-model.md`, `quickstart.md` -- already amended with this plan update.

**Contract change**: `sessions.open(id, userAction?)` keeps its signature and `SessionSnapshot` shape; a passive call never starts the agent and, for a stopped Session, fills `runtime.transcript` from the saved file. New `settings.setShowAgentStoppedBar(value: boolean): Promise<Result<Settings>>`; `Settings` gains `showAgentStoppedBar: boolean`.

**Constitution check (re-run)**:

| Principle | Status | How this amendment meets it |
|---|---|---|
| I. OMP is the engine | Pass | Reading the saved file is a read-only display of a stopped Session; no behaviour OMP exposes over RPC is reimplemented, because there is no process to ask. Once the agent starts, `get_messages` stays the source of truth. |
| II. RPC wire contract | Pass | Not touched; the queued send still waits for ready before `prompt`. |
| III. Session and process lifecycle | Pass | Fewer processes: no `omp` starts on a passive open. The explicit start uses the existing `switch_session` reattach and its verification unchanged. |
| IV. Evidence before design | Pass, with a gate | The session-file record format is confirmed on a real file and recorded in `docs/spike/FINDINGS.md` before the reader is built (first task of tasks.md Phase 78). |
| V. Tauri security baseline | Pass | One new typed, allowlisted `Result<T>` setter; the renderer never reads the file system. |
| Platform and Stack | Pass | No new dependency. |
| Development Workflow | Pass | Verified by running the app with the fake-omp harness (`scripts/verify-tauri.mjs`), no new tests (prototyping phase). |

No violations; the Complexity Tracking table stays empty.

## Complexity Tracking

None.
