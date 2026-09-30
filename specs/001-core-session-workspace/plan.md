# Implementation Plan: Core session workspace

**Branch**: `001-core-session-workspace` (no branch created; work lands on `main`) | **Date**: 2026-09-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-core-session-workspace/spec.md`

## Summary

Build the first usable slice of Pinion: an Electron desktop app whose left pane lists Repositories and their Sessions (one git worktree each) and whose centre pane chats with the OMP coding agent. Each Session runs its own `omp --mode rpc-ui` child process in its worktree; Pinion normalises OMP's frame stream into a transcript, answers approvals and questions, queues follow-ups, reattaches saved Conversations after restarts, and keeps every agent inside a kill-on-close Windows Job Object. Design rationale and probe results are in [research.md](research.md); the two interface contracts are in [contracts/](contracts/).

## Technical Context

**Language/Version**: TypeScript (`strict: true`) on Node 24.21.0 as bundled by Electron 44.5.1; React 19.3.0 in the renderer.

**Primary Dependencies**: `electron` 44.5.1, `electron-vite` 5.0.0, `react` 19.3.0, `zustand` 5.0.15, `react-markdown` 10.1.0 + `rehype-sanitize` 6.0.0, `shiki` 4.4.3 (JS engine), `react-diff-view` 3.3.3, `react-virtuoso` 4.18.16, `react-resizable-panels` 4.14.1, `tailwindcss` 4.3.3, `shadcn/ui` (CLI `shadcn` 4.21.0; components copied into `src/renderer/components/ui/` and owned by the repository), `koffi` (Windows Job Object; version chosen at install).

**Storage**: three JSON files in `userData` (`registry.json`, `settings.json`, `processes.json`), atomic writes. Conversations are OMP's own files, not copied.

**Testing**: none. Pinion is a prototype (constitution, Development Workflow); each story is verified by running the app per [quickstart.md](quickstart.md). Typecheck and production build must pass before a change lands on `main`.

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
| III. Session and process lifecycle | Pass | No `--session-dir`; cwd is the worktree; reattach by `--resume` or `switch_session` with `get_state` verification; main process joins a kill-on-close Job Object at start plus pid-and-start-time fallback; stdin close then `taskkill /T /F` (research 3, 4). |
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
│   ├── omp-usage.md     # how Pinion uses OMP's RPC
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
│   └── frames.ts              # the subset of OMP frame types Pinion reads
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
│   └── index.ts               # contextBridge: window.pinion
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
- **One job, joined at start.** `jobObject.ts` creates the kill-on-close job once and assigns Pinion's own main process to it before anything is spawned; every `omp` inherits it. `OmpProcess` only records the pid.
- **Reattach is always verified.** Every `--resume` or `switch_session` is followed by `get_state` and the data-model checks; a mismatch is a visible stopped state, never a silent empty chat.
- **Mode changes and restarts share one path.** Approval mode change, Recover, and Stop-agent-then-reopen all go through `SessionAgent.restart()`.
- **Queue is OMP's queue.** Chips render from `queue_update`; Send now is `remove_queued_message` then `steer`.
- **Untrusted text everywhere.** Assistant text, tool output, and file contents render through the sanitiser or as plain text; links open externally.

## Phase 1 re-check (post-design)

The data model, contracts, and quickstart introduced no new process, network access, or renderer capability beyond those in the Constitution Check. `koffi` is a native module loaded only in main. The one constitution rule that needed evidence, Job Object versus survivors (Principle III), is now proven (FINDINGS items 10 and 12).

## Complexity Tracking

None.
