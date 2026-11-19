# The interactive plan moves over a Refract host tool, IPC and a chat-turn envelope

Status: Accepted. Date: 2026-11-19. Decider: Stuart (delegated to Skippy; reversible, see the comment on #2010).

Epic #2015 adds a durable plan the agent and the developer both edit, separate from the agent's own todo. Spike #2010 had to choose how it is emitted, updated, mutated and persisted. The full design is in [`docs/design/interactive-plan-protocol.md`](../design/interactive-plan-protocol.md).

**Context:**

- OMP's todo is read-only to Refract, has no item id, value or owner, and the only user write path is name-matched `/todo` slash commands (`src/shared/todo.ts:1-13`, `src/shared/slash-commands.ts:14`).
- The `ask` tool is one-shot (`src-tauri/src/session/agent/requests.rs:13-57`).
- [ADR 0007](0007-agent-tool-channel.md) already gives Refract host tools over the RPC stream, answered in Rust.
- [ADR 0008](0008-session-message-envelope.md) already carries a typed label inside a user turn.

**Decision:**

- **Rust owns the plan.** It is stored per Session in `<data_dir>/plans/<sessionId>.json`, written through on every change. The OMP transcript is not the source of truth.
- **The agent emits and updates through one host tool, `refract_plan`** (`create`, `update`, `get`), answered natively in Rust. Item ids are assigned by Rust and never reused. Updates are atomic and carry a `baseRev`. Completed items are frozen to the agent.
- **The developer mutates through Refract IPC** (`plan.get`, `plan.mutate`), not through the agent, so ticks and values work with the agent stopped.
- **Ask, give a value and complete this step are chat turns** wrapped in a `<plan-item plan item rev action>` envelope, sent through the normal prompt path. The envelope names the exact item and becomes a typed source on the transcript user item.
- **Developer edits that are not a turn** reach the agent in the next `refract_plan` result (`userChanges`) and as a `[Refract]` notice on the next prompt.
- **The plan coexists with the OMP todo.** The todo path is unchanged.
- **No OMP-upstream capability is required.** The design uses only `set_host_tools`, `host_tool_call`, `host_tool_result` and `prompt`.

**Alternatives rejected:**

- A fenced block in the assistant text: no acknowledgement to the agent, no stable ids, and a parser that must tell a plan from a quoted example.
- Extending the OMP todo: it needs an OMP change, and the plan is meant to be distinct from the todo.
- The `ask` tool: one question and one answer, not a long-lived object.
- A plan file edited with the agent's file tools: no schema, no atomic update, and it pollutes the repository.

**Consequences:**

- `src-tauri/src/agent_tools/` gains a `refract_plan` tool and joins `tools_for`, so the approval overlay allows it. A change to OMP's host tool frames can break the plan, so the OMP review (#689) already checks it with the other `refract_` tools.
- The `<plan-item>` envelope is persisted in OMP session files. Changing it later needs the parser to accept both the old and the new form, as for ADR 0008.
- A new `plan:update` event and `plan.get`, `plan.mutate` and `plan.itemMessage` IPC requests are added. The panel, controls and chat card (#2012 to #2014) build on them without re-deciding the protocol.
- The model must choose to call the tool. If it writes an inline plan instead, nothing is parsed; the developer asks for it to go into the plan panel.
