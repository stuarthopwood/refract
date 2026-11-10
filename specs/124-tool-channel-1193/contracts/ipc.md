# Contract 124: `agentTools.*` IPC

Panel action shapes live in `panel-actions.json`. Commands return the shared `Result` envelope.

```ts
export type AgentToolReply =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } }
```

| Channel | Args | Result |
| --- | --- | --- |
| `agentTools.result` | `sessionId: string, callId: string, reply: AgentToolReply` | `{ accepted: boolean }`; `accepted` is false when the call id is not pending in that Session's own router (another Session's id, a late or repeated answer); an unknown Session is a `not_found` error |

Event `agent-tools:call` `{ sessionId, callId, tool, args }` is emitted when the agent calls a `refract_` host tool (`refract_list_panels`, `refract_open_panel`, `refract_invoke_panel_action`). The renderer runs the panel action and replies with `agentTools.result`.

Approval: an action with `mutates: true` raises a card with request id `refract-tool-<callId>` (Approve/Deny), answered through `chat.answer`. Deny returns the agent a tool error with code `denied`; cancelling returns `cancelled`. Yolo Sessions skip the card.

Errors (tool error codes returned to the agent). Rust router: `unknown_tool`, `unknown_panel`, `unknown_action`, `invalid_input`, `denied`, `timeout`, `cancelled`, `result_too_large`, `renderer_unavailable`. Renderer replies: `unknown_panel`, `unknown_action`, `invalid_input`, `panel_unavailable` (panel not available, or the caller is not the front Session), `action_failed` (the action ran and failed).
