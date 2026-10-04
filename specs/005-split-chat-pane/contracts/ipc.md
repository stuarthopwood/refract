# Contract: renderer to main (typed IPC) — spec 005 delta

This spec does not introduce a second IPC file; `src/shared/ipc.ts` stays the one shared contract
file imported by main, preload, and renderer (constitution V). This document lists only what
changes or is added to `specs/001-core-session-workspace/contracts/ipc.md`, which remains the
baseline for every method not mentioned here. The `Result<T>` envelope and error-code list are
unchanged.

## Changed: `sessions.setVisible`

| Method | Returns | Notes |
|---|---|---|
| `sessions.setVisible(sessionIds: string[])` | `void` | Replaces the single-id/`null` form. `sessionIds` is every session id currently shown in any pane (0, 1, or 2 elements). Selects which sessions' `transcript:patch` events are forwarded (generalises spec 001 FR-026 to "any visible pane"); for each id newly present that was not in the previous call, clears that session's `unread` and flushes a full transcript snapshot (`transcript:patch` `reset`) for it, exactly as the single-id form did. An empty array means no pane is shown (the readiness/empty view). |

Round 3 (code-reviewer, Low): `App.tsx`'s own rendered-panes effect is the SOLE caller of the
array form, derived from what it actually renders (`paneSessionIds`, `isSplit`, `canShowSplit`,
`frontSessionId`) and firing *after* the state change that triggers it (a pane targeting action,
or `sessions.open` resolving), not before. Neither `split-store.ts` nor `init-stores.ts` calls
`sessions.setVisible` itself any more.

## New: `settings.setSplit`

| Method | Returns | Notes |
|---|---|---|
| `settings.setSplit(layout: SplitLayout \| null)` | `Settings` | Persists the Split (data-model.md) to `settings.json` and broadcasts `settings:changed` (same event spec 001's `setApprovalMode` already uses — no new event). `layout: null` means no split is open. Never starts, stops, or touches any `SessionAgent`; this call only ever writes the stored layout. Main performs no validation of `sessionIds` beyond basic shape (`invalid-argument` for a malformed payload) — the renderer only ever calls this with ids it already knows are valid (its own `split-store`'s current pane ids), and restore-time validation against the registry (FR-015) happens separately, once, at app start (data-model.md). |

```ts
interface SplitLayout {
  sessionIds: [string, string];
  dividerPercent: number;   // 0-100
  focusedIndex: 0 | 1;
}
```

## Unchanged, called more often

- `transcript:patch`, `queue:update`, `request:pending`/`request:resolved`, `commands:update`:
  payload shape unchanged; each may now be in flight for up to two session ids at once instead of
  at most one, which every one of these events' payloads already supports (each carries its own
  `sessionId`).
- `session:status`: unchanged; a `SessionAgent`'s own `unread`/status logic is untouched by this
  spec — only `SessionManager`'s notion of "visible" (now a set) feeds it, via the generalised
  `isVisible()` closure each agent already calls (spec 001 `SessionManager.getOrCreateAgent`).

## Not changed

Every other request and event in `specs/001-core-session-workspace/contracts/ipc.md` (readiness,
repositories, the rest of sessions, conversations, chat, `settings.get`/`setApprovalMode`,
Windows notifications) is unchanged by this spec.
