# Contract: renderer to main additions for Right pane shell

Extends spec 001's `contracts/ipc.md` (the `Result<T>` envelope, error codes, and the rule that
the renderer never touches processes, files, or git — constitution V) and spec 012's
`contracts/ipc.md` (the `Settings`-boolean setter pattern). This file lists only what this spec
adds; `right-pane-store.ts`'s own state (`RightPaneState`, `OpenPanelsState`) is pure renderer
state with no IPC surface at all — it is never written to disk (future/open-questions.md), so
there is nothing to add for it here.

## Requests

### Settings (FR-020 to FR-022)

| Method | Returns | Notes |
|---|---|---|
| `settings.setShowSampleData(enabled)` | `Settings` | `enabled: boolean`. Persists the whole `Settings` row and returns this call's own written value — the same race-safety rule `setApprovalMode`/`setReadoutVisibility`/`setWatermarkEnabled` already document (`src/main/store/settings.ts`). Pushes the existing `settings:changed` event, no new event (research.md decision 11). A non-boolean argument is the existing `invalid-argument` error code; no new error code is added. |

`settings.get()` (unchanged signature) now also returns `showSampleData: boolean` on the
`Settings` value (default `false`).

## Events (main to renderer)

`settings:changed` (existing event) now also carries the updated `showSampleData` field when
`setShowSampleData` is the cause. No other event is added: both FDB panels' sample-vs-empty
rendering is a pure function of the renderer's own `useSettingsStore` state (data-model.md) —
there is nothing else for main to push.

## Error codes added

None. A non-boolean `enabled` argument is the existing `invalid-argument` code
(`src/shared/ipc.ts`'s `IpcErrorCode`), the same catch-all every other `settings.*` boolean setter
already uses for a malformed payload.

## Non-IPC: the shell's own state

`right-pane-store.ts` (`RightPaneState`, data-model.md) is ordinary renderer-only zustand state,
exactly like `useSplitStore`/`useSubagentPanelStore` today: it crosses no IPC boundary, is never
read or written by main, and is rebuilt fresh on every launch (FR-003 scopes its restore guarantee
to "within a single session," not across a restart).
