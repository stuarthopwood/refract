# Data Model: Side chat (`/btw`)

## `SideChatRecord` (OMP's own flat per-question shape, mirrored not redefined -- `src/shared/frames.ts`)

**Corrected 2026-10-11 (Slice 1+2 live verification)**: a live `btw` call and a terminal
`btw_record` both confirmed flat (`id`/`status`/`question`/`answer`/`createdAt`/`updatedAt` all
observed); the original `recordId?` field below never existed on the wire and is removed --
continuing a topic is done by passing a PRIOR record's own `id` as the NEXT `btw` call's
`recordId` parameter, not a field carried on the record itself.

**Corrected 2026-10-11 (round 3, Code3/Verif3 HIGH, live-tested against a restarted omp
process)**: a thread's own `leafId` (`BtwHistoryThread.leafId`, below) is NOT a valid `recordId`
-- sending it back is rejected every time with `"Unknown /btw topic"`, including immediately
after a restart. Only a genuine root `id` continues a topic, and it continues correctly across a
restart too (confirmed live: a completed topic's own `id`, sent as `recordId` after killing and
relaunching the agent process, landed as a further follow-up of the same topic). `leafId` itself
denotes the MAIN session's own leaf entry id at the moment the topic was first started (round 4,
Code4/Verif4 LOW) -- unrelated to `btw` continuation, which is why it was always rejected.

**Corrected 2026-10-11 (round 4, Code4/Verif4 CRITICAL)**: OMP's own LIVE `btw`/`btw_record`
response is NOT this flat shape either -- it is the SAME whole-topic tree `get_btw_history`
returns (confirmed live: a follow-up's own response still carries the ROOT's `question`/
`answer`/`status`, with the new turn nested at `followUps[last]`; round 3's own captured
`ask2_followup_response_preRestart` evidence showed exactly this, previously unnoticed). Without
normalising it, a follow-up silently merged into the root row instead of appearing as its own
new one (no "Thinking", single-flight guard off, the terminal answer overwriting the FIRST
question's own text). `SessionAgent.latestTurn` (reusing `flattenBtwHistory`) normalises the raw
tree to the actual latest turn -- with a new `topicId` field (the topic's root id, present on
EVERY flattened record including the root) -- before it ever reaches the renderer. `topicId`,
not a record's own `id`, is the one canonical value to send back as the next `recordId`; a
`btw_delta`'s own `recordId` is ALSO always the topic root (round 4, Code4/Verif4 MEDIUM: its
field is `delta`, not `textDelta` -- renamed below), so `applyPatch`'s delta branch matches by
`topicId` + `status: 'running'`, never a plain id match (which could never find a follow-up's own
row, since its flattened id never equals the root id a delta actually carries).

```ts
export interface SideChatRecord {
  id: string;
  status: 'running' | 'complete' | 'cancelled' | 'error' | 'interrupted';
  question: string;
  answer?: string;
  createdAt?: number;
  updatedAt?: number;
  /** The TOPIC this record belongs to -- always the thread's own root id, present on EVERY
   * flattened record (root included, where it equals this record's own `id`). THE value the
   * next question in this topic must carry as `recordId` (round 4, Code4/Verif4 CRITICAL). */
  topicId?: string;
  /** Present only when this record is a history thread's own root (`BtwHistoryThread.leafId`).
   * NOT a btw continuation value (round 3/4) -- the main session's own leaf entry id at topic
   * creation. Use `topicId` (or this record's own `id` when it IS the root), never this field. */
  leafId?: string;
  /** Confirmed live (round 4, Code4 LOW): a blank question, one already running, an unknown
   * `recordId`, no active model, and a history-save failure all throw inside OMP's own `ask()`
   * -- an RPC-level failure (never a `status: 'error'` record with this field populated). Some
   * OTHER in-flight failure (the model erroring out mid-answer) may still populate it; none has
   * been observed live. */
  error?: string;
}
```

## `BtwHistoryNode` / `BtwHistoryThread` (`get_btw_history`'s real response shape, `src/shared/frames.ts`)

