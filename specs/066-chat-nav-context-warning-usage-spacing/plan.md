# Plan: spec 066

1. `src/renderer/features/chat/Transcript.tsx` line 416: add `scrollPreviousItemPeek={0}` (same line, no growth to the baselined file).
2. `src-tauri/src/ipc/model_roles.rs`: add `context_window: Option<i64>` (serialised `contextWindow`) to `ModelCatalogEntry`, parsed from the row's `contextWindow`. `src/shared/model.ts`: add `contextWindow?: number | null`.
3. `src/renderer/lib/suspectContextWindow.ts`: `suspectContextWindows(catalog)` and a one-model lookup.
4. `ReadoutItem` gets a `warning` prop; `ContextUsageReadout` loads the chat catalog, looks up `session.lastModel`, shows the icon, tooltip text and accessible name; `ContextShakeMenu` gets an optional link item.
5. `Alert` gets a `warning` variant; new `SuspectWindowsNotice` in `features/settings/` renders above `ProviderSwitch` in `ModelRolesSection`.
6. `UsageView.tsx` lines 66 and 95: `gap-4` to `gap-8`.
7. Update `docs/PLAN.md` rows; run live checks.
