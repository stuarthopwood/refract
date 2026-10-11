# Implementation Plan: Side chat (`/btw`)

**Branch**: `014-side-chat` (docs); implementation lands on issue-named branches per slice, e.g.
`feat/1-516-side-chat-shell`, `feat/1-516-side-chat-rpc`, `feat/1-516-side-chat-polish`, per
`docs/PLAN.md`'s existing convention | **Date**: 2026-10-11 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/014-side-chat/spec.md`

## Summary

Add a fourth right-pane tenant, `side-chat`, hosted by spec 013's existing shell with no shell
changes beyond `panel-registry.ts`'s own descriptor list. Each Session gets one side-chat thread,
sent over OMP's native `btw` RPC (confirmed live, FINDINGS item 14) rather than the bundled
`runEphemeralTurn` extension issue://1 originally scoped -- that extension route is dropped
entirely per issue://516/Stuart's 2026-10-07 decision. `/btw <question>` typed in the main composer
is intercepted locally (same tier as the existing `/new` handling), opens and focuses the panel,
and sends the question as a real `btw` request instead of being silently refused. This is the
first spec to amend the constitution rather than merely read it: Principle I drops `/btw` from the
"supplies natively" list (no longer absent over RPC), Principle II replaces the extension-based
rule with the native RPC contract, and Principle IV raises the minimum supported OMP version to
18.6.3. Design rationale is in [research.md](research.md); the new IPC trio and event are in
[contracts/ipc.md](contracts/ipc.md).

## Technical Context

**Language/Version**: TypeScript (`strict: true`) on Node 24.21.0 as bundled by Electron 44.5.1;
React 19.3.0 in the renderer. Same stack as spec 013; no new runtime added.

**Primary Dependencies**: none new. `lucide-react` (already the only icon import) supplies
`MessageCircleIcon`; the existing shared `Markdown`/`CodeBlock` components render the answer
(constitution V); no new npm package.

**Storage**: none added. OMP's own `get_btw_history` sidecar is the single source of truth for
anything older than the current app run (research.md decision 6, spec.md FR-004); `settings.json`
gains no new field (research.md decision 7: neither issue asks for a toggle).

**Testing**: none. Refract is a prototype (constitution, Development Workflow); each story is
verified by running the app per [quickstart.md](quickstart.md), including a live `btw` round trip
against a real OMP 18.6.3+ process. `pnpm typecheck` and `pnpm build` must pass before a change
lands on `main`.

**Target Platform**: Windows 11 only.

**Project Type**: desktop-app (Electron: main, preload, renderer) -- extends spec 013's right-pane
shell and spec 001's RPC/IPC plumbing; adds no new process type.

**Performance Goals**: from the spec: a side question never changes the main transcript's message
count (SC-001); the panel restores a Session's full thread from `get_btw_history` with zero new
requests after a restart (SC-002).

**Constraints**: `/btw` must never be forwarded as a `prompt` RPC request under any code path
(FR-002, FR-007; constitution II) -- the existing `chat.ts` main-process guard
(`NATIVE_RESERVED_COMMANDS.btw`) already refuses it defensively and is left unchanged as the
second layer, with the renderer-side interception in `MessageInput.tsx` as the primary path (same
two-layer shape `/new` already has). Streaming (`btw_delta`) has never been observed live
(FINDINGS item 14) -- every story must be correct from the terminal `btw_record` alone (spec.md
Edge Cases).

