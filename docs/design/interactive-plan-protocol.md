# Interactive plan protocol

Status: Decided (spike #2010, child of epic #2015). Decider: Skippy, delegated by Stuart, 2026-11-19. Recorded as [ADR 0011](../adr/0011-interactive-plan-protocol.md).

This document defines how a **Plan** (a durable, per-item agent and human list, distinct from the agent's own todo) moves between the agent, Refract and the developer. It fixes the protocol only. The data-model child (#2011) owns the exact field set and status vocabulary. The panel child (#2012) owns the layout. The chat-card and controls children (#2013, #2014) own the item controls and the card. None of them needs to re-decide a channel, an id rule or a conflict rule from this document.

Claims cite a file and line as of `origin/main` at `dd56b639`. Anything not read from a file or an OMP doc is marked `[INFERENCE]`.

## Summary

- The agent **emits and updates** the plan with one new Refract host tool, `refract_plan`, answered natively in Rust. It uses the host tool channel of [ADR 0007](../adr/0007-agent-tool-channel.md).
- The developer **mutates** the plan through new Refract IPC requests. Rust applies a tick or a value directly to the store, so these work with the agent stopped.
- **Ask**, **give a value** and **complete this step** are real chat turns. Each is wrapped in a `<plan-item>` envelope, the way [ADR 0008](../adr/0008-session-message-envelope.md) wraps a Session message. The envelope carries the exact item id. A plain tick is stored and reaches the agent without a turn.
- Rust **owns the plan** and **persists** it per Session in the Refract data directory. The OMP transcript is not the source of truth.
- Everything ships on **today's rpc-ui wire**. No OMP-upstream capability is required, so no upstream request is raised.
- The plan **coexists** with the OMP todo pill and panel. This document confirms that recommendation.

## Background: what exists today

| Fact | Evidence |
|---|---|
| The OMP todo arrives as a read-only frame. Each task has `content`, `status` and `blocker`. There is no id, value or owner. | `src/shared/todo.ts:1-13`, `src/shared/frames.ts:122` |
| Refract reads the todo from the `tool_execution_end` frame of OMP's `todo` tool. | `src-tauri/src/session/readout.rs:118-129` |
| The user can only touch the todo through allowlisted slash commands (`/todo append`, `start`, `done`, `rm`). These act on OMP's list by name, so they cannot carry a value or an item id. | `src/shared/slash-commands.ts:14` |
| The `ask` tool is bidirectional but one-shot: `answer_request` resolves one pending request with one answer. | `src-tauri/src/session/agent/requests.rs:13-57` |
| Refract registers its own host tools on every launch with `set_host_tools` and serves each `host_tool_call` on its own task. Tools use `loadMode: "essential"` and the `refract_` prefix. | `src-tauri/src/agent_tools/mod.rs:27`, `:77-95`, `:99-108`; `router.rs:294-311` |
| Some Session tools are answered in Rust with no renderer round trip and no approval card. | `src-tauri/src/agent_tools/router_native.rs:14-37` |
| A tool result is capped at 8 KiB (`MAX_RESULT_BYTES`). | `src-tauri/src/agent_tools/mod.rs:31` |
| The approval overlay allows exactly the registered tool names, so a new tool joins it by joining `tools_for`. | `src-tauri/src/agent_tools/overlay.rs:13-19`, `mod.rs:65-74` |
| A user prompt reaches the agent through `prompt`. While the agent works it goes out with `streamingBehavior: "followUp"`. A paused Session holds it. A stopped Session refuses it. | `src-tauri/src/session/agent/chat.rs:72-156` |
| A one-line notice can be prepended to the next user prompt (`[Refract] <notice>`). | `chat.rs:105-121`, `session/agent/handoff_queue.rs:72-78` |
| A fixed text envelope in a user turn is parsed on transcript load and becomes a typed `source` on the user item. | `src-tauri/src/agent_tools/envelope.rs`, `omp/transcript/message_source.rs:8-30` |
| Refract already persists small per-key JSON stores atomically (write-tmp, fsync, rename; quarantine on parse failure). | `src-tauri/src/store/atomic_json.rs:1-30`, `store/handoff_notes.rs` |
| OMP documents `set_host_tools`, `host_tool_call`, `host_tool_update` and `host_tool_result` as the host tool sub-protocol. | `omp://rpc.md` ("Host Tool Sub-Protocol") |
| ADR 0007's probe confirmed host tools over the RPC stream on omp 18.17.0, and the #689 review checks them on every OMP bump. | `docs/adr/0007-agent-tool-channel.md`, `docs/PLAN.md` row 1c.1 and the #689 ledger |

## Requirements

The issue and the epic (#2015) require that the plan is:

1. emitted by the agent;
2. updated by the agent on the fly, keeping completed items;
3. mutated by the developer (tick, supply a value, ask about a step, trigger "agent, complete this step"), each mapped to the exact item;
4. persisted per Session across restarts.

## Options considered

### Option A: a Refract host tool (chosen)

The agent calls `refract_plan`. Rust validates the call, applies it to the plan, persists it and tells the renderer.

- **Emit and update:** one typed, schema-checked call per change. The result tells the agent the new revision, so it can stay in sync.
- **Mutate:** the developer never goes through the agent for a tick or a value, so it works while the agent is busy, paused or stopped.
- **Cost:** a new tool in `src-tauri/src/agent_tools/`. The model must choose to call it, so the tool description has to say when.

### Option B: a convention in the assistant's text

The agent writes a fenced block (for example ```` ```plan ````) and Refract parses it out of the stream.

- It needs no tool, but there is no result for the agent: it cannot learn that an update was rejected.
- Updates mean re-emitting the whole block, and the transcript parser must tell a plan from a quoted example. Item ids would have to be invented by parsing, which breaks "mapped to the exact item".
- Rejected: fragile, and it has no acknowledgement channel.

### Option C: extend the OMP todo

Reuse `todoPhases` and the `/todo` slash commands.

- The todo is the agent's own ephemeral tracking. It has no id, value or owner (`src/shared/todo.ts:1-13`), and OMP owns its model.
- The only user-to-agent path is name-matched slash commands (`src/shared/slash-commands.ts:14`).
- Adding fields would need an OMP-upstream change and would break the epic's goal that the plan is distinct from the todo.
- Rejected.

### Option D: the `ask` tool

- One question, one answer, then the request is resolved (`requests.rs:13-57`). A plan is a long-lived object, not a question.
- Rejected as the channel. The ask card stays for what it is built for (#1990).

### Option E: a plan file the agent edits

The agent writes `plan.json` into the worktree with its file tools.

- No schema check, no atomic multi-item update, no revision or conflict rule, and it pollutes the repository.
- Rejected.

### Trade-off summary

| Need | A: host tool | B: text convention | C: OMP todo | D: ask | E: file |
|---|---|---|---|---|---|
| Stable item ids | Yes | No | No | No | Weak |
| Acknowledgement to the agent | Yes | No | Partly | Yes | No |
| Mutate while the agent is stopped | Yes | Yes | No | No | Yes |
| Works on today's wire | Yes | Yes | No | Yes | Yes |
| Plan separate from the todo | Yes | Yes | No | Yes | Yes |

## Decision

Option A for the agent side. Rust owns the plan. The developer's direct edits use new IPC requests. Ask, value and complete use a chat-turn envelope. The next sections specify each part.

## Data flow

| # | Direction | Channel | Message shape | Item id mapping |
|---|---|---|---|---|
| 1 | Agent to Refract: emit | `host_tool_call` for `refract_plan`, `action: "create"` | `{ action, title, items: [{ text, owner?, requiresValue?, agentCompletable?, group? }], replace? }` | Rust assigns each id (`i1`, `i2`, ...) and returns them in the result. |
| 2 | Agent to Refract: update | `host_tool_call` for `refract_plan`, `action: "update"` | `{ action, baseRev, ops: [Op] }` | Each op names an item by id, or by `after: <id>` for placement. |
| 3 | Agent to Refract: read | `host_tool_call` for `refract_plan`, `action: "get"` | `{ action }` | Result returns every item with its id. |
| 4 | Refract to agent: acknowledge | `host_tool_result` for the same call | `{ planId, rev, items?, changed, userChanges }` or `{ error: { code, ... } }` | Ids in the result are the ids the next call must use. |
| 5 | Refract to renderer | Tauri event `plan:update` (new, beside `readout:update` in `src-tauri/src/events.rs`) | `{ sessionId, plan, by: "agent" \| "user", opened?: true }` | The whole plan, so the renderer holds no merge logic. |
| 6 | Renderer to Refract: read | IPC request `plan.get` | `(sessionId)` returns the active plan or `null` | none |
| 7 | Renderer to Refract: tick, value, edit | IPC request `plan.mutate` | `(sessionId, planId, baseRev, op)` | `op` names the item id. |
| 8 | Renderer to agent: ask / value / complete this step | IPC request `plan.itemMessage`, which sends a `prompt` | `(sessionId, planId, itemId, action: "ask" \| "value" \| "complete", text?)`, sent as a `<plan-item>` envelope | The envelope carries `plan`, `item` and `rev`. |
| 9 | Refract to agent: unseen developer edits | `userChanges` in every `refract_plan` result, plus a `[Refract]` notice on the next developer prompt | list of `{ rev, itemId, op, value? }` | Same ids. |
| 10 | Refract to disk | Write-through to `<data_dir>/plans/<sessionId>.json` | See "Persistence" | Same ids. |

The IPC names follow the existing `agentTools.result` pattern (`src-tauri/src/ipc/agent_tools.rs:10-13`). The renderer reaches them through the existing `refract_request` command (`src/tauri-bridge/index.ts:83-87`).

### Emit

The agent calls `refract_plan` with `action: "create"`. Rust:

1. checks the arguments against the tool schema (the same `validate` used by the panel tools, `agent_tools/panels.rs:123`);
2. assigns the plan id (`p1`, `p2`, ...) and item ids;
3. persists the plan, then emits `plan:update` with `opened: true`, which is the signal that opens the right-pane panel (#2012);
4. returns the plan to the agent.

If an active plan has unfinished items, `create` fails with `plan_exists`. The agent passes `replace: true` to archive it and start a new one. Plans are never deleted by the agent.

The call is answered natively: no renderer round trip and no approval card (`router_native.rs:14-37`). A plan edit changes Refract-owned state only and the developer can see and undo it, so it needs no file-change approval. `[INFERENCE]` The router's native dispatch is the intended home for tools like this, and the plan tool adds a case to `run_native`.

### Agent update

`action: "update"` takes `baseRev` (the revision the agent last saw) and a list of operations. Rust applies all of them or none.

| Op | Fields | Effect |
|---|---|---|
| `add` | `after?: id`, `item` | Inserts a new item. Appends when `after` is omitted. |
| `edit` | `id`, any of `text`, `owner`, `requiresValue`, `agentCompletable`, `group` | Changes the item's definition. |
| `move` | `id`, `after?: id` | Reorders. |
| `remove` | `id` | Removes an item that is not complete. |
| `setStatus` | `id`, `status` | Sets the status. |
| `setValue` | `id`, `value` | Records a value on the item. |

The rules that keep completed items safe:

- **Completed items are frozen for the agent.** `edit`, `move`, `remove`, `setStatus` and `setValue` on a completed item fail with `item_complete`. The agent cannot untick the developer's ticks or rewrite what was done. Only the developer reopens an item.
- **Ids are never reused.** A removed id stays retired, so a stale reference can never silently hit a different item.
- **`requiresValue` is enforced by Rust.** Completing an item that requires a value, and has none, fails with `value_required` for both parties.
- Plan and text limits are protocol rules, so the 8 KiB result cap holds: at most 60 items and 200 characters of text per item (`[INFERENCE]` sizes, chosen so a full plan fits `MAX_RESULT_BYTES`). An over-limit call fails with `too_large`. If a result would still exceed the cap, completed items are returned as `{ id, status }` only.

Concurrency uses a per-item revision. Every accepted change by either party bumps the plan `rev` and stamps the touched items with that `rev`. An agent op is applied when every item it touches has an item `rev` at or below `baseRev`. Otherwise the whole call fails with `conflict`, and the error lists the current state of the conflicting items so the agent can re-plan without another `get`. Developer edits always win: they are applied immediately, never rejected for revision.

### User mutate

The panel sends `plan.mutate`:

| Developer action | Op sent |
|---|---|
| Tick an item | `setStatus` to the complete status |
| Untick | `setStatus` to the pre-completion status |
| Provide a value | `setValue` |
| Edit, add or remove an item | `edit`, `add`, `remove` (same vocabulary as the agent, without the completed-item freeze) |

Rust applies the op under the plan lock, bumps `rev`, persists, emits `plan:update` with `by: "user"`, and appends an entry to the plan's `unseen` list. The call returns the new plan. A stale `baseRev` does not fail a developer op. It only decides whether the UI should flash that an item changed under them. `[INFERENCE]` The panel can read that from the returned plan.

Nothing here talks to the agent, so a tick or a value never interrupts a running turn.

### Ask, give a value, and complete this step

These three actions need the agent's attention, so they are chat turns. The panel calls `plan.itemMessage`. Rust builds this text and sends it through the same path as `chat.send`:

```text
<plan-item plan="p1" item="i3" rev="9" action="ask">
Does this step need the staging database?
</plan-item>
```

- `action="value"` is the textarea in #2013: the developer gives a value for a step. Rust first applies `setValue` to the item (so the panel shows it at once and a stopped agent still keeps it), then sends the turn with the value as the body and clears the matching `unseen` entry, because the envelope already carries it. If the send is refused, the value stays stored and the developer sees the refusal.
- `action="complete"` has no body of its own. Rust fills it with the item text so the model has the step in front of it. It is allowed only when the item is `agentCompletable` and not complete. Otherwise the call fails with `not_agent_completable`.
- A plain tick does not send a turn. It is stored, queued in `unseen` and reaches the agent as described in the next section. `[INFERENCE]` This keeps ticking cheap and non-interrupting. #2013 can still offer "tick and tell the agent" by sending `action="value"` or `ask` with the tick, with no protocol change.
- The attribute and body escaping reuse the one escape table that `wrap` and `parse` share in `agent_tools/envelope.rs`, so a message cannot close or forge the envelope. This is the same rule as ADR 0008.
- **Authority.** Unlike a Session message, this turn is the developer's own, so it carries the developer's full authority. The envelope is a label, not a permission change.
- **Delivery** follows `chat.rs:72-156`: an idle Session sends at once; a working Session queues it as `followUp`; a paused Session holds it; a stopped Session refuses it with `agent-not-running`. The panel disables ask, value-to-agent and complete while the Session has no live agent.
- **Transcript.** OMP stores the user turn as the envelope text, so a reload still shows it. Refract's transcript parser recognises the envelope and sets a typed source on the user item. This is the hook for the distinct chat card (#2014). The source mirrors `MessageSource` in `omp/transcript/message_source.rs:11-18` with a new variant `PlanItem { planId, itemId, action }`.
- The agent then acts through `refract_plan update` (for example `setStatus` and `setValue`). It never has to guess which item the developer meant, because the envelope names it.

### Keeping the agent in sync with developer edits

A tick or a value changes the plan without a turn. The agent finds out in two ways:

1. **Pull.** Every `refract_plan` result includes `userChanges`, the entries in `unseen` since the agent last read, then clears them.
2. **Push with the next prompt.** When the developer sends a normal prompt and `unseen` is non-empty, Rust prepends a one-line `[Refract]` notice through the existing notice path (`chat.rs:105-121`). It reads, for example, `Plan p1 changed by the developer since your last read: ticked i2; set value on i3. Call refract_plan get.` The `<plan-item>` turns do not need it, because they carry the item's current state.

`[INFERENCE]` The notice reuses `with_notice` and `take_pending_notice`, which today hold one string, so the implementer must either fold the plan line into that string or extend it to a list.

## Persistence

| Question | Answer |
|---|---|
| Where | `<data_dir>/plans/<sessionId>.json`, with `data_dir` from `src-tauri/src/lib.rs:27`. One file per Session. |
| Scope | Per Session, not per Conversation: a new Conversation in the same Session keeps the plan. The plan records the Conversation it was created in, for provenance only. |
| Writer | Rust only, write-through on every accepted change, before the tool result or event goes out. Use `store/atomic_json.rs` (temp file, fsync, rename). |
| Cache | An in-memory cache with one lock, as in `store/handoff_notes.rs`, so concurrent agent and developer changes serialise. |
| Corrupt file | `atomic_json` renames it to `<name>.corrupt-<millis>` and starts empty (`atomic_json.rs:1-30`). |
| Session deleted | The delete path (`sessions_end*`) removes the file. `[INFERENCE]` One call in the existing end-of-Session cleanup. |
| History | Archived plans stay in the file, newest 20. The panel shows only the active plan. |

Schema sketch (the #2011 model owns final field names; the keys below are the protocol's contract):

```json
{
  "version": 1,
  "sessionId": "s-1",
  "activePlanId": "p2",
  "nextPlanSeq": 3,
  "plans": [
    {
      "id": "p2",
      "title": "Step-by-step testing plan",
      "rev": 9,
      "nextItemSeq": 6,
      "createdInConversation": "c-1",
      "state": "active",
      "items": [
        {
          "id": "i3",
          "text": "Run the migration against staging",
          "status": "complete",
          "owner": "agent",
          "requiresValue": true,
          "value": "ran 12 migrations, 0 failed",
          "agentCompletable": true,
          "rev": 9,
          "updatedBy": "user"
        }
      ]
    }
  ],
  "unseen": [{ "rev": 9, "itemId": "i3", "op": "setStatus" }]
}
```

### Restart behaviour

- **App restart.** Nothing is loaded until the Session is opened. On open, Rust reads the file, the renderer calls `plan.get` and subscribes to `plan:update`. The panel shows the saved plan with no agent running. Ticks and values still work and queue in `unseen`.
- **Agent restart or reattach.** The OMP transcript holds the earlier `refract_plan` calls and results, but the store is the truth. The tool description tells the agent to call `get` before it edits a plan it did not create in this run. Pending `unseen` entries reach it with its next result or prompt.
- **Process crash mid-call.** The write happens before the result is sent. If the result is lost, the agent retries or calls `get`, and a retry with the old `baseRev` fails with `conflict` rather than double-applying.

## Coexistence with the OMP todo

Confirmed: the plan and the OMP todo coexist, and neither replaces the other.

| | OMP todo | Plan |
|---|---|---|
| Owner | The agent (OMP `todo` tool) | Refract, edited by agent and developer |
| Lifetime | Live state only (`CONTEXT.md`: Up next) | Durable per Session |
| Item identity | None (by task name) | Stable id |
| Surface | Todo pill, Todo panel, Up next | Right-pane plan panel |
| Developer writes | Only name-matched `/todo` verbs | Tick, value, ask, complete, edit |

Nothing in the todo path changes: `todoPhases` ingestion (`readout.rs:118-129`), the pinned Todo panel and the `/todo` allowlist stay as they are. The `refract_plan` description tells the model to use the todo for its own scratch tracking and the plan for work the developer will see and take part in.

## Failure cases

| Case | Behaviour |
|---|---|
| Agent not running | Tick, value and edit work from the store. Ask, value-to-agent and complete are disabled; if called, they fail with `agent-not-running` (`chat.rs:92-100`). The value is still stored. |
| Agent paused | A `plan.itemMessage` turn is held and sent on resume (`chat.rs`, `MessageDelivery::Held`). |
| Agent working | Ticks apply at once. Ask, value and complete queue as follow-ups. The agent reads `userChanges` on its next call. |
| Stale item id | `unknown_item` for an id that never existed. `item_removed` for a retired id. The error includes the current item list. |
| Concurrent edit | `conflict` lists the items that changed after `baseRev`. Nothing is applied. |
| Edit to a completed item by the agent | `item_complete`. |
| Completing a value item without a value | `value_required`. |
| Unknown plan id from an old envelope | The agent gets `unknown_plan`; the card still renders from the transcript. |
| Plan too large | `too_large`. |
| `set_host_tools` refused by OMP | The Session works as a plain agent with no `refract_plan` (`mod.rs:99-108`). The panel stays empty. The existing warning is logged. |
| Corrupt store | Quarantined; the plan is lost but the Session works. |
| The model answers with an inline plan and never calls the tool | No plan is created. The developer says "put this in the plan panel"; the model then calls `create`. `[INFERENCE]` This is a model-compliance risk, reduced by the tool description, and there is no parsing fallback by design (Option B). |
| Child Session | `tools_for` returns no tools for `Role::Child` (`mod.rs:72`); every launched Session is `Root` today (`mod.rs:34-40`), so each Session has its own plan. |

## Current wire vs OMP upstream

**Everything ships on today's rpc-ui wire. No OMP-upstream capability is required, and no upstream request is raised.**

| Capability | Wire primitive | Status |
|---|---|---|
| Agent emits and updates the plan | `set_host_tools`, `host_tool_call`, `host_tool_result` | Shipped and live-checked for other tools (ADR 0007, #1193) |
| Developer mutates the plan | Refract IPC only, no OMP involvement | No dependency |
| Ask, give a value, complete this step | `prompt` with `streamingBehavior: "followUp"` | Shipped (`chat.rs:128-130`) |
| Persist | Refract data directory | No dependency |
| Distinct card on reload | The envelope text in the OMP session file, parsed by Refract | Shipped pattern (ADR 0008) |

Dependencies to watch, both covered by an existing check:

- The plan tool inherits the host tool risk in ADR 0007. If an OMP release stops accepting `set_host_tools`, the #689 review per OMP bump catches it, as it does for every other `refract_` tool.
- The `<plan-item>` envelope is persisted in OMP session files, so it needs a stable format. Changing it later means the parser accepts both forms (the ADR 0008 consequence).

Limits that are not blockers but are worth knowing:

- A host tool result is text with an 8 KiB cap, so the plan result is compact by design.
- OMP cannot push a developer edit into a running turn. A tick reaches the model on its next tool call or the next prompt. This is acceptable because ticks are bookkeeping, not instructions.

## What each child builds

| Child | Builds, from this document |
|---|---|
| #2011 data model and store | The shared TS and Rust plan and item types (field names, status set), the `plans/<sessionId>.json` store with cache and lock, id and `rev` assignment, the op engine with the freeze, `value_required` and conflict rules, and the `refract_plan` tool schema and handler. |
| #2012 right-pane panel | Subscribes to `plan:update`, opens on `opened: true`, calls `plan.get`, and renders the plan. Sends `plan.mutate` for ticks and values. |
| #2013 per-item controls | Ask, provide value and complete-this-step controls, calling `plan.mutate` and `plan.itemMessage`, disabled when the Session has no live agent. A plain tick calls `plan.mutate` only. |
| #2014 chat card | Renders the `PlanItem` source on the user item and the agent's reply to it. |
