# Data model: Split chat pane

Builds on `specs/001-core-session-workspace/data-model.md`, which this file does not repeat.
Only what spec 005 adds or changes is below.

## Stored by Refract

### `settings.json` — new field

```ts
interface Settings {
  version: 1;
  approvalMode: 'ask' | 'edit-freely' | 'auto';   // unchanged
  split: SplitLayout | null;                       // new; null = no split, single pane
}

interface SplitLayout {
  sessionIds: [string, string];   // the two Session ids shown, left pane first
  dividerPercent: number;         // 0-100, percentage of the chat area width the left pane takes
  focusedIndex: 0 | 1;            // which of sessionIds[0]/sessionIds[1] was focused
}
```

Rules:

- `split` is written whenever the developer's pane arrangement changes for a reason that should
  survive a restart: opening/replacing/closing a pane, moving focus, or a user-driven divider
  resize (`isUserInteraction: true` from `react-resizable-panels`' `onLayoutChanged`, research.md
  Decision 5). A single-pane layout (no split open) is `split: null`; there is no one-element
  form of `SplitLayout` — closing a pane simply sets `split` back to `null`.
- `sessionIds[0] === sessionIds[1]` never happens (spec FR-009/SC-004: the same session is never
  shown in both panes); nothing in this feature constructs that value.
- At app start, `src/main/index.ts` validates `split` against the already-loaded registry
  (`RegistryStore`) before handing `settings.get()`'s result to the renderer: any id no longer
  present, or now archived, is dropped (FR-015). If that leaves one id, the stored value is
  rewritten to `null` (a dropped-to-one-session split is just a single pane, not a
  `SplitLayout` of length one) and the surviving session becomes the one shown, focused, full
  width. If it leaves zero ids, `split` is rewritten to `null`. This validation never starts an
  agent (FR-014) — it only reads `RegistryStore`'s in-memory `Session[]`.

## Held in memory (renderer only; not written to disk directly — mirrors into `settings.json` via `settings.setSplit`)

### Split (zustand `split-store.ts`)

```ts
interface SplitState {
  /** 1 element = single pane (today's behaviour); 2 = split. Index 0 is the left/first pane. */
  paneSessionIds: string[];
  /** Index into paneSessionIds. Meaningless (ignored) when paneSessionIds.length === 1 — a
   * single pane is always "focused" by definition (every row click/keyboard command targets it). */
  focusedIndex: number;
  /** 0-100; meaningless when paneSessionIds.length === 1. */
  dividerPercent: number;
  /** Session ids whose pane was populated by restoring a persisted split and has not yet been
   * opened by a real user action (research.md Decision 4). A pane renders cold (SessionSummary's
   * own stopped/not-started look, empty transcript, no banner) while its session id is in this
   * set; any action that calls sessions.open for that id removes it. */
  pristineIds: Set<string>;
}
```

State transitions (`paneSessionIds`/`focusedIndex`/`pristineIds`), per functional requirement:

| From | Action | To |
|---|---|---|
| `[A]` (single pane, A focused) | "Open in split"/Ctrl+click on B (FR-001) | `[A, B]`, focusedIndex unchanged (A stays focused), B not pristine |
| `[A]` | row click on B (not A) | `[B]` (ordinary single-pane replace, unchanged from spec 001) |
| `[A, B]`, focused A | row click on C (FR-008) | `[C, B]`, focused stays index 0 (the pane that was focused), C not pristine |
| `[A, B]`, focused A | row click on B (already the other pane, FR-009) | `[A, B]`, focusedIndex -> 1 (focuses B instead of duplicating) |
| `[A, B]`, focused A | "Open in split"/Ctrl+click on C (FR-012) | `[A, C]` (replaces the **unfocused** pane), focusedIndex unchanged |
| `[A, B]`, focused A | "Open in split"/Ctrl+click on A (already the focused pane, research.md Decision 7) | `[A, B]` unchanged (no-op) |
| `[A, B]`, focused A | "Open in split"/Ctrl+click on B (already the unfocused pane) | `[A, B]`, focusedIndex -> 1 (same rule as a row click, FR-009) |
| `[A, B]` | close pane 0 (FR-011/013) | `[B]`, focusedIndex 0 |
| `[A, B]` | close pane 1 (FR-011/013) | `[A]`, focusedIndex 0 |
| `[A, B]` | focus-move keyboard command or divider-area button (FR-007) | `[A, B]` unchanged, focusedIndex flips 0<->1 |
| restart, persisted `split: { sessionIds: [A, B], ... }`, both exist and not archived (FR-014) | app start | `[A, B]`, both ids added to `pristineIds`, no `sessions.open` call |
| restart, persisted `split` had one id dropped (FR-015) | app start | `[survivor]`, not pristine (a single pane was never "restored cold" before this feature; it keeps today's single-pane behaviour, which does open it) |
| any pane, id in `pristineIds` | that session's agent is opened for real (first message sent, or any action above that targets it) | same `paneSessionIds`, id removed from `pristineIds` |

### TranscriptItem store — generalised, not new

`src/renderer/state/transcript-store.ts` changes from one `{ sessionId, items }` pair to
`Record<sessionId, TranscriptItem[]>`, the same shape `queue-store.ts` already uses. `TranscriptItem`
itself (spec 001 data-model.md) is unchanged.

## Derived (not stored)

- **Which pane shows "focused"**: `focusedIndex` compared against a pane's own position; no new
  stored field.
- **The narrow-window collapse (FR-017, research.md Decision 6)**: derived purely from the chat
  region's measured width versus `2 × 360px`; nothing about it is persisted, since it is a
  property of the current window size, not a developer choice. The persisted `SplitLayout` is
  unaffected by a temporary narrow-window collapse — widening the window restores both panes at
  the stored `dividerPercent` without needing to re-read `settings.json`.

## Contract surface touched

See [contracts/ipc.md](contracts/ipc.md) for the exact changed/added `window.refract` methods
(`sessions.setVisible`, new `settings.setSplit`).