**Corrected 2026-10-11**: `get_btw_history` does NOT return a flat array of independent records.
It returns one entry per independent topic/thread, each a tree: a root node (the only one
carrying `id`/`leafId`) plus a nested `followUps[]` whose entries carry no id of their own.
`SessionAgent.flattenBtwHistory` turns each thread into the flat `SideChatRecord[]` the IPC
contract and renderer actually consume (synthesizing a stable `${root.id}.${index}` key for a
non-root row, and a `topicId` -- the root's own id -- for EVERY row, round 4). The root's own
`id` -- never `leafId` -- is what continues the topic (round 3, live-tested against a restart).

```ts
export interface BtwHistoryNode {
  question: string;
  answer: string;
  status: 'running' | 'complete' | 'cancelled' | 'error' | 'interrupted';
  createdAt: number;
  updatedAt: number;
  error?: string;
  followUps?: BtwHistoryNode[];
}

export interface BtwHistoryThread extends BtwHistoryNode {
  id: string;
  leafId: string;
}
```

## `BtwResponseData` / `BtwDeltaFrame` / `BtwRecordFrame` (`src/shared/frames.ts`)

**Corrected 2026-10-11 (round 4, Code4/Verif4 CRITICAL)**: the `btw` RPC response AND the
`btw_record` push frame both carry a `BtwHistoryThread`, the SAME whole-tree shape as
`get_btw_history` -- NOT a flat `SideChatRecord` as earlier rounds assumed. `SessionAgent`'s
`askSideChat` and its `btw_record` case both normalise it with `latestTurn` (reuses
`flattenBtwHistory`, returns its last entry) before either one ever reaches the renderer.

```ts
export interface BtwResponseData {
  record: BtwHistoryThread;
}

export interface BtwDeltaFrame {
  type: 'btw_delta';
  recordId: string;
  /** Confirmed live (round 4, Code4/Verif4 MEDIUM, against omp 18.8.6's own bundled
   * `rpc-btw.ts`): the wire field is `delta`, never `textDelta` -- the round-3 fix read a field
   * that never existed, so a delta was still silently dropped despite `recordId` being forwarded.
   * `recordId` is always the TOPIC's own root id, never the latest turn's own flattened id. */
  delta: string;
}

export interface BtwRecordFrame {
  type: 'btw_record';
  record: BtwHistoryThread;
}
```

Both join the existing `KnownFrame` union (`frames.ts:384`) alongside `MessageUpdateFrame`,
`ToolExecutionUpdateFrame`, etc.

## `SideChatThreadState` (new renderer store, `side-chat-store.ts`, zustand, in-memory)

Mirrors `subagent-store.ts`'s own per-Session keying (research.md decision 6), not the main
transcript's single-Session-at-a-time model, since a side-chat thread must survive the owning
pane losing focus (Edge Cases: closing the panel never cancels an in-flight question). **Corrected
2026-10-11 (round 5, Code5 HIGH; round 6, Code6/Sec6/A11y6/Verif6 HIGH)**: OMP's own `btw` topics
are scoped to the Conversation (the OMP session file), not the Session as a whole (spec.md item
6) -- the store stays keyed by Session (`bySession`), but `clearThread` now runs whenever
`SIDE_CHAT_CONVERSATION_CHANGED` fires for that Session, so a Conversation switch within the same
Session -- including the stopped-Session path (round 6: round 5 only wired up
`startNewConversation`/`openConversation`, never `conversationSwitch.ts`'s
`startStoppedSessionOnConversation`, the only switch path left while `status === 'stopped'`) --
always reloads a fresh thread instead of continuing to show the PREVIOUS Conversation's rows.

**Corrected 2026-10-11 (gate-fix round 2, Code2/Sec2/Verif2)**: `activeTopicRecordId` only moves
when a record reaches `status: 'complete'` (an error or a cancelled record is never "the prior
answer" FR-003 means to continue from); `running` is always RECOMPUTED from `records`, never set
directly, so a terminal record arriving ahead of an in-flight `ask`'s own reply can never be
clobbered back to `running: true`; `applyPatch`'s delta case now matches by `recordId` (carried
on the patch itself), never "whichever record has status running"; a new `loaded` flag (below)
replaces a per-component ref so FR-004's "once per Session per app run" actually holds across a
remount, and a load that fails because the Session has no live process yet stays `false` so it
retries once the Session starts.

**Corrected 2026-10-11 (round 3, Code3/Verif3 HIGH)**: `loadHistory` seeds `activeTopicRecordId`
from the last topic's root `id`, never its `leafId` (live-tested against a restarted omp
process: `id` continued the topic correctly, `leafId` was rejected every time). A rejected
`recordId` is now also a safety net, narrowed in round 4 to the `"Unknown /btw topic"` case
specifically (round 2's own blanket clear on ANY failure also wiped the topic for a transient
"still running"/`agent-not-running` rejection, unrelated to the wrong-id case it is meant for):
if `ask` fails with that specific rejection and the `recordId` it sent is still the current
`activeTopicRecordId`, it is reset to `undefined` so the NEXT question starts a fresh topic
(FR-003) instead of retrying the same rejected id forever. (Round 5, Verif5 Low: the toast for
this case now reads "Send again to start a new one" -- nothing is auto-sent, only the topic is
cleared, which the round-3/4 wording implied incorrectly.)

