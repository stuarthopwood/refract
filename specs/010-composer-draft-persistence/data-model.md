# Data model: Composer draft persistence

Extends `specs/009-composer-attachments/data-model.md`'s `AttachmentsState`/`PendingImageAttachment`/
`PendingTextChip` (unchanged -- reused as-is). No change to `registry.json`, `settings.json`, or
`processes.json`: the entity below is held only in the renderer's own in-memory store, exactly as
spec 009's attachments already were, just relocated one level up (from a component's `useState` to
a module-level zustand store) so it outlives the component's own mount lifecycle.

## Held in memory (renderer, new: `src/renderer/state/draft-store.ts`)

### `Draft`

```ts
interface Draft {
  text: string
  attachments: AttachmentsState   // spec 009 data-model.md, unchanged
}
```

Rules:

- One `Draft` per open Session, keyed by `sessionId`; a Session with no entry yet reads as the
  stable `EMPTY_DRAFT` constant (`{ text: '', attachments: EMPTY_ATTACHMENTS }`, reusing
  `attachments.ts`'s own `EMPTY_ATTACHMENTS` rather than duplicating the empty shape) -- identical
  to today's first-mount `useState('')`/`useState(EMPTY_ATTACHMENTS)` defaults.
- Updated only by the developer's own typing/pasting in that Session's `MessageInput`, never by any
  IPC event -- unlike every other per-session store in `src/renderer/state/`, `draft-store.ts` has no
  entry in `init-stores.ts`.
- Cleared (`text: ''`, `attachments: EMPTY_ATTACHMENTS`) the instant that Session's message send is
  accepted (spec 009 FR-007, this spec's FR-005) -- never on a timer, never on the agent's turn
  finishing, never on `MessageInput` unmounting (the entire point of this spec).
- Not removed when its Session is archived or deleted: matches every sibling per-session store today
  (`queue-store.ts`'s `bySession`, `commands-store.ts`'s `bySession`, `transcript-store.ts`'s
  per-session map, `pending-requests-store.ts`'s per-session list), none of which prune a vanished
  Session's entry either (spec.md Edge Cases).

### `DraftState` (the store's own shape)

```ts
interface DraftState {
  bySession: Record<string, Draft>
  setText(sessionId: string, text: string): void
  setAttachments(sessionId: string, updater: AttachmentsState | ((prev: AttachmentsState) => AttachmentsState)): void
  clear(sessionId: string): void
}
```

- `setText`/`setAttachments` replace `MessageInput.tsx`'s own former `setText`/`setAttachments`
  `useState` setters one-for-one, now keyed by `sessionId` and reading/writing `bySession` instead
  of component state; `setAttachments` keeps the same "updater function or plain value" shape every
  existing `setAttachments((prev) => …)` call site in `MessageInput.tsx` already uses, so no call
  site needs restructuring beyond adding the `sessionId` argument and reading from the store instead
  of local state.
- `clear` is the one new combined action (today's send-success path called both
  `setText('')` and `setAttachments(EMPTY_ATTACHMENTS)` back to back; `clear(sessionId)` is that
  same pair, atomic, under one name matching FR-005).

## No change to existing entities

- `AttachmentsState`, `PendingImageAttachment`, `PendingTextChip` (spec 009) are unchanged: same
  shape, same validation, same helpers (`attachments.ts`), same presentation
  (`AttachmentStrip.tsx`, `ImagePreviewModal.tsx`, `TextPreviewModal.tsx`).
- `Session`, `Repository`, `Settings`, `SessionRuntime`, `TranscriptItem`, `PendingRequest`,
  `ConversationInfo` (spec 001), `SessionReadout`/`SubagentSummary` (spec 004) are unchanged.
- `registry.json`, `settings.json`, `processes.json` are unchanged: nothing in this spec is
  persisted across a restart (spec.md Clarifications) -- a Draft is simply gone if Refract restarts,
  the same as before this spec.
