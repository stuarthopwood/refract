# Implementation Plan: Checklist data model and per-Session store (#2011)

**Branch**: `feat/2011-checklist-store` | **Date**: 2026-11-19 | **Spec**: [spec.md](./spec.md)
**Input**: spec 138; protocol in [ADR 0011](../../docs/adr/0011-checklist-protocol.md) and [the design](../../docs/design/checklist-protocol.md).

## Summary

A new Rust module tree `src-tauri/src/checklist/` owns the Checklist model, the per-Session store, the agent and developer op engines, the change record and the result shaping. A thin `agent_tools/checklist*.rs` pair registers and serves `refract_checklist`; a thin `ipc/checklist.rs` serves `checklist.get` and `checklist.mutate` and emits `checklist:update`. `src/shared/checklist.ts` mirrors the types for the renderer. A golden JSON fixture ties both sides together. The notice slot becomes a list so the checklist hint and Conversation line can ride the agent's next prompt. No panel, control, chat card or envelope code is written here (#2012 to #2014).

No `research.md` or `data-model.md`: every open question is closed in spec.md Clarifications from the ADR, the design and the code, and the entity shapes are the design's schema sketch (design lines 374-433), tabulated under Data model below.

## Technical Context

- Rust (Tauri v2 backend, tokio), TypeScript (React renderer, vitest). Serde camelCase. JSON files via `store/atomic_json.rs` (`read_json_file` at line 14, `write_json_file` at line 49).
- Tests: co-located `*.test.rs` through `#[path]` (as `agent_tools/mod.rs:124-126`); TS `*.test.ts`. Run once at the end by the controller (`pnpm ci:local`, cargo test), never mid-plan; this lane runs neither.
- Constraints: 600-line cap per file (`scripts/file-size-baseline.json` is a shrinking allowlist; nothing new may enter it); why-only comments; `MAX_RESULT_BYTES` 8192 (`agent_tools/mod.rs:31`).

## Constitution / AGENTS.md check

| Rule | How this plan meets it |
|---|---|
| Grill first | Written grill in spec.md Clarifications, each Decided (Skippy, delegated by Stuart 2026-11-19) |
| Full Spec Kit order | specify, clarify (in spec), plan, tasks, analyze done; implement is a later lane |
| 600-line cap | Module budget below; most files under 300 lines |
| Testing V1 | Each task in tasks.md names its co-located test file and the guard-mutation proof |
| Comments say why | Stated in every task's constraints |
| Safe deletion | The only deletion in code is the checklist file at Session delete, by the registry id, behind the lock |
| Stacked PRs | One `gh stack` PR for this docs lane; implementation is its own lane |

## Module layout and line budget

| File | Purpose | Budget |
|---|---|---|
| `src-tauri/src/checklist/mod.rs` | module list, re-exports | 40 |
| `checklist/model.rs` | types, enums, constants (caps), checklist file struct | 260 |
| `checklist/validate.rs` | byte caps, character rules, id syntax | 150 |
| `checklist/ids.rs` | counters and id formatting | 60 |
| `checklist/ops.rs` | `ChecklistOp`, op decoding and shared apply helpers (`rev`, stamping, `previousStatus`) | 280 |
| `checklist/agent_ops.rs` | agent authority rules and all-or-none apply | 330 |
| `checklist/developer_ops.rs` | developer apply, `item_changed`, `lastDeveloperOps` | 260 |
| `checklist/create.rs` | `create`, archive, replace, archive cap, `requestId` | 220 |
| `checklist/changes.rs` | `userChanges`, `removed`, `agentSeenRev`, `issuedSeenRev` | 240 |
| `checklist/result.rs` | compact item, byte-budgeted results and errors | 300 |
| `checklist/store.rs` | per-Session store, lock, clone-apply-write-swap, tombstone | 330 |
| `checklist/store_load.rs` | read, version refusal, quarantine, `.tmp` sweep | 160 |
| `checklist/records.rs` | send records, `pendingComplete` primitives | 260 |
| `checklist/hint.rs` | checklist hint and Conversation line text | 120 |
| `checklist/fixtures/checklist-v1.json` | golden fixture | 80 |
| `src-tauri/src/agent_tools/checklist_tool.rs` | `refract_checklist` handler (detached apply, approval card) | 280 |
| `agent_tools/checklist_schema.rs` | tool name, description, parameters JSON | 200 |
| `src-tauri/src/ipc/checklist.rs` | `checklist.get`, `checklist.mutate`, `checklist:update` | 200 |
| `src/shared/checklist.ts` | TS mirror, constants | 220 |

