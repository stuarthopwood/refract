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
| `SIDE_CHAT_CONVERSATION_CHANGED` (`side-chat:conversation-changed`) | `{ sessionId }` | Gate-fix (round 5, Code5 HIGH; round 6, Code6/Sec6/A11y6/Verif6 HIGH). Pushed from `SessionAgent.notifySideChatConversationChanged()` -- called by `startNewConversation` (after `new_session` succeeds), `openConversation` (after reattach is verified, skipped when the Conversation is unchanged, sends `switch_session`, never `new_session`) and, since round 6, `conversationSwitch.ts`'s `startStoppedSessionOnConversation` (the only Conversation-switch path available while `status === 'stopped'`, which round 5 never wired up -- Stop, then New conversation/Open an earlier Conversation, left the previous Conversation's rows in place). OMP's own `btw` topics are scoped to the OMP session FILE (a Refract Conversation), not a Refract Session, so a side-chat thread the renderer is still showing belongs to the PREVIOUS Conversation once this fires. The store's `clearThread` drops it so the panel's own effect reloads history fresh for the Conversation now current. `notifySideChatConversationChanged()` also bumps a main-process `sideChatConversationEpoch`; `onFrame`'s `btw_delta`/`btw_record` cases drop a frame for a topic stamped with an OLDER epoch instead of forwarding it -- defense in depth alongside OMP's own ordering (the bundled omp 18.8.6 `RpcBtwController.close()` already cancels and settles any running question, synchronously pushing its terminal `btw_record(cancelled)`, strictly before `new_session`/`switch_session`/`branch`/`fork` itself runs; confirmed against its own bundled source). Forwarded unconditionally regardless of visibility. |

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

**Corrected 2026-10-11 (round 6, Code6/Sec6/A11y6/Verif6 HIGH)**: round 5's fix only reached
`startNewConversation`/`openConversation` -- it never fired while the Session was `stopped`, the
only Conversation-switch path left available in that state (`conversationSwitch.ts`'s
`startStoppedSessionOnConversation`), so Stop then New conversation/Open an earlier Conversation
reproduced the exact "Unknown /btw topic" defect through another door. Also added: a per-Session
`epoch` (`side-chat-store.ts`'s own module-level `epochBySession` map, kept outside
`clearThread`'s deleted entry) that `loadHistory`/`ask` capture before their one `await` and skip
their own `set` if it changed underneath them; `applyPatch` ignores an unknown record id while
`!loaded`; and a main-process mirror (`SessionAgent.sideChatConversationEpoch`/
`sideChatTopicEpoch`) that drops a stale `btw_delta`/`btw_record` instead of forwarding it. All
three are defense in depth: the bundled omp 18.8.6 `RpcBtwController.close()` already cancels and
settles any running question, synchronously, strictly before `new_session`/`switch_session`/
`branch`/`fork` itself runs (confirmed against its own bundled source), so a genuinely late frame
for the just-left Conversation should never actually arrive live today -- this guard exists
against a hypothetical future OMP version that settles a cancellation after the switch instead.
**Corrected 2026-10-11 (round 9, Code9/Sec9/A11y9/Verif9 Medium -- round 8's own fix was ALSO
wrong, in the same way round 7's was)**: `sideChatTopicEpoch` is now bounded by SETTLEDNESS, not
by age. Round 7's immediate prune and round 8's "keep one generation" fix both left a fixed-size
window after which a topic silently stopped being protected: `onFrame` found no entry once that
window passed and treated the topic as current, forwarding a late frame OMP emitted for it
instead of dropping it -- the risk is always a late incoming frame, never an outgoing request, so
"no live code path asks about one that old" (round 8's own stated reason) never addressed it.
Fixed: `onFrame`'s own `btw_record` case deletes a topic's entry once its LATEST TURN (never the
root's own possibly-stale status for a follow-up) reaches a terminal status, whether that exact
frame was forwarded or dropped -- a topic with nothing left to hear about needs no entry at ANY
age, and one still awaiting its terminal frame is kept regardless of how many Conversation
switches have happened since. `onExit` clears the whole map unconditionally on every process
exit too. **Corrected 2026-10-11 (round 11, Code11/Sec11/A11y11/Verif11)**: the guard protects
against a late frame from OMP for every stamped topic until it settles (residual gaps (a)-(d):
see `data-model.md`'s own correction, same section) -- not "for as long as that topic remains
unsettled" in the abstract, which omitted that an UNSTAMPED topic (one never asked, or one whose
entry has already been pruned/deleted) is always treated as current regardless of how settled it
actually is. With the
bundled omp 18.8.6 this is a no-op against live frame ordering (`close()` settles a running
question before a switch ever runs) and is not live-verified -- it exists only against a
hypothetical future OMP version that emits a late frame after a switch instead of before it.
