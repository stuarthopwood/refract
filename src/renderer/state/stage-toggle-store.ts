import { create } from 'zustand'

// Issue #991 follow-up 2 (Low, deferred from the #941 gate, PR #979): a Stage row's or the
// per-turn Subagent chain row's own MANUAL toggle used to live in a plain `useRef`/`useState`
// pair, forgotten whenever the row's own React key stopped being rendered and later came back --
// a session switch shows a different session's own row set (ordinary keyed-list reconciliation;
// neither `<Transcript>` nor `<ChatPane>` itself carries a `key`), and `Transcript.tsx`'s own
// sr-only-stub/full-row visibility swap (a Stage/tool group can render as a bare announcement
// span instead of its real row) is a second, unrelated path that unmounts and later remounts the
// same row id.
//
// Gate round 1 (ui-architect-v3 + code-reviewer + test-reviewer, unanimous): this store holds
// ONLY the user's own manual choice -- the auto-open latch ("has this row ever been open while
// running/unsettled") stays in `useStickyDisclosure`'s own local component state
// (`useStickyDisclosure.ts`), since recomputing it fresh on every mount is already correct and
// needs no persistence; only a deliberate override needs to survive a remount. Keyed by session
// id, then row id (a Stage's own `group.id`, or `chain:<first stage id>` for the chain row,
// which has no id of its own) -- same `bySession` shape as `draft-store.ts`/`readout-store.ts`.
// Non-persisted, in-memory only (same convention as `alert-dismiss-store.ts`): reset only by a
// full app restart, never written to `settings.json`/disk.
//
// No existing per-session-delete hook prunes this (or any sibling `bySession` store): checked
// `side-chat-store.ts`'s own `clearThread` (wired to `onSideChatConversationChanged`, a
// Conversation change, not a Session delete) and `draft-store.ts`/`readout-store.ts`/
// `queue-store.ts` (none prune on delete either) -- `sessions-store.ts`'s own delete path only
// ever calls `useSplitStore.getState().pruneDeleted(...)`, which is specific to pane-id
// bookkeeping. Adding a new session-delete-prune mechanism just for this store would be a new
// convention, out of scope here; a deleted Session's own dead entries are a handful of booleans,
// the same acceptable non-persisted footprint every sibling `bySession` store already carries.
interface StageToggleState {
  bySession: Record<string, Record<string, boolean>>
  setManualOpen(sessionId: string, rowId: string, open: boolean): void
}

export const useStageToggleStore = create<StageToggleState>((set, get) => ({
  bySession: {},
  setManualOpen: (sessionId, rowId, open) => {
    const current = get().bySession[sessionId] ?? {}
    set({ bySession: { ...get().bySession, [sessionId]: { ...current, [rowId]: open } } })
  }
}))
