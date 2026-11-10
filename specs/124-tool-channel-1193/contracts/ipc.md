# Contract 124: `agentTools.*` IPC

Panel action shapes live in `panel-actions.json`. Commands return the shared `Result` envelope.

```ts
export type AgentToolReply =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } }
```

| Channel | Args | Result |
| --- | --- | --- |
| `agentTools.result` | `sessionId: string, callId: string, reply: AgentToolReply` | `null`; answers a pending `host_tool_call`; a result for another Session's id is refused |

Event `agent-tools:call` `{ sessionId, callId, tool, args }` is emitted when the agent calls a `refract_` host tool (`refract_list_panels`, `refract_open_panel`, `refract_invoke`). The renderer runs the panel action and replies with `agentTools.result`.

Approval: an action with `mutates: true` raises a card through `chat.answer` with id `refract-tool-<callId>` (Approve/Deny). Deny replies `{ ok: false, error: { code: 'denied' } }`. Yolo Sessions skip the card.

Errors (tool error codes returned to the agent). Rust router: `unknown_tool`, `unknown_panel`, `unknown_action`, `invalid_input`, `denied`, `timeout`, `cancelled`, `result_too_large`, `renderer_unavailable`. Renderer replies: `unknown_panel`, `unknown_action`, `invalid_input`, `panel_unavailable` (panel not available, or the caller is not the front Session), `action_failed` (the action ran and failed).
