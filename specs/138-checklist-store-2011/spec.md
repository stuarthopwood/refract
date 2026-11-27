# Feature Specification: Checklist data model and per-Session store

**Feature Branch**: `feat/2011-checklist-store`
**Created**: 2026-11-19
**Status**: Clarified
**Input**: GitHub issue #2011 (P0, `feature`, child of epic #2015). Builds on the decided protocol spike #2010 ([ADR 0011](../../docs/adr/0011-checklist-protocol.md), [design](../../docs/design/checklist-protocol.md)). Route: specify. The grill ran as a written step because Stuart is away (see Clarifications). The panel (#2012), per-item controls (#2013) and chat card (#2014) are out of scope; the model must serve them.

## Clarifications

Evidence citations are `file:line` as read in this worktree (`origin/main` at `f1e2ac62`), or "design" for a line of `docs/design/checklist-protocol.md`; design citations were made against `dd56b639` and are re-verified by the task named in plan.md before each is relied on.

### Session 2026-11-19

- Q: Which slice of the protocol does #2011 build, and which does #2013 build? -> A: Decided (Skippy, delegated by Stuart 2026-11-19): #2011 builds everything that is Rust-side checklist state: the shared TS and Rust types, the per-Session store, the op engine (agent and developer), the result and error shaping, the `refract_checklist` tool (schema, registration, handler), the `checklist.get` and `checklist.mutate` IPC requests, the `checklist:update` event, the delete hook, the notice hint and the send-record and `pendingComplete` store primitives. #2013 builds what needs the generalised envelope and the chat send path: `checklist.itemMessage`, `send_checklist_item`, the `<checklist-item>` envelope, the `chat.rs` send, `stop` and settle wiring that calls the lifecycle primitives, and the transcript pass. Basis: design "What each child builds" (rows #2011 and #2013) lists send records and `pendingComplete` under #2011 and `send_checklist_item` and the generalised envelope under #2013; `envelope.rs:6-11` knows only `session-message`, so a send path cannot exist before #2013. #2011 ships the primitives with tests; #2013 only wires them. See Decisions for Stuart (1).
- Q: What are the item and checklist id schemes? -> A: Decided (Skippy, delegated by Stuart 2026-11-19): checklist ids `p1`, `p2`, ... and item ids `i1`, `i2`, ... from per-store `nextChecklistSeq` and per-checklist `nextItemSeq` counters that only rise; ids are never reused, so a removed id stays retired; ids are per Session (design "Session binding and isolation", "Authorship"). The counters are persisted, never derived from the current item list, because deriving would reuse the highest removed id.
- Q: What are the item field names? -> A: Decided (Skippy, delegated by Stuart 2026-11-19): exactly the schema sketch keys of the design (`id`, `text`, `status`, `previousStatus`, `owner`, `requiresValue`, `value`, `valueBy`, `agentCompletable`, `group`, `rev`, `statusRev`, `createdBy`, `updatedBy`, `completedBy`, `editedByDeveloper`, `lastDeveloperOps`), camelCase on the wire and in the file. The issue's "who it belongs to" is `owner`. Basis: design lines 374-433 say the keys are the protocol's contract and #2011 owns final names; keeping them avoids a rename in #2012 to #2014.
- Q: What are the values of `owner`? -> A: Decided (Skippy, delegated by Stuart 2026-11-19; amended by Stuart 2026-11-20, see Session 2026-11-20): `agent`, `human`, `either` (the issue says "agent / human / either"). The agent chooses `owner` per item: the items of its `create` and its `add` op carry an explicit `owner`, and when it is omitted it defaults to `agent`. An item the developer adds defaults to `human`; `either` is set explicitly. The agent can complete `agent` and `either` items only; `human` items it cannot complete (`human_owned`, design "Authorship"). The developer can tick any item.
- Q: What are the status transitions? -> A: Decided (Skippy, delegated by Stuart 2026-11-19): five statuses `upcoming`, `next`, `in_progress`, `blocked`, `complete`, never merged (design "Status lifecycle"). No transition graph beyond who may set what: the developer may set any status on any item; the agent may set `upcoming`, `next`, `in_progress`, `blocked` on any item it may edit, and `complete` only under the Authorship rules. Moving into `complete` stores the prior status in `previousStatus`; untick restores it, falling back to `upcoming` when none is stored; moving into any other status leaves `previousStatus` alone. `statusRev` is the checklist `rev` of the item's last accepted status change by either party.
- Q: What is the merge rule for an agent update that must preserve completed items and their values? -> A: Decided (Skippy, delegated by Stuart 2026-11-19): there is no merge. An agent `update` is a list of at most 20 ops, each addressing an item by id, applied all or none. Completed items are frozen for the agent (`edit`, `move`, `remove`, `setValue` and any `setStatus` fail with `item_complete`), whoever completed the item. Only the developer reopens a completed item, which restores `previousStatus`. A value is never overwritten by an agent when `valueBy` is `developer`. The only way several items are retired at once is `create` with `replace: true`, which archives the checklist (values dropped from the archive) and, when the active checklist holds an unfinished developer-owned item, raises a card that is not skipped in yolo (design "Approval"). This satisfies the issue's acceptance "agent updates leave completed items and their values intact" as a property of the op engine, tested by a property test over random op sequences (FR-005).
- Q: Where is the checklist persisted, and in what format? -> A: Decided (Skippy, delegated by Stuart 2026-11-19): `<data_dir>/checklists/<sessionId>.json`, one JSON file per Session, written only by Rust with `store/atomic_json.rs` (`write_json_file`, temp file, fsync, rename, `atomic_json.rs:49`) and read with `read_json_file` (`atomic_json.rs:14`, quarantines an unparseable file). `sessionId` is the id the live registry returns, never the caller's string. Basis: design "Persistence" and "Session binding and isolation".
- Q: What are the size caps? -> A: Decided (Skippy, delegated by Stuart 2026-11-19): the design table, unchanged: item `text` 200 bytes, checklist `title` 120, item `group` 60, item `value` 1 KiB, `checklist.itemMessage` body 4 KiB (enforced by #2013 from the shared constant), 40 items per checklist, 5 archived checklists per Session, 20 ops per `update`, `requestId` 64 bytes, 500 send records, 40 `removed` entries, 16 `recentRequests`. UTF-8 bytes, not characters. `text`, `title` and `group` reject control characters (including U+2028 and U+2029, which `char::is_control` does not cover, design "Complete-this-step"); `value` rejects control characters other than newline and tab. The worst-case result arithmetic (7,037 of 7,168 of 8,192 bytes) depends on these exact numbers, so a cap change is a design change.
- Q: What happens when the file's `version` is not 1 (migration)? -> A: Decided (Skippy, delegated by Stuart 2026-11-19): version 1 is the first and only version; there is no migration code in this slice. A file with a higher `version` is not parsed as v1 and not quarantined: the store refuses to load it (`store_unsupported`), writes nothing and leaves the file untouched, so a downgrade never destroys a newer file. A file that does not parse, or lacks `version`, is quarantined by `read_json_file` as for every other Refract store. The first real schema change adds its own migration in its own spec. See Decisions for Stuart (2).
- Q: How is the model mirrored between Rust and TypeScript? -> A: Decided (Skippy, delegated by Stuart 2026-11-19): Rust is the source of truth (`serde`, camelCase); TS types are hand-written in `src/shared/checklist.ts` (no code generation exists in this repo for IPC types: `check:parity` compares channel names, `scripts/check-parity.mjs`). A shared golden fixture, `src-tauri/src/checklist/fixtures/checklist-v1.json`, is deserialised and re-serialised byte-equal by a Rust test and parsed by a TS test that checks every key and the status and owner sets, so a field added on one side fails the other side's test. Basis: how spec 136 mirrored `collapsedParentIds` (hand-written, test per side).
- Q: Does #2011 add a new IPC channel family and event? -> A: Decided (Skippy, delegated by Stuart 2026-11-19): yes: `checklist.get(sessionId)`, `checklist.mutate(sessionId, checklistId, baseRev, requestId?, op)` as new `refract_request` kinds following `agentTools.result` (`ipc/agent_tools.rs:10-13`, design data-flow rows 6 and 7), and the `checklist:update` event beside `readout:update` (`src-tauri/src/events.rs`). `checklist.itemMessage` is #2013's. Both new requests resolve `sessionId` against the live registry first (design "Session binding and isolation"). `check:parity` must list them on both sides.
- Q: Is `refract_checklist` visible to every Session? -> A: Decided (Skippy, delegated by Stuart 2026-11-19): it joins the `Role::Root` list in `tools_for` (`agent_tools/mod.rs:65-74`), so it is in the overlay and `set_host_tools`. `tools_for` gives a `Role::Child` nothing (`mod.rs:72`), and every launched Session is `Root` today (`mod.rs:34-40`), so each Session has its own checklist. The tool takes no session id (design "Session binding and isolation"); the handler binds to `agent.tool_session_id()`.
- Q: How is the checklist hint and the Conversation line stored? -> A: Decided (Skippy, delegated by Stuart 2026-11-19): `pending_agent_notice` becomes a list (design "Notice slot"); that change is in #2011 because the hint reads `agentSeenRev` and is meaningless without the store. `tell_agent_why` appends, the checklist hint and the Conversation line are further lines, a refused send puts the taken lines back at the front. The code is in `handoff_queue.rs` and `chat.rs`, both read at implementation time (T023).
- Q: Does the checklist survive a Session archive? -> A: Decided (Skippy, delegated by Stuart 2026-11-19): yes. Archiving keeps the Session row and its links (ADR 0009), so the checklist file stays; only delete removes it (design "Persistence", `delete_in_flight.rs:158`). Restore finds the checklist where it was.
- Q: What does `get` return for a Session with no checklist, and what does `checklist.get` return? -> A: Decided (Skippy, delegated by Stuart 2026-11-19): agent `get` with no active checklist returns `{ checklistId: null, state: "none" }` (not an error, the agent may then `create`); `checklist.get` returns `null`. A fully complete active checklist stays the active checklist until the next `create` archives it with no flag (design "Emit").
- Q: Is `refract_checklist` callable in OMP's plan mode? -> A: Decided (Skippy, delegated by Stuart 2026-11-19): unknown, so it is a live-check task (T026), not a spec assumption (design "Open question for #2011", ADR 0011 consequences). Pass or fail does not change the model or the store; it changes only the tool description (leave plan mode to edit the Checklist) and is recorded on the issue.

### Session 2026-11-20

- Q: Who chooses an item's `owner` at creation, and what is the default? -> A: Decided (Stuart, 2026-11-20): the agent, per item. Stuart rejected "Decisions for Stuart" item 5 (owner defaulting by who adds): "Agents will be creating the checklist 90% of the time so it needs to be able to assign tasks to the user from the start." The `create` items and the `add` op of the agent carry an explicit `owner` (`agent`, `human` or `either`); omitted, it defaults to `agent`; items the developer adds default to `human`. `owner` stays fixed after creation (`field_locked`) and `human_owned` still stops the agent completing a `human` item. The refusal is not an error of the add: an agent may create a `human` item, it just cannot tick it.
- Q: Which item fields can change after creation? -> A: Decided (Stuart, 2026-11-20, #2011 grill comment 7037177352): `owner`, `requiresValue` and `agentCompletable` are fixed at creation for everyone, agent and developer; a later `edit` of one fails `field_locked`; to change one, remove the item and add a new one.
- Q: What can the agent do to a completed item? -> A: Decided (Stuart, 2026-11-20, #2011 grill comment 7037177352): completed items are frozen for the agent: no edit, status change, value overwrite or removal (`item_complete`). Only the developer can reopen one, and reopening restores `previousStatus`.

### Session 2026-11-27

- Q: Does a plain `get` clear the Checklist hint? -> A: Decided (Stuart, 2026-11-27, #2350, Decided comment 7229500602): yes, a `get` with no `baseRev` counts as seen. Before this, `acknowledge` (`checklist/changes.rs:82-86`) raised `agentSeenRev` only when `baseRev` was quoted, and `do_get` (`agent_tools/checklist_tool.rs:243`) passed it `None` for a plain `get`, so the hint ("Call refract_checklist get", `checklist/hint.rs:32`) came back on every developer message until the agent quoted a `seenRev`, which a finished Checklist never prompts. Now `do_get` builds `userChanges`, issues the result's `seenRev`, then acknowledges up to it in the same store write, so a plain `get` marks seen exactly the changes its own result delivers. This amends the "raised only by a quoted `seenRev`" rule of FR-009 and ADR 0011 for plain `get` only (FR-022).
- Q: What happens to changes that do not fit in one result? -> A: Decided (Stuart, 2026-11-27, #2350): the overflow guard stays. `user_changes` already stops `seenRev` below the first change left out, so a plain `get` acknowledges up to that `seenRev` and the rest stay pending and are re-delivered; the hint stays until they have been delivered.
- Q: Which calls keep today's behaviour? -> A: Decided (Stuart, 2026-11-27, #2350): a `get` that quotes `baseRev` and every `update` (clamp to `min(baseRev, issuedSeenRev)` and `rev`, same write as the call's own op). The lost-result guarantee of the design therefore holds for them and not for a plain `get`: a plain `get` result lost in transit has already moved the watermark. Stuart accepted this trade-off.

## Decisions for Stuart

Hard to reverse once code ships; each has a picked answer so the decisions are complete.

1. **Scope split with #2013** (above). Recommendation: keep as picked. The alternative, #2011 also generalising `envelope.rs`, would make it touch the transcript parser and `chat.rs` and break the "model and store slice only" brief. Cost of being wrong: low (primitives are pure and wired later).
2. **A newer-version file is refused, not quarantined.** Recommendation: keep. Cost of being wrong: a downgrade loses the Checklist panel for that Session until upgrade; no data is lost. The alternative loses data silently.
3. **File format is JSON with `version: 1`, one file per Session, in `<data_dir>/checklists/`.** Fixed by ADR 0011; recorded here because the file name is user-visible on disk and cannot be renamed without a migration.
4. **Field names equal the design's schema keys** (`owner` for "who it belongs to"). Recommendation: keep; renaming after #2012 to #2014 land touches every layer.
5. **`owner` is chosen by the agent per item at creation.** Decided (Stuart, 2026-11-20): Stuart rejected the picked answer (default by who adds). "Agents will be creating the checklist 90% of the time so it needs to be able to assign tasks to the user from the start." The agent's `create` items and `add` op carry an explicit `owner` (`agent`, `human` or `either`); omitted, it defaults to `agent`; developer-added items default to `human`. `owner` stays fixed after creation (`field_locked`); `human_owned` still blocks the agent from completing a `human` item.
6. **The hash for send records is SHA-256 via `sha2`**, already a dependency (`src-tauri/Cargo.toml:80`, updater checksum, spec 006); no new crate.

## Problem

Epic #2015 needs a checklist the agent and the developer both edit. The OMP todo cannot carry it: it has no id, value or owner and is read-only (`src/shared/todo.ts:1-13`). ADR 0011 fixes the protocol. Nothing yet defines the data the protocol moves, the store that keeps it, or the engine that applies a change by either party under the design's authority, freeze, conflict and retry rules. Until that exists #2012 to #2014 have nothing to render or send. This slice builds exactly that, and nothing the panel, controls or chat card own.

## User Scenarios & Testing

### User Story 1 - The agent emits and updates a checklist (Priority: P1)

An agent calls `refract_checklist` with `create`, then `update`, and gets a compact, byte-bounded result with the ids it must use next.

**Independent Test**: With the Rust engine and a temp data dir, `create` a 6-item checklist, `update` with `add`, `edit` and `setStatus`, and `get`; every result is at most 7,168 bytes serialised.

**Acceptance Scenarios**:

1. **Given** no active checklist, **When** the agent calls `create` with a `requestId`, a title and items (each optionally carrying an `owner`), **Then** Rust assigns `p1` and `i1`..`iN`, stores each item's `owner` as given (`agent` when omitted), persists the file, returns every id in `ids` and the first compact page in `items`, and emits `checklist:update` with `by: "agent"` and `opened: true`.
2. **Given** an active checklist with an unfinished item, **When** `create` omits `replace`, **Then** it fails with `checklist_exists`; with `replace: true` and no developer-owned unfinished item it archives the old checklist and creates the new one.
3. **Given** a 40-item checklist, **When** the agent calls `create`, **Then** `ids` lists all 40 and `items` the first 11 compact items with `moreItems: true`.
4. **Given** an `update` quoting a `baseRev` below an item's `rev`, **When** the ops touch that item, **Then** the whole call fails with `conflict`, applies nothing and lists the conflicting items within the 3,948-byte items budget.
5. **Given** a retried `create` or structural `update` with a recorded `requestId`, **When** it arrives again, **Then** it returns the current compact result with `duplicate: true` and the recorded ids and is not applied twice.
6. **Given** an active checklist, **When** the agent sends `add` with `owner: "human"`, **Then** the item is stored with `owner: human`, `createdBy: agent`, and the agent's later `setStatus: complete` on it fails with `human_owned`; an `add` with no `owner` stores `agent`.

### User Story 2 - An agent update never costs the developer their work (Priority: P1)

**Independent Test**: A property test applies random agent op sequences to a checklist holding completed items and developer values; every completed item and every developer value is identical afterwards.

**Acceptance Scenarios**:

1. **Given** an item the developer completed, **When** the agent sends `edit`, `move`, `remove`, `setValue` or `setStatus` for it, **Then** the call fails with `item_complete` and nothing changes.
2. **Given** an item the agent completed itself, **When** the agent sends `setStatus` to a non-complete status, **Then** it fails with `item_complete`; the developer can reopen it and `previousStatus` is restored.
3. **Given** a developer-created or developer-edited item, **When** the agent sends `edit` or `remove`, **Then** it fails with `developer_item`; the same for `remove` of any item with a developer-set value, and `setValue` over a developer-set value.
4. **Given** `owner`, `requiresValue` or `agentCompletable`, **When** the agent or the developer tries to change one with `edit` after creation, **Then** it fails with `field_locked`; the item is removed and added again to change it.
5. **Given** an `owner: human` item, or a `requiresValue` item with no developer-set value, **When** the agent sets it `complete`, **Then** it fails with `human_owned` or `value_required`.
6. **Given** `create` with `replace: true` while the checklist holds an unfinished developer-owned item, **When** the card is denied, **Then** the call returns `denied` and the checklist is unchanged.

### User Story 3 - The developer's edits are stored and reach the agent (Priority: P1)

**Independent Test**: A developer tick and a value via `checklist.mutate` persist and emit `checklist:update`; the agent's next `refract_checklist` result lists them in `userChanges` until it quotes the `seenRev`.

**Acceptance Scenarios**:

1. **Given** an item, **When** the developer ticks it, **Then** its status is `complete`, `previousStatus` holds the prior status, `completedBy` and `updatedBy` are `developer`, `rev` rises and the file is written before the event goes out.
2. **Given** a ticked item, **When** the developer unticks it, **Then** `previousStatus` is restored (or `upcoming`) and cleared.
3. **Given** a `requiresValue` item with no value, **When** the developer ticks it, **Then** it fails with `value_required` and nothing changes.
4. **Given** the agent changed an item above the developer's `baseRev`, **When** the developer mutates that item, **Then** it fails with `item_changed`, applies nothing and returns the current checklist. A developer op never conflicts with another developer op.
5. **Given** developer changes above `agentSeenRev`, **When** the agent calls `get`, **Then** `userChanges` lists them oldest first with op and field names only (never text or values); a result lost in transit returns the same changes again, except for a `get` with no `baseRev` (amended 2026-11-27, scenario 7); a call quoting `baseRev` raises `agentSeenRev` to `min(baseRev, issuedSeenRev)` and never above `rev`.
6. **Given** more than 20 unseen changes, **When** the result is built, **Then** it stops at 20 with `moreChanges: true` and `seenRev` equals the last returned entry's `rev`.
7. **Given** developer changes above `agentSeenRev` and a `get` with no `baseRev`, **When** the result is built, **Then** it lists the changes in `userChanges`, and in the same store write `agentSeenRev` rises to the result's `seenRev` (FR-022), so the next notice carries no checklist hint.
8. **Given** more than 20 unseen developer changes and a `get` with no `baseRev`, **When** the result is built, **Then** `agentSeenRev` rises only to the result's `seenRev` (the last returned entry's `rev`, or just below it when two entries share a `rev`), the undelivered changes are re-delivered by the next `get`, and the hint stays until they have been; a `get` that quotes `baseRev` and every `update` behave as in scenario 5.

### User Story 4 - The checklist survives restart and stays isolated (Priority: P1)

**Independent Test**: Write a checklist, drop the in-memory store, reload from the file and compare; call `checklist.get` with a path-traversal `sessionId` and confirm nothing is read or written.

**Acceptance Scenarios**:

1. **Given** a saved checklist, **When** the store reloads, **Then** it equals the saved checklist, including archived checklists without values, `removed`, `recentRequests`, `pendingComplete` and send records.
2. **Given** a failed write, **When** an op is applied, **Then** memory is unchanged and the agent gets `write_failed` or the renderer an `IpcError`.
3. **Given** a corrupt file, **When** it loads, **Then** it is quarantined, only the newest 3 `.corrupt-<millis>` files per Session are kept, leftover `.tmp` files are deleted and the Session works with no checklist.
4. **Given** a file with `version` above 1, **When** it loads, **Then** nothing is written and calls fail with `store_unsupported`.
5. **Given** a `sessionId` that is not in the live registry (including `..\working-modes`) or is deleting, **When** any checklist call arrives, **Then** it fails with `unknown_session` or `not_found` and no file is created.
6. **Given** a Session delete, **When** `remove()` runs, **Then** the checklist file is deleted after `remove_agent` and the store entry is tombstoned under the Session lock, so an in-flight call cannot recreate it.
7. **Given** a cancelled `host_tool_call`, **When** the handler was mid-apply, **Then** the apply completes on a detached task (never half-applied) and a retry is safe.

### User Story 5 - Later children get the primitives they need (Priority: P2)

**Independent Test**: Unit tests for the send-record and `pendingComplete` store API: write a record, cap at 500, match on all five fields, start and settle an entry.

**Acceptance Scenarios**:

1. **Given** 501 send records, **When** one more is added, **Then** the oldest is evicted and a lookup of it returns none.
2. **Given** a `complete` entry, **When** it is cleared by an agent `setStatus`, a developer status change, `edit`, `remove`, or `replace`, **Then** no revert happens; **When** `settle` runs on a started entry whose item is still `in_progress` at the same `statusRev`, **Then** the previous status is restored; **When** the status or `statusRev` has changed, **Then** nothing is restored.
3. **Given** a store with a `complete` entry on load and an idle Session, **When** the checklist loads, **Then** the stale entry is cleared by the same restore rule.

### Edge Cases

- **Removed id**: `item_removed` for a retired id, `unknown_item` for one that never existed; both list compact items within the error budget with `moreItems`.
- **`removed` list full** (40): the oldest unseen entry may be evicted; the agent's next use of that id still fails with `item_removed` because ids are never reused (counter, not list).
- **Concurrent callers**: agent apply and developer mutate on one Session serialise on the per-Session lock; two Sessions never share a lock.
- **Control characters and U+2028/U+2029** in `text` fail validation (`invalid_input`).
- **`requestId` omitted** on `create` or a structural `update` (`add`, `move`, `remove`) fails with `invalid_input`.
- **Value size** over 1 KiB, text over 200 bytes, 41st item, 21st op: `too_large` naming the field.
- **Checklist in OMP plan mode**: unverified; T026.
- **Archived checklist history**: newest 5 kept, item values dropped; panel shows only the active checklist.

## Requirements

### Functional Requirements

- **FR-001**: Shared TS (`src/shared/checklist.ts`) and Rust (`src-tauri/src/checklist/model.rs`) define `Checklist`, `ChecklistItem`, `ItemStatus`, `ItemOwner`, `Actor`, `ChecklistOp`, `LastDeveloperOp`, `RemovedEntry`, `RecentRequest`, `PendingComplete`, `SendRecord` and the checklist file with the design's keys; the golden fixture round-trips on both sides (Clarifications, mirroring).
- **FR-002**: The five statuses, who may set each, `previousStatus` and `statusRev` behave as in Clarifications (status transitions).
- **FR-003**: Checklist and item ids come from persisted counters and are never reused.
- **FR-004**: Caps and character rules are enforced by one validator for both parties; an over-limit field fails with `too_large` naming the field, a bad character with `invalid_input`.
- **FR-005**: The agent op engine applies at most 20 of `add`, `edit`, `move`, `remove`, `setStatus`, `setValue` all or none, under the Authorship rules (`developer_item`, `field_locked`, `human_owned`, `value_required`, `item_complete`) and stamps touched items with the new `rev`. The `add` op and the `create` items carry an optional `owner` (`agent`, `human`, `either`; default `agent`). A property test proves completed items and developer-set values survive any agent op sequence.
- **FR-006**: The developer op engine applies the same ops without the freeze or authorship limits, but `owner`, `requiresValue` and `agentCompletable` stay fixed (`field_locked`); a developer `add` defaults `owner` to `human` unless it carries one; it sets `editedByDeveloper` on edit; it fails `value_required` for a tick of a `requiresValue` item with no value, and `item_changed` only when the agent changed the target above `baseRev`.
- **FR-007**: Every accepted change by either party bumps checklist `rev` and stamps touched items; an agent op applies only when every existing item it touches has `rev` at or below `baseRev`, else `conflict`.
- **FR-008**: `requestId` handling: required on `create` and on `update` containing `add`, `move` or `remove`; the last 16 `{ requestId, rev, addedIds }` are persisted; a recorded id returns the current result with `duplicate: true`; `checklist.mutate` accepts the field.
- **FR-009**: The change record is `lastDeveloperOps` per item (one record per op kind) plus checklist `removed` (at most 40, pruned at or below `agentSeenRev`); `userChanges` is built from these, ordered by record `rev`, at most 20 entries, with `agentSeenRev` and `issuedSeenRev` semantics as in the design (watermark raised only by a later call quoting a `seenRev`, clamped, persisted in the same write as the call's own op; amended 2026-11-27 by FR-022: a `get` with no `baseRev` also raises it, to the `seenRev` its own result issues).
- **FR-010**: Results (`create`, `update`, `get`) and errors are built to the design's byte budgets: item text cut to 60 bytes with `textTruncated`, values never inlined, `items` budget 3,948 bytes, `userChanges` 20 entries, error header plus items under 4,069 bytes, every result at most 7,168 bytes (a test asserts the serialised worst case, and that it is under `MAX_RESULT_BYTES` 8192, `agent_tools/mod.rs:31`).
- **FR-011**: The store is `<data_dir>/checklists/<sessionId>.json` via `atomic_json`; one lock per Session held across apply, write and swap; the order is clone, apply to the clone, write, then swap; a failed write leaves memory unchanged; the handler runs the apply on a detached task and awaits it.
- **FR-012**: Load handles a corrupt file (quarantine, keep newest 3, delete leftover `.tmp`), an unsupported `version` (refuse, never write) and a missing file (empty).
- **FR-013**: Every checklist call checks the live registry and `delete_in_flight::is_deleting` under the lock; the file path is built from the registry's id only; `delete_in_flight.rs` removes the file after `remove_agent` and tombstones the entry; archive keeps the file.
- **FR-014**: `create` assigns ids, archives a complete active checklist with no flag, archives an unfinished one only with `replace: true`, raises a `session_card` when it would drop developer-owned unfinished items (not skipped in yolo; a denial returns `denied`), keeps the newest 5 archived checklists with values dropped, and sets `opened: true` on the event.
- **FR-015**: `refract_checklist` is registered for `Role::Root`: `tools_for`, `host_tool_defs` checklist branch, `router::plan` arm returning `Plan::Native`, `run_native` arm before the `sessions_send::send` fallthrough, overlay golden string, `mod.test.rs` counts (17 to 18) and names; the description tells the agent to quote `seenRev`, to call `get` before editing a checklist it did not create in this run, that it is not plan mode, and to use the OMP todo for scratch tracking.
- **FR-016**: `checklist.get` and `checklist.mutate` are new IPC requests (renderer type, `tauri-bridge`, Rust handler, parity script); `checklist:update` carries `{ sessionId, checklist, by, opened? }` with the whole checklist, so the renderer holds no merge logic.
- **FR-017**: The store exposes the send-record API (add with hash-only record, newest 500, match on `checklistId`, `itemId`, `rev`, `action`, `textHash`) and the `pendingComplete` primitives (accept, refuse-restore, clear rules, start, settle, stop) as pure store methods with tests; nothing in `chat.rs` or the transcript pass changes in this slice.
- **FR-018**: `pending_agent_notice` becomes a list; the checklist hint (ids and ops only, never text or values, built when the notice is taken) and the Conversation start, switch and relaunch line (counts and ids only) are produced from the store.
- **FR-019**: The registry-gated `refract_checklist` tool never takes a `sessionId` or `checklistId` argument.
- **FR-020**: Whether `refract_checklist` is callable in OMP's plan mode is checked live and recorded; the tool description is set accordingly.
- **FR-021**: Code comments say why, never what (#1322); no touched or new file exceeds 600 lines (plan.md budgets every module); `check:parity` lists both new requests and the event; every changed module has a co-located test file named in plan.md (AGENTS.md Testing, epic #1918); each guard's test fails when the guard is removed.
- **FR-022**: A `get` with no `baseRev` marks as seen the developer changes its own result delivers: `do_get` builds `userChanges`, calls `issue_seen_rev` with the result's `seenRev`, then `acknowledge` up to it, in the same store write, so the next `[Refract]` hint omits them. Changes beyond `MAX_USER_CHANGES` are not delivered, `seenRev` stays below them and they are re-delivered. A `get` that quotes `baseRev` and every `update` are unchanged, including the clamp of FR-009. The tool description, the design doc and ADR 0011 say that calling `get` is enough to clear the hint. This amends the "raised only by a later call quoting a `seenRev`" rule of FR-009 for plain `get` only.

### Key Entities

- **Checklist**, **Checklist item**: as in `CONTEXT.md`.
- **Developer-owned item**: a Checklist item the agent cannot edit or remove; new glossary term.
- **Checklist revision**: the integer `rev` that rises on every accepted change; new glossary term.
- **Send record**: a hash-only note that a developer checklist turn was sent (stored here, written by #2013).

## Success Criteria

- **SC-001**: Every result and error serialised in the worst-case tests is at most 7,168 bytes.
- **SC-002**: The property test of FR-005 finds no sequence that changes a completed item or a developer-set value.
- **SC-003**: A checklist with mixed `agent`, `human` and `either` items, per-item values and all five statuses saves and reloads equal (issue acceptance 1).
- **SC-004**: The Rust and TS fixture tests both pass on the same golden file (issue acceptance 3).
- **SC-005**: A live fake-omp check shows `refract_checklist` create, update and get, a developer tick via `checklist.mutate`, an app restart that still has the checklist, and a Session delete that removes the file.
- **SC-006**: `pnpm ci:local` is clean, including `check:file-size`, `check:comment-density` and `check:parity`.

## Assumptions

- ADR 0011 and the design are the protocol; this spec changes none of it. A contradiction found while implementing is raised on #2010 before code diverges.
- `refract_checklist` is used by the agent in practice (model-compliance risk accepted by ADR 0011).
- Values are plain text (design "Values are not secrets"); the warning is #2013's.
- No panel, control, chat card, envelope or `checklist.itemMessage` code is written here.
