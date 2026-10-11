# Data Model: Side chat (`/btw`)

## `SideChatRecord` (OMP's own shape, mirrored not redefined -- `src/shared/frames.ts`)

Per issue://516's summary of `omp://rpc.md` and FINDINGS item 14's live capture
(`{success:true, data:{record:{status:"running", ...}}}`); fields beyond `id`/`status`/`question`
not directly observed live (the watch window ended before a `complete` record arrived) -- typed
from the issue's own documented shape, flagged `[INFERENCE: from issue, not a raw captured frame]`
where not directly observed.

```ts
export interface SideChatRecord {
  id: string;
  status: 'running' | 'complete' | 'cancelled' | 'error' | 'interrupted';
  question: string;
  /** Present once status is 'complete'. [INFERENCE: not observed live this pass -- FINDINGS item
   * 14's watch window ended while still 'running'.] */
  answer?: string;
  /** Present when this record is a follow-up in an existing topic. */
  recordId?: string;
  /** Present on an 'error' record. [INFERENCE: from issue://516's own failure-case list -- blank
   * question, one already running, unknown recordId, no model, history-save failure.] */
  error?: string;
}
```

## `BtwDeltaFrame` / `BtwRecordFrame` (new `KnownFrame` members, `src/shared/frames.ts`)

```ts
export interface BtwDeltaFrame {
  type: 'btw_delta';
  recordId: string;
  /** [INFERENCE: not observed live -- 0 btw_delta frames across all probe runs, FINDINGS item 14.
   * Shape assumed to mirror MessageUpdateFrame's own delta-text convention until a real capture
   * exists.] */
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

```ts
interface SideChatThreadState {
  /** Keyed by Session id. Undefined until `get_btw_history` has been called at least once for
   * that Session this app run (FR-004). */
  bySession: Record<string, {
    records: SideChatRecord[];
    /** The record id the NEXT question should carry as `recordId`, or undefined for a fresh
     * topic (FR-003). Set to the latest record's own id after every send; cleared by Clear
     * thread. */
    activeTopicRecordId: string | undefined;
    /** True while a `btw` request for this Session has been sent and no terminal btw_record
     * (complete/cancelled/error/interrupted) has arrived yet (FR-005). */
    running: boolean;
  }>;
  loadHistory(sessionId: string): Promise<void>;
  ask(sessionId: string, question: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  clearThread(sessionId: string): void;
  /** Applies a BtwDeltaFrame or BtwRecordFrame arriving over SIDE_CHAT_PATCH (main -> renderer). */
  applyPatch(sessionId: string, patch: { delta?: string; record?: SideChatRecord }): void;
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
