# Data Model: Side chat (`/btw`)

## `SideChatRecord` (OMP's own flat per-question shape, mirrored not redefined -- `src/shared/frames.ts`)

**Corrected 2026-10-11 (Slice 1+2 live verification)**: a live `btw` call and a terminal
`btw_record` both confirmed flat (`id`/`status`/`question`/`answer`/`createdAt`/`updatedAt` all
observed); the original `recordId?` field below never existed on the wire and is removed --
continuing a topic is done by passing a PRIOR record's own `id` (or a thread's own `leafId`, see
`BtwHistoryThread` below) as the NEXT `btw` call's `recordId` parameter, not a field carried on
the record itself.

```ts
export interface SideChatRecord {
  id: string;
  status: 'running' | 'complete' | 'cancelled' | 'error' | 'interrupted';
  question: string;
  answer?: string;
  createdAt?: number;
  updatedAt?: number;
  /** Present only when this record is a history thread's own root (`BtwHistoryThread.leafId`). */
  leafId?: string;
  /** [INFERENCE: from issue://516's own failure-case list -- blank question, one already
   * running, unknown recordId, no model, history-save failure.] */
  error?: string;
}
```

## `BtwHistoryNode` / `BtwHistoryThread` (`get_btw_history`'s real response shape, `src/shared/frames.ts`)

**Corrected 2026-10-11**: `get_btw_history` does NOT return a flat array of independent records.
It returns one entry per independent topic/thread, each a tree: a root node (the only one
carrying `id`/`leafId`) plus a nested `followUps[]` whose entries carry no id of their own.
`SessionAgent.flattenBtwHistory` turns each thread into the flat `SideChatRecord[]` the IPC
contract and renderer actually consume (synthesizing a stable `${root.id}.${index}` key for a
non-root row, never sent back to OMP as a `recordId`).

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

## `BtwDeltaFrame` / `BtwRecordFrame` (new `KnownFrame` members, `src/shared/frames.ts`)

```ts
export interface BtwDeltaFrame {
  type: 'btw_delta';
  recordId: string;
  /** [INFERENCE: not observed live -- 0 btw_delta frames across all probe runs, FINDINGS item 14,
   * including this spec's own Slice 1+2 live round. Shape assumed to mirror MessageUpdateFrame's
   * own delta-text convention until a real capture exists.] */
  textDelta: string;
}

export interface BtwRecordFrame {
  type: 'btw_record';
  record: SideChatRecord;
}
```

Both join the existing `KnownFrame` union (`frames.ts:384`) alongside `MessageUpdateFrame`,
`ToolExecutionUpdateFrame`, etc.

## `SideChatThreadState` (new renderer store, `side-chat-store.ts`, zustand, in-memory)

Mirrors `subagent-store.ts`'s own per-Session keying (research.md decision 6), not the main
transcript's single-Session-at-a-time model, since a side-chat thread must survive the owning
pane losing focus (Edge Cases: closing the panel never cancels an in-flight question).

**Corrected 2026-10-11 (gate-fix round 2, Code2/Sec2/Verif2)**: `activeTopicRecordId` only moves
when a record reaches `status: 'complete'` (an error or a cancelled record is never "the prior
answer" FR-003 means to continue from); `running` is always RECOMPUTED from `records`, never set
directly, so a terminal record arriving ahead of an in-flight `ask`'s own reply can never be
clobbered back to `running: true`; `applyPatch`'s delta case now matches by `recordId` (carried
on the patch itself), never "whichever record has status running"; a new `loaded` flag (below)
replaces a per-component ref so FR-004's "once per Session per app run" actually holds across a
remount, and a load that fails because the Session has no live process yet stays `false` so it
retries once the Session starts.

```ts
interface SideChatThreadState {
  /** Keyed by Session id. Undefined until `get_btw_history` has been called at least once for
   * that Session this app run (FR-004). */
  bySession: Record<string, {
    records: SideChatRecord[];
    /** The record id the NEXT question should carry as `recordId`, or undefined for a fresh
     * topic (FR-003). Moves only when a record reaches `status: 'complete'`; cleared by Clear
     * thread. */
    activeTopicRecordId: string | undefined;
    /** True while at least one record for this Session has `status: 'running'` (FR-005);
     * recomputed from `records` on every change, never hard-coded. */
    running: boolean;
    /** True once `loadHistory` has succeeded at least once for this Session this app run; a
     * failed load (for example the Session has no live process yet) leaves this `false` so the
     * panel's own effect retries once the Session starts. */
    loaded: boolean;
  }>;
  loadHistory(sessionId: string): Promise<void>;
  ask(sessionId: string, question: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  clearThread(sessionId: string): void;
  /** Applies a BtwDeltaFrame (`delta` + `recordId` set) or BtwRecordFrame (`record` set)
   * arriving over SIDE_CHAT_PATCH (main -> renderer). */
  applyPatch(sessionId: string, patch: { delta?: string; recordId?: string; record?: SideChatRecord }): void;
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
