# Contract: renderer to main additions for App themes

Extends [spec 001's contracts/ipc.md](../001-core-session-workspace/contracts/ipc.md): the request/
event shapes (`Result<T>`, typed `window.refract` API) and the rule that the renderer never
touches processes, files, or git (constitution V) carry over unchanged. This file lists only what
this spec adds or changes.

## Bootstrap (synchronous, renderer startup only)

| Channel | Returns | Notes |
|---|---|---|
| `theme:bootstrap` (`ipcRenderer.sendSync`, wrapped as `window.refract.themeBootstrap()`) | `{ settingsTheme: ThemeSetting; osDark: boolean }` | Called once, in the first lines of `main.tsx`, before React mounts and before any class is set on `<html>` — replaces today's hardcoded `document.documentElement.classList.add('dark')`. Blocking by design: nothing paints in the renderer until it returns, which is how FR-015/SC-005 avoid a flash of the wrong theme (research.md decision 4). `settingsTheme` comes straight from the already-loaded `SettingsStore`; `osDark` from `nativeTheme.shouldUseDarkColors`, both synchronous in main. This is the one channel in the app that is not `Result<T>`-shaped: there is nothing to fail, and it must return a plain value with no promise. |

## Theme (FR-001 to FR-022)

| Method | Returns | Errors | Notes |
|---|---|---|---|
| `theme.preview(themeId \| null)` | `void` | | Live-only, not persisted: moves the window's title-bar overlay colour (`BrowserWindow.setTitleBarOverlay`, spec 001 T100) to the previewed built-in theme's `titleBarOverlay`; `null` reverts it to the current saved state (the saved theme, or System's live match). A no-op (logged once) on a build that predates spec 001 T100, since `setTitleBarOverlay` has nothing to attach to without `titleBarStyle: 'hidden'`. Every other surface repaints in the renderer directly from `src/shared/themes.ts` and `theme-store.ts`'s derived class — no round trip for those (FR-005 to FR-007, FR-020, FR-021). |
| `theme.set(themeId)` | `Settings` | `invalid-theme` | `themeId` is `'system'` or a key of `src/shared/themes.ts`'s `THEMES`. Persists `settings.json` via `SettingsStore` (mirroring `setApprovalMode`'s pattern), applies the same title-bar overlay update as `theme.preview` for the new saved state, and broadcasts `settings:changed`. `invalid-theme` covers an id Refract does not recognise, including one a saved file remembers that a later build removed (FR-016 is instead handled by treating an unrecognised *stored* value as `'system'` on read, per data-model.md — `theme.set` itself only rejects a caller trying to *choose* an unknown id) (FR-006, FR-008). |

`settings.get()` (unchanged signature) now also returns `theme: ThemeSetting` on the `Settings`
value (default `'system'`).

## Events (main to renderer)

| Event | Payload | Purpose |
|---|---|---|
| `theme:os-changed` | `{ dark: boolean }` | Pushed from `nativeTheme`'s `'updated'` listener (registered once at app start, research.md decision 5) to every window. The renderer's `theme-store.ts` applies it only while `settingsTheme === 'system'` and no preview is active (FR-002, FR-021); otherwise the new value is still recorded and takes effect the next time System mode is in force with no preview open. |

`settings:changed` (existing event) now also carries the updated `theme` field when `theme.set`
is the cause.

## Error codes added

| Code | Meaning |
|---|---|
| `invalid-theme` | `theme.set` was called with an id that is neither `'system'` nor a key of `THEMES`. |

## Non-IPC: shared theme data

`src/shared/themes.ts`'s `THEMES` table (data-model.md) is imported directly by main, preload, and
renderer — it is not served over IPC. The renderer uses it for the picker's names and swatches,
Shiki theme selection (research.md decision 9), and `next-themes`'s `forcedTheme` (research.md
decision 11); main uses it for `theme.preview`/`theme.set`'s title-bar overlay colours.
