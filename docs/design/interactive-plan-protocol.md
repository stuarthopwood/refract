# Interactive plan protocol

Status: Decided, revised after two adversarial reviews (spike #2010, child of epic #2015). Decider: Skippy, delegated by Stuart, 2026-11-19. Recorded as [ADR 0011](../adr/0011-interactive-plan-protocol.md).

This document defines how a **Plan** (a durable, per-item agent and human list, distinct from the agent's own todo) moves between the agent, Refract and the developer. It fixes the protocol only. The data-model child (#2011) owns the exact field names. The panel child (#2012) owns the layout. The chat-card and controls children (#2013, #2014) own the item controls and the card. None of them needs to re-decide a channel, an id rule, an authority rule, a status rule or a conflict rule from this document.

Claims cite a file and line as of `origin/main` at `dd56b639`. Anything not read from a file or an OMP doc is marked `[INFERENCE]`.

## Summary

- The agent **emits and updates** the plan with one new Refract host tool, `refract_plan`, answered natively in Rust. It uses the host tool channel of [ADR 0007](../adr/0007-agent-tool-channel.md). The tool takes no session id; it is bound to the calling Session.
- The developer **mutates** the plan through new Refract IPC requests. Rust applies a tick or a value directly to the store, so these work with the agent stopped.
- **Ask**, **give a value** and **complete this step** are real chat turns. Each is wrapped in a `<plan-item>` envelope, the way [ADR 0008](../adr/0008-session-message-envelope.md) wraps a Session message, and sent undecorated. The envelope carries the exact item id. A plain tick is stored and reaches the agent without a turn.
- The agent has **bounded authority**. It cannot edit or remove what the developer wrote, cannot complete a human-owned step, and cannot change the flags that gate completion.
- Rust **owns the plan** and **persists** it per Session in the Refract data directory. The OMP transcript is not the source of truth.
- The agent **learns of developer edits** from a persisted `agentSeenRev` watermark. A lost result frame never loses an edit.
- Everything ships on **today's rpc-ui wire**. No OMP-upstream capability is required, so no upstream request is raised.
- The plan **coexists** with the OMP todo pill and panel.

## Background: what exists today

| Fact | Evidence |
|---|---|
| The OMP todo arrives as a read-only frame. Each task has `content`, `status` and `blocker`. There is no id, value or owner. | `src/shared/todo.ts:1-13`, `src/shared/frames.ts:122` |
| Refract reads the todo from the `tool_execution_end` frame of OMP's `todo` tool. | `src-tauri/src/session/readout.rs:118-129` |
| The user can only touch the todo through allowlisted slash commands (`/todo append`, `start`, `done`, `rm`). These act on OMP's list by name, so they cannot carry a value or an item id. | `src/shared/slash-commands.ts:14` |
| The `ask` tool is bidirectional but one-shot: `answer_request` resolves one pending request with one answer. | `src-tauri/src/session/agent/requests.rs:13-57` |
| Refract registers its own host tools on every launch with `set_host_tools` and serves each `host_tool_call` on its own task. Tools use `loadMode: "essential"` and the `refract_` prefix. | `src-tauri/src/agent_tools/mod.rs:27`, `:77-95`, `:99-108`; `session/agent/launch.rs:333`; `router.rs:363-386` |
| Every launched Session is `Root` and gets the tools; `Role::Child` is empty and reserved for #1859. | `agent_tools/mod.rs:34-40`, `:51-56`, `:65-74` |
| Some Session tools are answered in Rust with no renderer round trip and no generic approval card. Each mutating one raises its own card. | `agent_tools/router_native.rs:14-37`; cards at `sessions_end.rs:381`, `approval.rs:56-69` |
| A tool result is capped at 8 KiB (`MAX_RESULT_BYTES`). `ok_frame` turns a larger result into a `result_too_large` error; it never cuts it. | `agent_tools/mod.rs:31`, `router.rs:162-176` |
| The approval overlay allows exactly the registered tool names, so a new tool joins it by joining `tools_for`. | `agent_tools/overlay.rs:13-19`, `mod.rs:65-74` |
| A user prompt reaches the agent through `prompt`. While the agent works it goes out with `streamingBehavior: "followUp"`. A paused Session holds it. A stopped Session refuses it with `agent-not-running`. | `session/agent/chat.rs:36-156` |
| `send_session_message` sends undecorated: no working-mode wrapper and no pending `[Refract]` notice, because "the envelope text must reach the target verbatim". | `chat.rs:49-57`, `:105-110` |
| One `[Refract]` notice can be prepended to the next decorated user prompt. It is a single `Option<String>`, and `tell_agent_why` overwrites it. | `chat.rs:105-121`, `handoff_queue.rs:71-79`, `:294-298` |
| A fixed text envelope in a user turn is parsed on transcript load, on the whole turn text, before the hidden-instruction cut, and becomes a typed `source` on the user item. | `agent_tools/envelope.rs:46-61`, `omp/transcript/message_source.rs:11-30`, `omp/transcript/file_attachment_markers.rs:162-175` |
| The envelope code knows only the tag `session-message`. | `envelope.rs:6-11`, `:100-131` |
| Refract already persists small per-key JSON stores atomically (write-tmp, fsync, rename; quarantine on parse failure). | `src-tauri/src/store/atomic_json.rs:12-67`, `store/handoff_notes.rs` |
| The Session delete path removes the registry row and the agent in one place, `remove()`. | `ipc/sessions_lifecycle/delete_in_flight.rs:123-165`, called through `delete_core.rs:129` |
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

- **Emit and update:** one typed, schema-checked call per change. The result tells the agent the new revision and the developer's edits since it last looked.
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
| 1 | Agent to Refract: emit | `host_tool_call` for `refract_plan`, `action: "create"` | `{ action, requestId, title, items: [{ text, owner?, requiresValue?, agentCompletable?, group? }], replace? }` | Rust assigns each id (`i1`, `i2`, ...) and returns them in the result. |
| 2 | Agent to Refract: update | `host_tool_call`, `action: "update"` | `{ action, baseRev, requestId?, ops: [Op] }` | Each op names an item by id, or by `after: <id>` for placement. |
| 3 | Agent to Refract: read | `host_tool_call`, `action: "get"` | `{ action, baseRev?, itemId?, full?, after? }` | Result returns compact items with their ids. |
| 4 | Refract to agent: acknowledge | `host_tool_result` for the same call | See "Result shape and size" | Ids in the result are the ids the next call must use. |
| 5 | Refract to renderer | Tauri event `plan:update` (new, beside `readout:update` in `src-tauri/src/events.rs`) | `{ sessionId, plan, by: "agent" \| "developer", opened?: true }` | The whole plan, so the renderer holds no merge logic. |
| 6 | Renderer to Refract: read | IPC request `plan.get` | `(sessionId)` returns the active plan or `null` | none |
| 7 | Renderer to Refract: tick, value, edit | IPC request `plan.mutate` | `(sessionId, planId, baseRev, requestId?, op)` | `op` names the item id. |
| 8 | Renderer to agent: ask / value / complete this step | IPC request `plan.itemMessage`, which sends an undecorated `prompt` | `(sessionId, planId, itemId, action: "ask" \| "value" \| "complete", text?)`, sent as a `<plan-item>` envelope | The envelope carries `plan`, `item` and `rev`. |
| 9 | Refract to agent: developer edits it has not acknowledged | `userChanges` in every `refract_plan` result, plus a hint line in the `[Refract]` notice | list of `{ rev, itemId, op, ... }` | Same ids. |
| 10 | Refract to disk | Write-through to `<data_dir>/plans/<sessionId>.json` | See "Persistence" | Same ids. |

The IPC names follow the existing `agentTools.result` pattern (`src-tauri/src/ipc/agent_tools.rs:10-13`). The renderer reaches them through the existing `refract_request` command (`src/tauri-bridge/index.ts:83-87`).

### Session binding and isolation

- **The tool takes no session id, now or ever.** The handler binds to `agent.tool_session_id()` (`session/agent/tool_host.rs:28`), as `sessions_send.rs:171` does for `self_id`. A child that adds a `sessionId` or `planId` argument to `refract_plan` breaks this rule.
- **Every `plan.*` IPC handler resolves `sessionId` against the live Session registry** before it touches the store, with the pattern of `with_router` (`ipc/agent_tools.rs:47-63`): `registry.lock().await.get_session(session_id)`, then `not_found` when it is missing. The file path is built only from the id the registry returns, never from the renderer's string. Without this, a crafted `sessionId` such as `..\working-modes` would make `write_json_file` (`atomic_json.rs:49-67`) overwrite another `.json` file in the data directory, and `read_json_file` (`:12-32`) would quarantine it.
- **`planId` must belong to that Session's store.** Otherwise `plan.mutate` and `plan.itemMessage` return `unknown_plan`.
- **Plan and item ids are per Session** (`p1`, `i1` repeat across Sessions). Nothing keys a plan by `planId` alone. A `<plan-item>` that reaches another Session through `refract_send_session_message` is wrapped in a `session-message` envelope and never parsed as a `plan-item` (see "Envelope").

### Emit

The agent calls `refract_plan` with `action: "create"`. Rust:

1. checks the arguments against the tool schema (the same `validate` used by the panel tools, `agent_tools/panels.rs:123`) and the size caps;
2. assigns the plan id (`p1`, `p2`, ...) and item ids;
3. persists the plan, then emits `plan:update` with `opened: true`, which is the signal that opens the right-pane panel (#2012). Only `create` sets `opened`;
4. returns the plan to the agent in the compact shape.

If an active plan has unfinished items, `create` fails with `plan_exists`. The agent passes `replace: true` to archive it and start a new one. A fully complete active plan is archived by the next `create` with no flag.

**Approval.** A plan call changes Refract-owned state only, and the developer sees it and can undo it, so `refract_plan` needs no generic file-change card. `router_native.rs:14-37` does not skip approval in general: each mutating Session tool raises its own card (`sessions_end.rs:381`). The plan tool raises one in a single case:

- `create` with `replace: true` raises a card, built with `approval::session_card` (`approval.rs:56-69`), when the active plan holds an unfinished item the developer wrote or filled in (`createdBy: developer`, or a developer-set value). The card names the count of such items and says their values are dropped from the archive. Unlike `needs_approval` (`approval.rs:21`), this card is not skipped in yolo, because it discards developer input. A denied card returns `denied`.

`[INFERENCE]` The plan tool adds a case to `run_native`; see "Integration points".

### Agent update

`action: "update"` takes `baseRev` (the revision the agent last saw), an optional `requestId`, and at most 20 operations. Rust applies all of them or none, in one file write.

| Op | Fields | Effect |
|---|---|---|
| `add` | `after?: id`, `item` | Inserts a new item. Appends when `after` is omitted. |
| `edit` | `id`, any of `text`, `group` | Changes the item's definition. |
| `move` | `id`, `after?: id` | Reorders. |
| `remove` | `id` | Removes an item. |
| `setStatus` | `id`, `status` | Sets the status. |
| `setValue` | `id`, `value` | Records a value on the item. |

#### Authorship

Every item records `createdBy` and `updatedBy` (`agent` or `developer`). A value records who set it (`valueBy`). A completed item records `completedBy`. The panel shows `updatedBy` on every completed item, so the developer can see who ticked it.

| Rule | Error |
|---|---|
| The agent cannot `edit` or `remove` an item with `createdBy: developer`, and cannot `remove` any item that holds a developer-set value. | `developer_item` |
| The agent cannot `setValue` on an item whose value is developer-set. | `developer_item` |
| `owner`, `requiresValue` and `agentCompletable` are fixed at creation. The agent cannot change them with `edit`. Only the developer can change them afterwards. | `field_locked` |
| The agent cannot complete an item with `owner: human`. | `human_owned` |
| The agent cannot complete a `requiresValue` item that has no developer-set value. An agent-set value does not count. The developer's own tick has no such gate beyond `value_required` below. | `value_required` |
| Completed items are frozen for the agent: `edit`, `move`, `remove`, `setValue` and any `setStatus` on a completed item fail, except that the agent may reopen an item it completed itself (`completedBy: agent`). | `item_complete` |

`value_required` also applies to the developer: ticking a `requiresValue` item with no value of any author fails, so the panel prompts for the value first.

Other rules:

- **Ids are never reused.** A removed id stays retired, so a stale reference can never silently hit a different item.
- **Only the developer reopens a developer-completed item.**
- **`replace: true` is the only agent path that retires several items at once.** It archives the plan; it never deletes. See "Approval".

#### Status lifecycle

The protocol needs these five statuses. #2011 owns the names but must not merge them.

| Status | Set by |
|---|---|
| `upcoming` | `add` default. `setStatus` by either party. The fallback for untick when no `previousStatus` is stored. |
| `next` | `setStatus` by either party. |
| `in_progress` | `setStatus` by the agent. Rust, when a `complete` turn is accepted (see "Complete this step"). |
| `blocked` | `setStatus` by either party. |
| `complete` | The developer's tick, always. The agent's `setStatus`, subject to the authorship rules. |

Whenever an item moves into `complete`, Rust stores its status just before as `previousStatus`. **Untick** restores `previousStatus` and clears it. Moving into any other status keeps the item's `previousStatus` unchanged.

#### Concurrency

Every accepted change by either party bumps the plan `rev` and stamps the touched items with that `rev`. An agent op is applied when every existing item it touches has an item `rev` at or below `baseRev`. Otherwise the whole call fails with `conflict`, and the error lists the current compact state of the conflicting items so the agent can re-plan without another `get`.

#### Retries

A lost result frame is a normal case (see "Persistence"). `add`, `move`, `remove` and `create` touch no existing item's `rev` (or create a new plan), so the `baseRev` check cannot stop a retry from applying twice. Structural calls therefore carry a client `requestId` (at most 64 bytes):

- `create`, and any `update` that contains `add`, `move` or `remove`, must have one; a call without it fails with `invalid_input`.
- Rust keeps the last 16 `{ requestId, rev, addedIds }` records per plan in the file. A call whose `requestId` is on record is not applied again. It returns the current compact result with `duplicate: true`, and `addedIds` so the agent learns the ids.
- `plan.mutate` accepts the same field for the same reason.

### Result shape and size

A result must never reach `result_too_large`, because `ok_frame` would drop the whole result, including `userChanges` (`router.rs:162-176`). Every field has a byte cap, and every list has a budget with an overflow flag.

**Caps** (UTF-8 bytes, not characters; an over-limit call fails with `too_large` naming the field):

| Field | Cap |
|---|---|
| Item `text` | 200 bytes |
| Plan `title` | 120 bytes |
| Item `group` | 60 bytes |
| Item `value` | 1 KiB |
| `plan.itemMessage` body | 4 KiB |
| Items per plan | 40 |
| Archived plans per Session | 5 |
| Ops per `update` | 20 |
| `requestId` | 64 bytes |

`text`, `title` and `group` reject control characters, and `value` rejects control characters other than newline and tab. JSON then escapes a byte at most to two bytes (`"`, `\`, newline, tab), which the arithmetic below uses.

**Compact result.** `create`, `update` and `get` return this shape:

```json
{
  "planId": "p2", "rev": 9, "seenRev": 9, "title": "...", "state": "active",
  "itemCount": 6, "duplicate": false,
  "items": [{ "id": "i3", "status": "complete", "rev": 9, "text": "...", "textTruncated": true,
              "owner": "agent", "requiresValue": true, "agentCompletable": true,
              "hasValue": true, "valueBytes": 28, "updatedBy": "developer" }],
  "moreItems": false,
  "userChanges": [{ "rev": 9, "itemId": "i3", "op": "setStatus", "status": "complete",
                    "by": "developer", "hasValue": true, "valueBytes": 28 }],
  "moreChanges": false
}
```

- Item text is cut to 60 bytes with `textTruncated: true`. A value is never inlined: only `hasValue` and `valueBytes`. The agent reads one in full with `get { itemId }`.
- `create` and `update` list in `items` only the items the call touched. `get` lists the plan in order from `after` (an item id; the first page when omitted).
- `get { full: true }` returns full items (full text, group, value) in pages with the same budget. `get { itemId }` returns exactly one full item.

**Arithmetic.** Budget 7,168 bytes of the 8,192 (`MAX_RESULT_BYTES`):

| Part | Worst case |
|---|---|
| Header (fixed keys about 180, title at most 120 bytes, at most 240 escaped) | 420 |
| One compact item: fixed keys, ids, flags and a four-digit `rev` 201, plus text at most 60 bytes, at most 120 escaped | 321 |
| One `userChanges` entry (`rev`, ids, `op`, `status`, `by`, `hasValue`, `valueBytes`) | 128 |
| `userChanges` budget: 20 entries | 2,560 |
| `items` budget: 13 compact items | 4,173 |
| Total: 420 + 2,560 + 4,173 | **7,153** |
| One full item: text 400 + group 120 + value 2,048 escaped + keys and flags at most 400 | 2,968 |

The total, 7,153, is under both the 7,168 budget and the 8,192 cap, so the worst-case result fits. One full item (2,968) fits the 4,173-byte `items` budget, so a `full` page and a `get { itemId }` always return at least one item. A 40-item plan needs at most four compact pages in the worst case, and fewer when text is short, because each list fills by bytes, not by count.

**Overflow.** A list that reaches its budget stops and sets its flag.

- `items` stops and sets `moreItems: true`. The agent calls `get` with `after` set to the last id it received.
- `userChanges` holds the **latest op per item** among developer changes with `rev` above the agent's `baseRev`, oldest `rev` first. It stops at 20 entries and sets `moreChanges: true`. `seenRev` is then the `rev` of the last entry returned. Otherwise `seenRev` equals `rev`. The tool description tells the agent to quote `seenRev`, not `rev`, as its next `baseRev`, so the remainder arrives on the next call.

### User mutate

The panel sends `plan.mutate`:

| Developer action | Op sent |
|---|---|
| Tick an item | `setStatus` to `complete` |
| Untick | `setStatus` that restores `previousStatus` |
| Provide a value | `setValue` |
| Edit, add or remove an item | `edit`, `add`, `remove` (the agent's vocabulary, plus `owner`, `requiresValue` and `agentCompletable` in `edit`, and without the completed-item freeze or the authorship limits) |

Rust applies the op under the per-Session lock, bumps `rev`, persists, emits `plan:update` with `by: "developer"`, and returns the new plan. `plan.mutate` takes `baseRev`. It fails with `item_changed`, applying nothing and returning the current plan, only when the agent changed the target item at a revision above `baseRev`. The panel shows the agent's change and the developer repeats the action. A developer op never conflicts with another developer op.

Nothing here talks to the agent, so a tick or a value never interrupts a running turn.

### Envelope

The `<plan-item>` envelope and the `session-message` envelope share one parser and escape table in `agent_tools/envelope.rs`. Today that file knows only `session-message` (`envelope.rs:6-11`, `:100-131`), so the child that adds `<plan-item>` (#2013 for the send side, with #2014 for the transcript source) first **generalises it to a tag-parameterised escape and parser**:

- **One escape for both tags.** A body escapes the tags of *both* envelopes. `</plan-item>` in an item's text, and `<session-message ...>` in a developer value, shift one level up with the existing bijective `&amp;`-prefix scheme and shift back on parse. Round-trip tests cover each tag inside each envelope.
- **Exactly one envelope per turn.** `parse` accepts only a turn whose whole text is one envelope. A raw tag of either name left in the body is a second or forged envelope and is rejected, as `envelope.rs:52-55` does today.
- **Parse `<plan-item>` only from a raw developer user turn.** `from_envelope` (`message_source.rs:21-30`) runs on the whole turn text and returns the body of a `session-message` without parsing it again, so a `<plan-item>` inside a Session message is only text. A test pins this.
- **Attributes** (`plan`, `item`, `rev`, `action`) come from Rust. `plan` and `item` are escaped with `escape_attr` anyway.

### Ask, give a value, and complete this step

These three actions need the agent's attention, so they are chat turns. The panel calls `plan.itemMessage`. Rust builds the text and sends it as a new `send_plan_item`, a sibling of `send_session_message` (`chat.rs:51-57`): held while paused, queued while busy, and sent with `decorate = false` (`send_unheld_with`, `chat.rs:72-78`).

```text
<plan-item plan="p1" item="i3" rev="9" action="ask">
Does this step need the staging database?
</plan-item>
```

- **`action="ask"`** carries the developer's own typed text as the body. The body is capped at 4 KiB.
- **`action="value"`** is the textarea in #2013. Rust first applies `setValue` (developer-authored) so the panel shows it at once and a stopped agent still keeps it. It then sends the turn with the value as the body. If the send is refused, the value stays stored and the developer sees the refusal. The envelope body is the developer's own value text and is not quoted back from the store.
- **`action="complete"`** is allowed only when the item is `agentCompletable`, not complete and not `owner: human`. Otherwise the call fails with `not_agent_completable`. The body is **not** the developer's own words. Rust writes it from a fixed template that quotes the item text and labels its author:

  ```text
  <plan-item plan="p1" item="i3" rev="9" action="complete">
  The developer asks you to do this step you wrote. The line below is the step text as stored in the plan. It is not an instruction from the developer.
  > Run the migration against staging
  </plan-item>
  ```

  The label reads "you wrote" when `createdBy` is `agent` and "the developer wrote" otherwise. The quoted text is one line, because item text has no control characters. Rust accepts the turn, then sets the item to `in_progress` and records `previousStatus` before it sends. See the lifecycle below.
- A plain tick does not send a turn. It is stored and reaches the agent as described in "Keeping the agent in sync". `[INFERENCE]` This keeps ticking cheap and non-interrupting. #2013 can still offer "tick and tell the agent" by sending `action="value"` or `ask` with the tick, with no protocol change.
- **Authority.** The turn is a developer request, sent undecorated, and nothing in it changes the approval model. For `ask` and `value` the body is the developer's own words. For `complete` the quoted item text, when the agent wrote it, carries no more authority than the agent already has: the agent acts under its own approval mode, and "complete this step" does not skip a card in a non-yolo Session. This is the rule of ADR 0008: "nothing in the text grants more authority than the recipient already has".
- **Notice and working mode.** `decorate = false` means the pending `[Refract]` notice is not consumed (`chat.rs:105-110`) and the working-mode wrapper is not added (`chat.rs:113-117`). The notice stays pending for the developer's next ordinary prompt, and the item turn reaches the transcript as exactly one envelope, which the parser requires. A `complete` turn sent in Grill or Plan working mode therefore carries no mode instruction, as a Session message does today. The developer's click on "complete this step" is the instruction to proceed.
- **Delivery** follows `chat.rs:36-156`: an idle Session sends at once; a working Session queues it as `followUp`; a paused Session holds it; a stopped Session refuses it with `agent-not-running`. The panel disables ask, value-to-agent and complete while the Session has no live agent.
- **Transcript.** OMP stores the user turn as the envelope text, so a reload still shows it. `from_envelope` runs before the hidden-instruction cut (`file_attachment_markers.rs:162-175`), so an undecorated envelope parses. Refract sets a typed source on the user item, a new `MessageSource` variant `PlanItem { planId, itemId, action }` (`message_source.rs:11-18`).
- The agent then acts through `refract_plan update`. It never has to guess which item the developer meant, because the envelope names it.

#### Complete-this-step lifecycle

1. Rust accepts the call, stores `previousStatus`, sets the item to `in_progress` and records `pendingComplete { itemId }` on the plan, under the lock, then sends the turn.
2. If the send is refused (`agent-not-running`, `prompt-failed`), Rust restores the previous status and clears `pendingComplete` before the call returns an error.
3. The agent's `setStatus` on that item, to any status, clears `pendingComplete`. `setStatus: complete` completes it. Another status, such as `blocked`, stays.
4. If the turn settles with `pendingComplete` still set, Rust restores `previousStatus`, clears the flag and emits `plan:update`. The hook is the turn-settle step (`session/agent/frame.rs:195-231`), which an aborted turn also reaches (`turn_abort_requested`, `frame.rs:207-211`). A chat-only answer, an aborted turn and a stopped agent therefore all end with the item back where it was, never stuck. A process exit clears it the same way. On load, a stale flag is cleared when the Session is idle.
5. `[INFERENCE]` A turn queued as a follow-up behind a running turn may settle once before it starts. #2011 verifies the ordering with a live check and clears the flag only on the settle that follows the envelope's own turn.

### Keeping the agent in sync with developer edits

A tick or a value changes the plan without a turn. The agent finds out in two ways, and a loss of either never loses an edit.

1. **Pull, from a persisted watermark.** The plan stores `agentSeenRev`. A `refract_plan` call that quotes `baseRev` first raises `agentSeenRev` to `baseRev` (never lowering it, never above `rev`), in the same write as the call's own op. The result's `userChanges` are developer changes with `rev` above `baseRev`, or above `agentSeenRev` when a `get` quotes none. The watermark never advances on reading: it advances only when a later call quotes a `seenRev` it was given. If a result is lost (the call is cancelled, `result_too_large`, a crash), the next call returns the same changes again.
2. **Hint with the next prompt.** When the developer sends a normal prompt and a plan has developer changes above `agentSeenRev`, Rust adds a hint line to the notice. It is built when the notice is taken, from the current `rev`, so it is never stale. It carries ids and ops only, never item text or values, because it is injected into the prompt unescaped: `Plan p1 changed by the developer after rev 8: tick i2, value i3. Call refract_plan get.`

The notice is a hint only. The agent's `userChanges` is the record. A long working turn gets no hint, and the agent still sees every change on its next tool call.

**Notice slot.** `pending_agent_notice` is one `Option<String>` today, and `tell_agent_why` overwrites it (`handoff_queue.rs:72-78`, `:295-298`). It becomes a list. `tell_agent_why` appends, the plan hint is one more line, `take_pending_notice` returns the lines and `with_notice` prefixes each with `[Refract]`. A refused send puts the taken lines back at the front (`chat.rs:136-141` currently does a `get_or_insert`).

### Conversation switch and relaunch (#1861)

The plan is scoped to the Session, so a new or switched Conversation keeps it. The new Conversation's agent does not know it exists. On Conversation start or switch (`sessions_conversations*.rs`), and on relaunch with an active plan, Rust adds one notice line: `Plan p2 is active: rev 9, 3 of 8 items complete. Call refract_plan get.` It carries counts and ids, never the title. The agent re-reads with `get` and its `baseRev` from an older Conversation is not trusted: the first call after a switch must quote the `seenRev` of a fresh `get`, or it fails with `conflict` on any item changed since. `[INFERENCE]` The first message of a Conversation that a Session-sourced handoff starts is sent undecorated, so the line then waits for the developer's next prompt. The tool description covers that gap: it tells the agent to call `get` before editing a plan it did not create in this run.

## Persistence

| Question | Answer |
|---|---|
| Where | `<data_dir>/plans/<sessionId>.json`, with `data_dir` from `src-tauri/src/lib.rs:27`. `sessionId` is the registry's id (see "Session binding and isolation"). One file per Session. |
| Scope | Per Session, not per Conversation: a new Conversation in the same Session keeps the plan. The plan records the Conversation it was created in, for provenance only. |
| Writer | Rust only, write-through on every accepted change, before the tool result or event goes out. Use `store/atomic_json.rs` (temp file, fsync, rename). |
| Atomic apply | The handler runs the apply on a detached task and awaits it. `serve` drops the call on cancel (`router.rs:363-370`), so a cancel can never leave a call half-applied. The result of a cancelled call is lost, which the watermark and `requestId` make safe. |
| Order | Clone the plan, apply the op to the clone, write the file, and only then swap the in-memory copy. A failed write leaves memory unchanged and returns `write_failed` to the agent or an `IpcError` to the renderer. It is never a `log::warn` only, as `handoff_notes.rs` does. |
| Lock | One lock per Session, not one global lock, held across apply, write and swap. |
| Corrupt file | `atomic_json` renames it to `<name>.json.corrupt-<millis>` and starts empty (`atomic_json.rs:12-43`). The plan store keeps at most the newest 3 quarantine files per Session and deletes leftover `.tmp` files on load. |
| Session deleted | `remove()` in `src-tauri/src/ipc/sessions_lifecycle/delete_in_flight.rs` deletes the plan file after `remove_agent` (line 158) and tombstones the Session's store entry under the per-Session lock. It is the only place that removes the registry row (`:155`). |
| Missing Session | Every plan call checks the registry and `delete_in_flight::is_deleting`, as `still_exists` does (`handoff_queue.rs:284-292`), under the lock. A call for a missing or deleting Session fails with `unknown_session` and never creates the file, so an in-flight call cannot recreate it. |
| History | The newest 5 archived plans stay in the file, with item values dropped. The panel shows only the active plan. |
| Values are not secrets | A value is plain text in the JSON file, in the agent's tool results and prompt, and in OMP's own session file. #2013's value control shows a warning ("This is sent to the agent and stored unencrypted. Do not enter passwords or keys."). `requiresValue` is not a credential prompt. |

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
      "agentSeenRev": 7,
      "nextItemSeq": 6,
      "createdInConversation": "c-1",
      "state": "active",
      "pendingComplete": null,
      "recentRequests": [{ "requestId": "r-41", "rev": 8, "addedIds": ["i5"] }],
      "items": [
        {
          "id": "i3",
          "text": "Run the migration against staging",
          "status": "complete",
          "previousStatus": "in_progress",
          "owner": "agent",
          "requiresValue": true,
          "value": "ran 12 migrations, 0 failed",
          "valueBy": "developer",
          "agentCompletable": true,
          "rev": 9,
          "createdBy": "agent",
          "updatedBy": "developer",
          "completedBy": "developer"
        }
      ]
    }
  ]
}
```

### Restart behaviour

- **App restart.** Nothing is loaded until the Session is opened. On open, Rust reads the file, the renderer calls `plan.get` and subscribes to `plan:update`. The panel shows the saved plan with no agent running. Ticks and values still work.
- **Agent restart or reattach.** The OMP transcript holds the earlier `refract_plan` calls and results, but the store is the truth. The tool description tells the agent to call `get` before it edits a plan it did not create in this run. Developer changes above `agentSeenRev` reach it with its next result, and a hint on its next prompt.
- **Process crash mid-call.** The write happens before the result is sent. If the result is lost, the agent retries with the same `requestId`, or calls `get`. A retry returns `duplicate: true` and does not apply twice. Developer changes it never saw are returned again, because the watermark did not move.

## Integration points

`refract_plan` is not a Session tool, so it does not fit the `SESSION_TOOLS` path. These places change, in this order:

| Place | Change |
|---|---|
| `tools_for` (`agent_tools/mod.rs:65-74`) | Add `refract_plan` to the `Role::Root` list, so the overlay and `set_host_tools` include it. |
| `host_tool_defs` (`mod.rs:77-95`) | The `is_session_tool` branch (`:81-85`) sends every other name to `panels::tool_description`, so add a plan branch before the `else`, or `refract_plan` falls into the panels branch. |
| `router::plan` (`router.rs:101-156`) | Add an arm that validates the arguments and returns `Plan::Native`. Today an unknown name returns `UNKNOWN_TOOL` (`:151-154`). |
| `run_native` (`router_native.rs:15-37`) | Add an arm before `_ => sessions_send::send` (`:35`). Without it, a plan call is routed to `send` and fails there. |
| `mod.test.rs:38` | The count of `host_tool_defs` goes from 17 to 18, and the names list at `:4-27` gains `refract_plan`. |
| `overlay.rs:38-41` | The golden string gains `refract_plan: allow`. |
| `register_host_tools` (`mod.rs:99-108`) | Return the outcome, so a refused `set_host_tools` is shown (see "Failure cases"). |
| `agent_tools/envelope.rs` | Generalise to a tag-parameterised escape and parser (see "Envelope"). |
| `MessageSource` (`message_source.rs:11-18`) | Add the `PlanItem` variant. |
| Notice slot (`handoff_queue.rs:72-78`, `:295-298`; `chat.rs:136-141`) | Option to list. |
| `delete_in_flight.rs:158` | Delete the plan file and tombstone the store. |

**Name clash.** Refract's `WorkingMode::Plan` (`session/working_mode/mod.rs:17-23`) and OMP's own plan mode are working modes, not the **Plan**. The tool description says `refract_plan` is the plan the developer sees in the panel and is not plan mode. UI text keeps "Plan" for the panel and "plan mode" for the working mode.

**Open question for #2011.** Whether OMP host tools stay callable in OMP's plan mode is `[INFERENCE]` and unverified. #2011 verifies it live. If they do not, the tool description tells the agent to leave plan mode to edit the Plan, and the panel stays usable by the developer.

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
| Agent paused | A `plan.itemMessage` turn is held and sent on resume (`MessageDelivery::Held`). |
| Agent working | Ticks apply at once. Ask, value and complete queue as follow-ups. The agent reads `userChanges` on its next call. |
| Stale item id | `unknown_item` for an id that never existed. `item_removed` for a retired id. The error includes the current compact item list. |
| Concurrent edit | `conflict` lists the items that changed after `baseRev`. Nothing is applied. |
| Developer op on an item the agent changed | `item_changed`; nothing is applied. |
| Agent edits or removes a developer item or value | `developer_item`. |
| Agent changes a fixed flag or owner | `field_locked`. |
| Agent completes a human-owned item, or a `requiresValue` item with no developer value | `human_owned`, `value_required`. |
| Edit to a completed item by the agent (not one it completed itself) | `item_complete`. |
| Retry of a structural call | `duplicate: true` with the recorded ids; not applied twice. |
| Unknown plan id (old envelope, wrong Session) | The agent or the IPC gets `unknown_plan`; the card still renders from the transcript. |
| Missing or deleting Session | `unknown_session`; nothing is written. |
| Over a cap | `too_large`, naming the field. |
| Write failure | `write_failed`; memory unchanged. |
| `replace: true` card denied | `denied`; the plan is unchanged. |
| `set_host_tools` refused by OMP | The Session works as a plain agent with no `refract_plan` (`mod.rs:99-108`). Refract records the refusal and the panel shows "The plan tool is unavailable: omp did not accept the host tools." beside the empty plan, instead of staying silently empty. |
| Corrupt store | Quarantined (newest 3 kept); the plan is lost but the Session works. |
| The model answers with an inline plan and never calls the tool | No plan is created. The developer says "put this in the plan panel"; the model then calls `create`. `[INFERENCE]` This is a model-compliance risk, reduced by the tool description, and there is no parsing fallback by design (Option B). |
| Child Session | `tools_for` returns no tools for `Role::Child` (`mod.rs:72`); every launched Session is `Root` today (`mod.rs:34-35`, `:51-56`), so each Session has its own plan. |

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

- A host tool result is text with an 8 KiB cap, so the plan result is compact by design (see "Result shape and size").
- OMP cannot push a developer edit into a running turn. A tick reaches the model on its next tool call or the next prompt. This is acceptable because ticks are bookkeeping, not instructions.

## What each child builds

| Child | Builds, from this document |
|---|---|
| #2011 data model and store | The shared TS and Rust plan and item types (field names; the five-status set and the lifecycle above), the `plans/<sessionId>.json` store with a per-Session lock, detached apply and write-then-swap, id, `rev`, `agentSeenRev` and `requestId` handling, the op engine with the authorship, freeze, `value_required` and conflict rules, the byte caps and the compact result, quarantine cleanup, the delete hook, and the `refract_plan` tool schema and handler. Verifies whether host tools work in OMP plan mode. |
| #2012 right-pane panel | Subscribes to `plan:update`, opens on `opened: true`, calls `plan.get`, and renders the plan, `updatedBy` on completed items, and the "plan tool unavailable" state. Sends `plan.mutate` with `baseRev` for ticks and values. |
| #2013 per-item controls | Ask, provide value and complete-this-step controls, calling `plan.mutate` and `plan.itemMessage`, disabled when the Session has no live agent. A plain tick calls `plan.mutate` only. **"The agent is told" means** the developer's change appears in the agent's next `refract_plan` result as `userChanges`, with a hint in the next prompt's notice; it does not interrupt a running turn. The value control carries the plaintext warning. Adds the generalised envelope and `send_plan_item`. |
| #2014 chat card | Renders the `PlanItem` source. **The card is the developer turn** (the user item with that source). **Its replies are the assistant turns after it until the next developer turn**, which is the next user item of any kind, including another `<plan-item>` and a Session message. |
