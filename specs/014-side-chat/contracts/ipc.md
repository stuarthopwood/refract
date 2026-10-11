# Contract: renderer to main additions for Side chat

Extends spec 001's `contracts/ipc.md` (the `Result<T>` envelope, error codes, constitution V) and
spec 004's `subagents.*` request/event trio (the closest existing precedent for a per-Session,
streamed, cancellable sub-conversation).

## Requests

### Side chat (FR-002 to FR-007)

| Method | Returns | Notes |
|---|---|---|
| `sideChat.ask(sessionId, question, recordId?)` | `{ record: SideChatRecord }` | Issues `{type:"btw", question, recordId?}` to that Session's OMP process. Returns the new record's own whole shape immediately (gate-fix round 2: the bare id alone lost the status OMP returned, which could leave the panel stuck on "Thinking" when a terminal `btw_record` raced the invoke reply back, or when the response itself carried `status:"error"`). The answer itself also arrives over `SIDE_CHAT_PATCH`. `recordId` omitted starts a fresh topic (FR-003). A blank `question` is rejected locally with `invalid-argument` before ever reaching OMP (one of `btw`'s own documented failure cases, issue://516); so is a non-empty `recordId` longer than 200 characters. |
| `sideChat.cancel(sessionId)` | `void` | Issues `btw_cancel` for that Session's currently-running record, if any. A no-op (not an error) if nothing is running -- mirrors `subagents.cancel`'s own idempotent shape. |
| `sideChat.getHistory(sessionId)` | `SideChatRecord[]` | Issues `get_btw_history`; `get_btw_history` itself returns a nested per-topic tree (`BtwHistoryThread`/`BtwHistoryNode`, data-model.md -- corrected 2026-10-11, live verification), flattened to this flat, ordered `SideChatRecord[]` by `SessionAgent.flattenBtwHistory` before crossing the IPC boundary. Called once per Session per app run (FR-004), not polled. |

## Events (main to renderer)

| Event | Payload | Notes |
|---|---|---|
| `SIDE_CHAT_PATCH` (`side-chat:patch`) | `{ sessionId, delta?: string, recordId?: string, record?: SideChatRecord }` | Pushed whenever that Session's OMP process emits a `btw_delta` (`delta` + `recordId` set, `record` omitted -- append to the record `recordId` names) or a `btw_record` (`record` set, `delta`/`recordId` omitted -- replace/settle). Mirrors `SUBAGENT_PATCH`'s own shape exactly (data-model.md, research.md decision 6). A `btw` request OMP itself cancels (Session switch, `new_session`, `fork`, `open_session`, shutdown) arrives as an ordinary `btw_record` with `status: "cancelled"` through this same channel -- no separate event for that case (FR-006). A terminal `btw_record` is always forwarded regardless of which Session is currently visible (gate-fix round 2, Verif2 LOW); only `btw_delta` stays visibility-gated, matching every other live-stream patch. |

## Error codes added

| Code | When |
|---|---|
| `invalid-argument` (existing code, no new one needed) | A blank `question` passed to `sideChat.ask`, or a non-string `sessionId`/`question` -- the same catch-all every other request already uses for a malformed payload. |

No new error code is added for an OMP-side `btw` failure that DOES arrive as a `btw_record` with
`status: "error"` and its own `error` text (data-model.md), rendered in the panel (FR-008), not
surfaced as an IPC-layer error. **Corrected 2026-10-11 (round 3, Code3/Verif3 HIGH, live-tested)**:
an unknown `recordId` and "one already running" are NOT examples of this -- both are confirmed
live to fail at the RPC level instead (`sideChat.ask` resolves `{ ok: false, error: { code:
'prompt-failed', message: '...btw failed: Unknown /btw topic: <id>' } }` / `'...A /btw question is
still running; cancel it first'`), never a `status: "error"` record at all -- `mapChatError`'s own
existing error-mapping path, surfaced by the store's toast, exactly like an `AgentNotRunningError`
would be. Whether "no model" or "history-save failure" produce a `status: "error"` record or
also an RPC-level failure remains `[INFERENCE: not live-tested this round]`.

## Non-IPC: the thread's own state

`side-chat-store.ts` (`SideChatThreadState`, data-model.md) holds only what is currently loaded or
in flight -- it is rebuilt fresh on every launch (no renderer-side persistence) because
`get_btw_history` is the single source of truth for anything older than this app run (FR-004,
same reasoning spec 013's `future/open-questions.md` already used for its own non-persisted
`right-pane-store.ts`).