**Scale/Scope**: one new renderer-only store (`side-chat-store.ts`, per-Session keyed, mirroring
`subagent-store.ts`'s shape), one new IPC request trio plus one new event and their main/preload/
shared plumbing, two new frame types (`BtwDeltaFrame`/`BtwRecordFrame`), one new hosted-panel
descriptor and component, one `NATIVE_BUILT_COMMANDS` entry, one constitution amendment (three
principles), one OMP-minimum-version doc update, 14 functional requirements across 5 user stories.

## Constitution Check

*GATE: passes before Phase 0; re-checked after Phase 1 design. Constitution v1.9.0 (this spec
raises it to v2.0.0 -- a Principle change, not an additive clause, per Governance's own versioning
rule).*

| Principle | Status | How the design meets it |
|---|---|---|
| I. OMP is the engine | Pass, WITH amendment | `/btw` is removed from the "supplies natively" list (research.md decision 3): it is no longer a command Refract reimplements behaviour for, only a client UI for the now-real `btw` RPC command, the same relationship already held with `/new`/`/resume`. |
| II. RPC wire contract | Pass, WITH amendment | The old three-line `runEphemeralTurn`/`btw-ext.ts` rule is replaced with the native `btw`/`btw_cancel`/`get_btw_history`/`btw_delta`/`btw_record` contract (exact wording below). Cites FINDINGS item 14 (Governance's own citation requirement for a Principle II/III change). |
| III. Session and process lifecycle | Pass (not applicable) | No Session, worktree, or process-spawn lifecycle is touched; `btw` requests ride the Session's existing OMP process, same connection every other RPC command already uses. |
| IV. Evidence before design | Pass, WITH amendment | Minimum supported OMP version raised to 18.6.3, citing FINDINGS item 14 (live `btw` confirmation on 18.8.0) and the already-recorded B5 decision (18.6.3 itself untested on this machine; 18.8.0-only verification accepted as sufficient, Stuart 2026-10-09). `btw_delta`'s shape is flagged UNVERIFIED in data-model.md/research.md (Principle IV's own "labelled unverified in the spec that relies on it" escape hatch) since it was never observed live. |
| V. Electron security baseline | Pass | The new IPC trio (`sideChat.ask`/`cancel`/`getHistory`) follows the existing typed, allowlisted `contextBridge` pattern (contracts/ipc.md); the answer renders through the existing sanitising `Markdown` component, never raw HTML. |
| Platform and Stack | Pass | Windows 11 only; Electron + Vite + React, strict TypeScript. |
| Development Workflow | Pass | Spec Kit order (this plan → `/speckit.tasks`); no automated tests; typecheck and build gate; verified by running the app (quickstart.md) against a live OMP 18.6.3+ process. |

**Exact constitution wording (this spec's own amendment, applied in the docs-only PR, not a later
implementation PR)**:

- Principle I, the "supplies natively" bullet: `/plan`, `/fork`, `/resume`, `/new`, `/settings`,
  `/pause`, `/plan-review` (drop `/btw`).
- Principle II, replacing the three-line `/btw`/extension bullet: "Side chat (`/btw`) goes through
  OMP's native RPC: `{type: "btw", question, recordId?}` runs one ephemeral turn over the current
  session context with no tool use and never enters the main transcript; `btw_cancel` stops a
  running one; `get_btw_history` lists a Session's own records, persisted by OMP across restart;
  answers stream as `btw_delta` (unverified live, FINDINGS item 14) and settle at a terminal
  `btw_record` (`complete`/`cancelled`/`error`/`interrupted`). Refract MUST NEVER forward literal
  `/btw ...` text as a prompt; it parses the composer's own `/btw <question>` and issues the native
  request instead."
- Principle IV, the version bullet: "The minimum supported OMP version is 18.6.3 (verified live
  only on 18.8.0, FINDINGS item 14; 18.6.3/18.7.x themselves have no binary available on this
  machine to test directly -- Stuart, 2026-10-09, accepted the 18.8.0-only verification as
  sufficient to set this minimum)."

No other violation; the Complexity Tracking table below is otherwise empty.

## Project Structure

### Documentation (this feature)

```text
specs/014-side-chat/
├── spec.md
├── plan.md                   # this file
├── research.md                # 8 decisions, 1 explicitly UNVERIFIED (btw_delta shape)
├── data-model.md              # SideChatRecord, BtwDeltaFrame/BtwRecordFrame, SideChatThreadState
├── quickstart.md              # how to run and verify each story, incl. a live btw round trip
├── contracts/
│   └── ipc.md                 # sideChat.ask/cancel/getHistory, SIDE_CHAT_PATCH
├── checklists/requirements.md
├── future/open-questions.md   # 4 carved-out items (shortcut, Use as context, cost display, pagination)
└── tasks.md                    # produced by /speckit.tasks
```

