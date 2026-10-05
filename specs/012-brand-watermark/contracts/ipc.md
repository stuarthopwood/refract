# Contract: renderer to main additions for Brand watermark

Extends [spec 001's contracts/ipc.md](../001-core-session-workspace/contracts/ipc.md) and the
`settings.*` additions already made by [spec 004](../004-session-readout/contracts/ipc.md) and
[spec 007](../007-app-themes/contracts/ipc.md): the `Result<T>` envelope, error codes, and the rule
that the renderer never touches processes, files, or git (constitution V) carry over unchanged.
This file lists only what this spec adds.

## Requests

### Settings (FR-015 to FR-020)

| Method | Returns | Notes |
|---|---|---|
| `settings.setWatermarkEnabled(enabled)` | `Settings` | `enabled: boolean`. Persists the whole `Settings` row (data-model.md migration rule) and returns this call's own written value — the same race-safety rule `setApprovalMode`/`setReadoutVisibility`/`setTheme` already document (`src/main/store/settings.ts`). Pushes `settings:changed` exactly like those setters — no new event. A non-boolean argument is the existing `invalid-argument` error code; no new error code is added. |

`settings.get()` (unchanged signature) now also returns `watermarkEnabled: boolean` on the
`Settings` value (default `true`).

## Events (main to renderer)

`settings:changed` (existing event) now also carries the updated `watermarkEnabled` field when
`setWatermarkEnabled` is the cause. This spec adds no other event: the mark's own on-screen
rendering is a pure function of the renderer's own `useSettingsStore` state (data-model.md) — there
is nothing else for main to push.

## Error codes added

None. A non-boolean `enabled` argument is the existing `invalid-argument` code
(`src/shared/ipc.ts`'s `IpcErrorCode`), the same catch-all `settings.setSplit` already uses for a
malformed payload (spec 005).

## Non-IPC: the asset and the opacity/colour constants

`src/renderer/assets/brand/refract-hero.svg` (prerequisite) is referenced only from
`src/renderer/styles/globals.css` via a literal CSS `url()` inside a `mask-image` declaration — it
is never requested over IPC, never read by main for this feature, and crosses no process boundary.
The `--watermark-opacity` custom property and the reused `--muted-foreground` token live in
`globals.css` only (research.md decisions 4, 5); neither is serialised over IPC, the same way
spec 007's `THEMES` table's CSS-side values never were.