Each Rust file has a sibling `*.test.rs` of at most 600 lines; `result.test.rs` and `agent_ops.test.rs` split into two files if they near the cap. Existing files touched are `agent_tools/mod.rs` (126 lines), `router.rs`, `router_native.rs`, `agent_tools/mod.test.rs`, `overlay` golden, `events.rs`, `ipc/mod.rs`, `delete_in_flight.rs`, `session/agent/handoff_queue.rs`, `session/agent/chat.rs`, `session/agent/launch.rs`, `session/agent/conversations.rs`, `scripts/check-parity.mjs`, the renderer `tauri-bridge` and the renderer IPC types. T001 records the line count of every touched file before any edit; one at or over 540 lines is split first, in its own commit, before the checklist code lands.

## Data model

`ChecklistFile { version: 1, nextChecklistSeq, active: Checklist | null, archived: Checklist[] (at most 5, no values), sendRecords: SendRecord[] (at most 500), pendingComplete: PendingComplete[] }`.

`Checklist { id, title, rev, nextItemSeq, agentSeenRev, issuedSeenRev, createdAt, items: ChecklistItem[] (at most 40), removed: RemovedEntry[] (at most 40), recentRequests: RecentRequest[] (at most 16) }`.

`ChecklistItem { id, text, status, previousStatus?, owner, requiresValue, value?, valueBy?, agentCompletable, group?, rev, statusRev, createdBy, updatedBy, completedBy?, editedByDeveloper, lastDeveloperOps: { kind, rev, fields }[] }`.

Enums: `ItemStatus = upcoming | next | in_progress | blocked | complete`; `ItemOwner = agent | human | either` (chosen per item by the agent in `create` and `add`, default `agent`; a developer `add` defaults to `human`; fixed after creation); `Actor = agent | developer`.

## Design notes that decide the shape

1. **Pure engines, thin I/O.** Ops are pure functions `(Checklist, Op, Actor) -> Result<Checklist, ChecklistError>` over a clone; only `store.rs` does I/O. Error and result shaping read the checklist, not the store, so every byte-budget test needs no filesystem.
2. **One store, two callers.** The agent handler and the IPC handler both call `ChecklistStore::apply(session_id, request)`; they differ only in the engine they select, so the lock, write and event paths cannot drift.
3. **Event after write.** `checklist:update` is emitted by the store caller after the swap; a failed write emits nothing.
4. **Counters, not scans.** `nextChecklistSeq` and `nextItemSeq` are persisted fields (spec Clarifications).
5. **Detached apply.** The handler spawns the apply as its own task and awaits the handle, so a cancelled `host_tool_call` cannot cancel a half-run apply.
6. **Registry first.** `ChecklistStore` has no `get_or_create(sessionId)` for a caller string; it takes a `LiveSession` witness produced by the registry check, so the file path is built only from a registry id.
7. **Hint and line are text builders** (`hint.rs`); they get checklist data and return a string with ids and op names only.

## Integration points (all from the design, re-verified by the named task)

- `agent_tools/mod.rs:65-74` `tools_for`; `host_tool_defs` checklist branch; `router.rs` arm (`Plan::Native`); `router_native.rs` `run_native` arm before the `sessions_send::send` fallthrough; overlay golden string; `agent_tools/mod.test.rs` counts. Task T020.
- `ipc/agent_tools.rs:11-12` is the precedent for registering request kinds; `ipc/checklist.rs` registers `checklist.get` and `checklist.mutate` the same way. T019 and T021.
- `events.rs:30` `READOUT_UPDATE` is the precedent for `CHECKLIST_UPDATE`. T021.
- `delete_in_flight.rs` `is_deleting` (line 26) and the `remove()` order that follows `remove_agent`. T022.
- `session/agent/handoff_queue.rs:73` (`take`) and `:297` (`tell_agent_why` writer), `chat.rs:140`, `launch.rs:198`, `conversations.rs:79,189` are every writer or reader of `pending_agent_notice`; the list change touches exactly these and their tests. T023.

## Test plan (Testing V1)

Each module's tests are co-located and each guard is proven by mutation (remove the guard, watch the test fail, restore). Names are in tasks.md. Cross-cutting tests: the property test of completed-item survival (`agent_ops.test.rs`), the worst-case byte-budget tests (`result.test.rs`), the golden fixture test on both sides (`model.test.rs`, `checklist.test.ts`), and the path-traversal test (`store.test.rs`). The live checks are T025 and T026, run by the controller with a fake omp; they are not unit tests.

## Risks

- **Model compliance** (the agent must use `refract_checklist` and quote `seenRev`): accepted by ADR 0011; the description is tested for the exact required sentences.
- **Hash crate**: T016 checks `Cargo.toml` before use; Decisions for Stuart (6).
- **Design lines cited against `dd56b639`**: T001 re-reads every cited design line and the `origin/main` anchors; a mismatch is raised on #2010, not patched silently here.
- **Plan-mode callability**: unknown until T026.

## Complexity

No constitution violation. The one structural cost is the new `checklist/` tree (12 source files plus tests); the alternative, one large file, breaks the 600-line cap.
