# Plan: spec 072

- Rust: `store/alarms.rs` (model, parse, write, store ops), `ipc/settings_alarms.rs` (`settings.upsertAlarm`, `settings.deleteAlarm`), `shell/alarms.rs` (scheduler task, OS notification, `alarm:fired`), wired in `settings.rs`, `ipc/mod.rs`, `shell/mod.rs`, `events.rs`, `lib.rs`.
- Shared and bridge: `Alarm` in `model.ts`, channels and `onAlarmFired` in `ipc.ts` and `tauri-bridge/index.ts`.
- Renderer: `AlarmClock.tsx` (built from `Popover`, `ScreenSection`, `ListCardButton`, `Button`, `Input`, `CountBadge`, `ReadoutItem`); `CurrentTimeReadout` renders it; `settings-store.ts` actions; `init-stores.ts` toast on `alarm:fired` when focused.
- Small edits: `SourceTag` `text-sm`, `ModelRolesSection` label, `CONTEXT.md`.
- No shared component changes were needed, so `docs/design/components.md` is unchanged.