**Corrected 2026-10-11 (round 4, Code4/Verif4 CRITICAL)**: `activeTopicRecordId` moves to
`record.topicId ?? record.id` on `complete`, not a record's own `id` alone -- for a follow-up
turn those differ (its own `id` is a flattened `${root.id}.${n}`), and only the topic's root id
is ever a valid `recordId`. Also corrected: `getSideChatHistory` (`SessionAgent.ts`) now sorts
topics ascending by `createdAt` before flattening -- `get_btw_history` itself returns them
NEWEST first, so `loadHistory`'s own `[...fetched].reverse().find(...)` previously picked the
OLDEST topic, not "the most recently started topic" its own comment claimed (round 3's account
was wrong; live-tested, round 4: every round-3 follow-up had in fact landed on the older of two
topics). (Round 5, Code5 Low: found via `id === topicId`, not `leafId !== undefined` -- OMP's own
schema allows `leafId: string | null`, so the old predicate worked only by accident.)

**Corrected 2026-10-11 (round 5, Verif5 Medium)**: `loadHistory`'s merge let a stale fetched copy
of a turn that was `running` when `get_btw_history` was called overwrite a NEWER or already-
terminal store copy -- the likeliest trigger is `/btw` opening the panel for the first time,
which starts `loadHistory` and `ask` together, racing a live `btw_record` that already settled
the SAME turn. For an id present in both, the store's own existing copy now wins whenever it is
newer (`updatedAt`) or already terminal while the fetched copy is still `running`; otherwise the
fetched copy (OMP's own authoritative history) wins, as before.

**Corrected 2026-10-11 (round 6, Code6/Sec6/A11y6/Verif6 HIGH)**: a side question still in
flight, or a `loadHistory` fetch still in flight, when the Conversation changes could resurrect
the just-left Conversation's own state once it resolved (`?? before` fell back to the pre-clear
entry). A module-level `epochBySession` map (outside `clearThread`'s own deleted entry) is bumped
by `clearThread`; `loadHistory`/`ask` capture it before their one `await` and skip their own
`set` entirely if it changed, and both now fall back to `EMPTY_SESSION_STATE`, never `before`.
`applyPatch`'s record case also ignores an id it has never seen while `!loaded` (that record
belongs to the Conversation just left). `SessionAgent` mirrors this with its own
`sideChatConversationEpoch`/`sideChatTopicEpoch`, dropping a stale `btw_delta`/`btw_record`
before it is ever forwarded -- all defense in depth: the bundled omp 18.8.6
`RpcBtwController.close()` already cancels and settles any running question, synchronously,
strictly before `new_session`/`switch_session`/`branch`/`fork` itself runs (confirmed against its
own bundled source), so this guard is a no-op against live frame ordering today; it exists
against a hypothetical future OMP version that settles a cancellation after the switch instead
of before it. **Corrected 2026-10-11 (round 8, Code8/Sec8/Verif8 HIGH/Medium)**: round 7's own
pruning of `sideChatTopicEpoch` (added to bound its size) deleted every entry for the
Conversation just left immediately on the switch, which silently disabled the guard for the
most common case (a topic whose `btw` response had already returned before the switch, with the
real answer still streaming) -- `onFrame` then treated the now-unstamped topic as current and
forwarded its late frame. Fixed to keep one generation back (`stampedEpoch < epoch - 1`, never
`< epoch`): the guard holds for the Conversation just left plus the in-flight-request window a
switch can race; a topic from TWO OR MORE Conversations ago is no longer stamped and is treated
as current, which is acceptable since no live code path ever sends `btw`/`btw_cancel` for one
that old.

