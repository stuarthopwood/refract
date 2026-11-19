# The interactive plan moves over a Refract host tool, IPC and a chat-turn envelope

Status: Accepted, revised 2026-11-19 after two adversarial reviews. Date: 2026-11-19. Decider: Stuart (delegated to Skippy; reversible, see the comment on #2010).

Epic #2015 adds a durable plan the agent and the developer both edit, separate from the agent's own todo. Spike #2010 had to choose how it is emitted, updated, mutated and persisted. The full design is in [`docs/design/interactive-plan-protocol.md`](../design/interactive-plan-protocol.md).

**Context:**

- OMP's todo is read-only to Refract, has no item id, value or owner, and the only user write path is name-matched `/todo` slash commands (`src/shared/todo.ts:1-13`, `src/shared/slash-commands.ts:14`).
- The `ask` tool is one-shot (`src-tauri/src/session/agent/requests.rs:13-57`).
- [ADR 0007](0007-agent-tool-channel.md) already gives Refract host tools over the RPC stream, answered in Rust.
- [ADR 0008](0008-session-message-envelope.md) already carries a typed label inside a user turn.

**Decision:**

- **Rust owns the plan.** It is stored per Session in `<data_dir>/plans/<sessionId>.json`, written through on every change, one lock per Session. The OMP transcript is not the source of truth. A write failure is an error to the caller, never only a log line.
- **The agent emits and updates through one host tool, `refract_plan`** (`create`, `update`, `get`), answered natively in Rust. The tool takes no session id: it is bound to the calling Session. Item and plan ids are assigned by Rust, are per Session and are never reused. Updates are atomic, carry a `baseRev`, and structural calls carry a `requestId`, so a retried `add` does not duplicate.
- **The agent has bounded authority.** It cannot edit or remove an item the developer wrote or a value the developer set. `owner`, `requiresValue` and `agentCompletable` are fixed at creation, and only the developer changes them afterwards. It cannot complete a human-owned item, or a `requiresValue` item with no developer-set value. It may reopen an item it completed itself. Only `create` with `replace: true` over unfinished developer input raises an approval card; every other call changes Refract-owned state only and needs none.
- **The developer mutates through Refract IPC** (`plan.get`, `plan.mutate`), not through the agent, so ticks and values work with the agent stopped. Every `plan.*` handler resolves `sessionId` against the live Session registry, builds the file path only from the registry's id, and rejects a `planId` that is not in that Session's store.
- **Ask, give a value and complete this step are chat turns** wrapped in a `<plan-item plan item rev action>` envelope, sent undecorated like a Session message. The envelope names the exact item and becomes a typed source on the transcript user item. `agent_tools/envelope.rs` is generalised to a tag-parameterised escape and parser: each tag's body escapes both `plan-item` and `session-message`, exactly one envelope is allowed per turn, and `<plan-item>` is parsed only from a raw developer user turn, never from inside a `session-message` body.
- **Authority of the turn.** For `ask` and `value`, the body is the developer's own words. For `complete`, the body is a fixed template that quotes the item text and labels it as written by the agent or the developer: "the developer asks you to do this step you wrote". The quoted text is not the developer's instruction. As in ADR 0008, the recipient acts under its own approval mode and nothing in the turn grants more authority than it already has.
- **Developer edits that are not a turn** reach the agent from a persisted `agentSeenRev` watermark: every `refract_plan` result lists the developer changes above the revision the agent quotes (`userChanges`). The `[Refract]` notice on the next prompt is a hint with ids and ops only, never item text or values. The watermark moves only when a later call quotes it, so a lost result never loses an edit.
- **Results are bounded.** Caps are in UTF-8 bytes (item text 200, title 120, group 60, value 1 KiB, itemMessage body 4 KiB, 40 items, 5 archived plans), and the worst-case result is shown to fit `MAX_RESULT_BYTES` (8192) with a compact shape and overflow flags. The design never relies on `result_too_large`.
- **Values are not secrets.** A value is plain text in the plan file, the tool results, the prompt and OMP's session file. #2013's value control warns the developer. Archived plans drop their values.
- **The plan coexists with the OMP todo.** The todo path is unchanged. The Plan is not Refract's `WorkingMode::Plan` or OMP's plan mode.
- **No OMP-upstream capability is required.** The design uses only `set_host_tools`, `host_tool_call`, `host_tool_result` and `prompt`.

**Alternatives rejected:**

- A fenced block in the assistant text: no acknowledgement to the agent, no stable ids, and a parser that must tell a plan from a quoted example.
- Extending the OMP todo: it needs an OMP change, and the plan is meant to be distinct from the todo.
- The `ask` tool: one question and one answer, not a long-lived object.
- A plan file edited with the agent's file tools: no schema, no atomic update, and it pollutes the repository.
- A clear-on-read `unseen` list for developer edits: a lost result frame would lose the edits.

**Consequences:**

- `src-tauri/src/agent_tools/` gains a `refract_plan` tool and joins `tools_for`, so the approval overlay allows it. `host_tool_defs`, `router::plan`, `run_native`, the `host_tool_defs` count in `mod.test.rs` and the `overlay.rs` golden string change with it. A change to OMP's host tool frames can break the plan, so the OMP review (#689) already checks it with the other `refract_` tools.
- The `<plan-item>` envelope is persisted in OMP session files. Changing it later needs the parser to accept both the old and the new form, as for ADR 0008.
- The shared envelope code, the single `[Refract]` notice slot (it becomes a list) and `remove()` in `delete_in_flight.rs` (it deletes the plan file) change. These are not plan-only edits, so #2011 and #2013 own them.
- A new `plan:update` event and `plan.get`, `plan.mutate` and `plan.itemMessage` IPC requests are added. The panel, controls and chat card (#2012 to #2014) build on them without re-deciding the protocol.
- The model must choose to call the tool. If it writes an inline plan instead, nothing is parsed; the developer asks for it to go into the plan panel.
- Whether host tools stay callable in OMP's plan mode is unverified. #2011 checks it live.
