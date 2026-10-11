# Contract: renderer to main additions for Side chat

Extends spec 001's `contracts/ipc.md` (the `Result<T>` envelope, error codes, constitution V) and
spec 004's `subagents.*` request/event trio (the closest existing precedent for a per-Session,
streamed, cancellable sub-conversation).

## Requests

### Side chat (FR-002 to FR-007)

| Method | Returns | Notes |
|---|---|---|
| `sideChat.ask(sessionId, question, recordId?)` | `{ record: SideChatRecord }` | Issues `{type:"btw", question, recordId?}` to that Session's OMP process. Gate-fix (round 4, Code4/Verif4 CRITICAL): OMP's own raw response is a `BtwHistoryThread` (the whole topic tree, data-model.md), NOT a flat record -- `SessionAgent.askSideChat` normalises it to the LATEST turn (`SessionAgent.latestTurn`, reusing `flattenBtwHistory`) before returning, with a `topicId` field (the topic's root id) added. The answer itself also arrives over `SIDE_CHAT_PATCH`. `recordId` here MUST be a topic's own root id (= a record's own `topicId`, or its `id` when it IS the root) -- omitted starts a fresh topic (FR-003). A blank `question` is rejected locally with `invalid-argument` before ever reaching OMP (one of `btw`'s own documented failure cases, issue://516); so is a non-empty `recordId` longer than 200 characters. |
| `sideChat.cancel(sessionId)` | `void` | Issues `btw_cancel` for that Session's currently-running record, if any. A no-op (not an error) if nothing is running -- mirrors `subagents.cancel`'s own idempotent shape. |
| `sideChat.getHistory(sessionId)` | `SideChatRecord[]` | Issues `get_btw_history`; `get_btw_history` itself returns a nested per-topic tree (`BtwHistoryThread`/`BtwHistoryNode`, data-model.md), flattened to this flat, ordered `SideChatRecord[]` by `SessionAgent.flattenBtwHistory` (every row now also carries `topicId`, round 4) before crossing the IPC boundary. Gate-fix (round 4, Code4/Verif4 HIGH): `get_btw_history` itself returns topics NEWEST first -- sorted ascending by `createdAt` here so the result reads oldest-to-newest (confirmed live: an un-sorted result made `loadHistory`'s own "last root = newest topic" picking wrong). Called once per Session per app run (FR-004), not polled. |

## Events (main to renderer)

| Event | Payload | Notes |
|---|---|---|
| `SIDE_CHAT_PATCH` (`side-chat:patch`) | `{ sessionId, delta?: string, recordId?: string, record?: SideChatRecord, notice?: string }` | Pushed whenever that Session's OMP process emits a `btw_delta` (`delta` + `recordId` set, `record` omitted -- `recordId` is the TOPIC's own root id, round 4, never the latest turn's own flattened id; matched against whichever record has that `topicId` AND `status: 'running'`) or a `btw_record` (`record` set, `delta`/`recordId` omitted -- normalised to the latest turn before this fires, round 4, Code4/Verif4 CRITICAL). Mirrors `SUBAGENT_PATCH`'s own shape exactly (data-model.md, research.md decision 6). A `btw` request OMP itself cancels (Session switch, `new_session`, `fork`, `open_session`, shutdown) arrives as an ordinary `btw_record` with `status: "cancelled"` through this same channel -- no separate event for that case (FR-006). A terminal `btw_record` is always forwarded regardless of which Session is currently visible (gate-fix round 2, Verif2 LOW); only `btw_delta` stays visibility-gated, matching every other live-stream patch. Gate-fix (round 4, Code4 Medium): `notice` carries a btw-history save-failure's own message (OMP's `{type:'notice', source:'btw-history'}`) -- routed here instead of the main transcript (constitution II), forwarded unconditionally regardless of visibility like `record`. |
| `SIDE_CHAT_INTERRUPTED` (`side-chat:interrupted`) | `{ sessionId }` | Gate-fix (round 4, Sec4 Medium; row added round 5, Code5 Medium -- this row was missing). Pushed from the very top of `SessionAgent.onExit`, before any early return, for EVERY agent-process exit (an approval-mode restart included -- the one exit path that never reaches `status: 'stopped'` at all). The store's `reconcileInterrupted` marks any `running` record `interrupted` so it never blocks Send/Retry/`/btw` forever; a no-op when nothing is running. Forwarded unconditionally regardless of visibility. |
| `SIDE_CHAT_CONVERSATION_CHANGED` (`side-chat:conversation-changed`) | `{ sessionId }` | Gate-fix (round 5, Code5 HIGH). Pushed from `SessionAgent.startNewConversation` (after `new_session` succeeds) and `openConversation` (after reattach is verified, skipped when the Conversation is unchanged) -- OMP's own `btw` topics are scoped to the OMP session FILE (a Refract Conversation), not a Refract Session, so a side-chat thread the renderer is still showing belongs to the PREVIOUS Conversation once this fires. The store's `clearThread` drops it so the panel's own effect reloads history fresh for the Conversation now current. Forwarded unconditionally regardless of visibility. |

## Error codes added

| Code | When |
|---|---|
| `invalid-argument` (existing code, no new one needed) | A blank `question` passed to `sideChat.ask`, or a non-string `sessionId`/`question` -- the same catch-all every other request already uses for a malformed payload. |

No new error code is added for an OMP-side `btw` failure that DOES arrive as a `btw_record` with
`status: "error"` and its own `error` text (data-model.md), rendered in the panel (FR-008), not
surfaced as an IPC-layer error. **Corrected 2026-10-11 (round 3, Code3/Verif3 HIGH, live-tested;
round 4, Code4 LOW, confirmed against omp 18.8.6's own bundled `rpc-btw.ts`)**: a blank question,
one already running, an unknown `recordId`, no active model, and a history-save failure are NOT
examples of this -- all five are confirmed to throw inside OMP's own `ask()`, an RPC-level
failure every time (`sideChat.ask` resolves `{ ok: false, error: { code: 'prompt-failed', message:
'...btw failed: Unknown /btw topic: <id>' } }` / `'...A /btw question is still running; cancel it
first'` / etc.), never a `status: "error"` record at all -- `mapChatError`'s own existing
error-mapping path, surfaced by the store's toast, exactly like an `AgentNotRunningError` would
be. A genuinely different in-flight failure (the model erroring out mid-answer) may still produce
a `status: "error"` record with `error` populated; none has been observed live across any round.

## Non-IPC: the thread's own state

`side-chat-store.ts` (`SideChatThreadState`, data-model.md) holds only what is currently loaded or
in flight -- it is rebuilt fresh on every launch (no renderer-side persistence) because
`get_btw_history` is the single source of truth for anything older than this app run (FR-004,
same reasoning spec 013's `future/open-questions.md` already used for its own non-persisted
`right-pane-store.ts`). **Corrected 2026-10-11 (round 5, Code5 HIGH)**: scoped PER CONVERSATION,
not per Refract Session as originally assumed -- OMP's own `btw` topics live in
`btw-history/sessions/<the OMP session file's own id>`, which is a Refract Conversation, never
the Refract Session as a whole; `RpcBtwController` reopens that store whenever the OMP session
file changes. The store is still KEYED by Refract Session (`bySession`), but `clearThread` now
runs whenever `SIDE_CHAT_CONVERSATION_CHANGED` fires for that Session (above), so a Conversation
switch within the same Session (`/new`, or opening an earlier Conversation) always reloads a
fresh thread for the Conversation now current, instead of continuing to show the PREVIOUS
Conversation's rows and sending its own topic id, which the new Conversation's side-chat store
rejects with "Unknown /btw topic".
