# Contract: renderer to main additions for Side chat

Extends spec 001's `contracts/ipc.md` (the `Result<T>` envelope, error codes, constitution V) and
spec 004's `subagents.*` request/event trio (the closest existing precedent for a per-Session,
streamed, cancellable sub-conversation).

## Requests

### Side chat (FR-002 to FR-007)

| Method | Returns | Notes |
|---|---|---|
| `sideChat.ask(sessionId, question, recordId?)` | `{ recordId: string }` | Issues `{type:"btw", question, recordId?}` to that Session's OMP process. Returns the new record's own id immediately (the `running` record, FINDINGS item 14); the answer itself arrives over `SIDE_CHAT_PATCH`, not this call's own return value. `recordId` omitted starts a fresh topic (FR-003). A blank `question` is rejected locally with `invalid-argument` before ever reaching OMP (one of `btw`'s own documented failure cases, issue://516 -- caught client-side to avoid a round trip for a case Refract can already detect). |
| `sideChat.cancel(sessionId)` | `void` | Issues `btw_cancel` for that Session's currently-running record, if any. A no-op (not an error) if nothing is running -- mirrors `subagents.cancel`'s own idempotent shape. |
| `sideChat.getHistory(sessionId)` | `SideChatRecord[]` | Issues `get_btw_history`; returns every record OMP has for that Session's saved session file, in the order OMP returns them. Called once per Session per app run (FR-004), not polled. |

## Events (main to renderer)

| Event | Payload | Notes |
|---|---|---|
| `SIDE_CHAT_PATCH` (`side-chat:patch`) | `{ sessionId, delta?: string, record?: SideChatRecord }` | Pushed whenever that Session's OMP process emits a `btw_delta` (`delta` set, `record` omitted -- append) or a `btw_record` (`record` set, `delta` omitted -- replace/settle). Mirrors `SUBAGENT_PATCH`'s own shape exactly (data-model.md, research.md decision 6). A `btw` request OMP itself cancels (Session switch, `new_session`, `fork`, `open_session`, shutdown) arrives as an ordinary `btw_record` with `status: "cancelled"` through this same channel -- no separate event for that case (FR-006). |

## Error codes added

| Code | When |
|---|---|
| `invalid-argument` (existing code, no new one needed) | A blank `question` passed to `sideChat.ask`, or a non-string `sessionId`/`question` -- the same catch-all every other request already uses for a malformed payload. |

No new error code is added for OMP's own `btw` failure cases (one already running, unknown
`recordId`, no model, history-save failure): each of those arrives as a `btw_record` with
`status: "error"` and its own `error` text (data-model.md), rendered in the panel (FR-008), not
surfaced as an IPC-layer error -- the request to OMP itself still succeeded; it is the side
question's own outcome that failed.

## Non-IPC: the thread's own state

`side-chat-store.ts` (`SideChatThreadState`, data-model.md) holds only what is currently loaded or
in flight -- it is rebuilt fresh on every launch (no renderer-side persistence) because
`get_btw_history` is the single source of truth for anything older than this app run (FR-004,
same reasoning spec 013's `future/open-questions.md` already used for its own non-persisted
`right-pane-store.ts`).