### Source code (repository root, additions to spec 013's layout)

```text
.specify/memory/
└── constitution.md                              # EDIT: Principles I, II, IV (above); version bump
docs/
└── (OMP-minimum-version doc, wherever Principle IV's claim is echoed outside the constitution
    itself -- e.g. the readiness check's own version-gate message, if one names 18.4.x/18.5.x
    literally; confirm the exact string during Slice 1's own grounding, not assumed here)
src/shared/
├── frames.ts                                    # EDIT: BtwDeltaFrame, BtwRecordFrame, KnownFrame union
├── ipc.ts                                       # EDIT: IPC_REQUESTS.SIDE_CHAT_*, IPC_EVENTS.SIDE_CHAT_PATCH, RefractApi.sideChat
└── slash-commands.ts                            # EDIT: NATIVE_BUILT_COMMANDS gains `btw`
src/main/
├── omp/
│   └── SessionAgent.ts                          # EDIT: askSideChat/cancelSideChat/getSideChatHistory, forward btw_delta/btw_record as SIDE_CHAT_PATCH
└── ipc/
    └── side-chat.ts                              # NEW: registerSideChat(manager), mirrors subagents.ts's own shape
src/renderer/
├── state/
│   ├── side-chat-store.ts                        # NEW: SideChatThreadState (data-model.md)
│   └── index.ts                                  # EDIT: export useSideChatStore
├── features/
│   ├── right-pane/
│   │   ├── panel-registry.ts                     # EDIT: PanelId gains 'side-chat'; HOSTED_PANELS gains the descriptor
│   │   ├── RightPaneShell.tsx                     # EDIT: one more activePanelId === 'side-chat' branch
│   │   └── side-chat/
│   │       └── SideChatPanel.tsx                  # NEW: thread list + composer + Cancel/Retry/Copy/Clear actions
│   └── chat/
│       └── MessageInput.tsx                       # EDIT: intercept /btw before chat.send, same tier as /new
└── preload/
    └── index.ts                                   # EDIT: refract.sideChat.{ask,cancel,getHistory}, refract.onSideChatPatch
docs/PLAN.md                                       # EDIT: row C2 status only (this story's own row)
```

## Design overview

### Build order and dependencies on other specs

Three slices, same reasoning spec 013 used (shell/hosting first so every later slice has
something real to host; RPC wiring second since the shell can ship with a visible-but-inert panel
in between; UI polish last):

1. **Shell/hosting** (spec 013's own panel-registry pattern): `PanelId`/`HOSTED_PANELS` additions,
   `RightPaneShell.tsx`'s new branch, an empty `SideChatPanel.tsx` shell (composer + empty-thread
   state, no RPC wiring yet) -- independently verifiable: the rail icon appears, the panel opens,
   nothing crashes.
2. **RPC wiring**: `side-chat-store.ts`, the IPC trio + event, `SessionAgent.ts`'s `btw`/
   `btw_cancel`/`get_btw_history` methods, frame handling. This slice is where the constitution and
   OMP-minimum-version docs amendment actually takes effect in running code (the readiness gate's
   own version check, if any, starts enforcing 18.6.3 here).
3. **UI polish**: `/btw` composer interception (`MessageInput.tsx`, `NATIVE_BUILT_COMMANDS`), Copy/
   Clear-thread actions, Cancel/Retry, the live-region announcement (FR-012), focus management
   (FR-013).

Depends on spec 013 (the shell itself, merged -- #665). No other spec depends on this one yet.

## Phase 1 re-check (post-design)

No new violation surfaced while writing data-model.md/contracts/ipc.md; the Constitution Check
above stands unchanged from the pre-design pass.

## Complexity Tracking

None -- the Constitution Check above has three WITH-amendment rows (expected and pre-authorised by
both issues' own top-of-body decision) and no unresolved violation.