```ts
interface SideChatThreadState {
  /** Keyed by Session id. Undefined until `get_btw_history` has been called at least once for
   * that Session this app run (FR-004). */
  bySession: Record<string, {
    records: SideChatRecord[];
    /** The TOPIC id the NEXT question should carry as `recordId`, or undefined for a fresh
     * topic (FR-003). Moves only when a record reaches `status: 'complete'` (its `topicId`, not
     * its own `id` -- round 4); cleared by `clearThread`. */
    activeTopicRecordId: string | undefined;
    /** True while at least one record for this Session has `status: 'running'` (FR-005);
     * recomputed from `records` on every change, never hard-coded. */
    running: boolean;
    /** True once `loadHistory` has succeeded at least once for this Session this app run; a
     * failed load (for example the Session has no live process yet) leaves this `false` so the
     * panel's own effect retries once the Session starts. */
    loaded: boolean;
    /** Round 5, A11y5 Low: `true` when `loadHistory` failed for a reason OTHER than
     * `agent-not-running` -- a genuine failure that will not resolve itself once the Session
     * starts, so the panel's own `!loaded` hint picks different wording than the ordinary
     * "available once running" case. Round 6, A11y6/Sec6 Low: cleared the instant a NEW load
     * attempt starts (not only on that attempt's own success), so a retry after a permanent
     * failure does not keep showing the stale hint for the whole time it is in flight. */
    loadError: boolean;
  }>;
  loadHistory(sessionId: string): Promise<void>;
  ask(sessionId: string, question: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  /** Drops this Session's entry entirely (`loaded`/`loadError` both reset to `false`), so the
   * panel's own effect reloads history fresh. Called on `SIDE_CHAT_CONVERSATION_CHANGED` (round
   * 5, Code5 HIGH; round 6, Code6/Sec6/A11y6/Verif6 HIGH) -- there is no separate "Clear thread"
   * UI action. Also bumps this Session's own epoch in the module-level `epochBySession` map
   * (round 6; see the correction paragraph above `SideChatThreadState`'s own declaration). */
  clearThread(sessionId: string): void;
  /** Applies a BtwDeltaFrame (`delta` + `recordId` set, matched by `topicId` + `status:
   * 'running'`, round 4), a terminal BtwRecordFrame (`record` set), or a btw-history
   * save-failure notice (`notice` set, round 4, Code4 Medium -- routed to a toast, never the
   * main transcript) arriving over SIDE_CHAT_PATCH (main -> renderer). */
  applyPatch(sessionId: string, patch: { delta?: string; recordId?: string; record?: SideChatRecord; notice?: string }): void;
  /** Gate-fix (round 3, Code3/A11y3 Medium; round 4, Sec4 Medium): called when the Session
   * leaves a live state OR its agent process exits via the `sideChatInterrupted` event (round 4
   * -- covers an approval-mode restart, which never reaches `status: 'stopped'` at all) --
   * marks any `running` record `interrupted` instead of leaving it to block Send/Retry/`/btw`
   * forever. A no-op (including `running` itself) when nothing is actually running (round 5,
   * Verif5 Low: the old code forced `running: false` even while an `ask` call still genuinely
   * in flight had set it `true` with no record landed yet). */
  reconcileInterrupted(sessionId: string): void;
}
```

## `PanelId` addition (`panel-registry.ts`, spec 013)

```ts
export type PanelId = 'subagents' | 'fdb-knowledge' | 'agent-builder' | 'side-chat';
```

`HOSTED_PANELS` gains one descriptor: `{ id: 'side-chat', name: 'Side chat', icon: MessageCircleIcon,
hasCount: false }` (research.md decision 5 for the icon choice; `hasCount: false` -- neither issue
asks for a live count on this panel, unlike Subagents' running count).

## `NATIVE_BUILT_COMMANDS` addition (`src/shared/slash-commands.ts`)

```ts
export const NATIVE_BUILT_COMMANDS: readonly SlashCommandDescriptor[] = [
  { name: 'new', description: 'Start a new Conversation in this Session' },
  { name: 'btw', description: 'Ask the agent a side question' },
];
```

`btw` stays in `NATIVE_RESERVED_COMMANDS` unchanged (it is still never forwarded as a prompt;
`chat.ts`'s existing main-process guard already refuses it defensively if ever reached, same as
today -- research.md decision 3, `chat.ts:122-127` unchanged).
