# Implementation Plan: Notification sounds

**Spec**: [spec.md](spec.md) | **Issue**: #1666 | **Route**: specify (spec 122; 121 is on origin/main)

## Summary
Two persisted booleans, two IPC setters, a sound on the Session OS toast, a directly built alarm toast on Windows, and a Settings > Notifications section. No new tests (prototyping rule). A live check reads the shown toast XML back from the Windows notification history.

## Grounding (read from origin/main 6c313ee3)
- `shell/notifications.rs::on_session_status` builds the Session toast with the plugin builder and no `.sound`; the plugin's Windows backend then writes `<audio silent="true"/>`.
- The plugin (`tauri-plugin-notification` 2.6.0) builds `tauri_winrt_notification::Toast` in a private `create_template`; its `sound` is a string parsed by `Sound::from_str`, which yields `Sound::Single` for `"Alarm"`, and its scenario comes from `Urgent` only. A looping alarm therefore needs `tauri-winrt-notification` 0.8.1 (already in the lock via the plugin) called directly.
- `shell/alarms.rs` is the alarm scheduler; it already receives the `Arc<AsyncMutex<SettingsStore>>`.
- Settings follow the `store/<topic>.rs` plus `ipc/settings_<topic>.rs` pattern (`code_ligatures`, `finished_turn_times`); `KNOWN_FIELDS` lists every key so unported keys survive saves.
- Settings sections: `SETTINGS_SECTION_IDS` in `view-store.ts`, `SettingsNav.tsx`, `SettingsScreen.tsx`.

## Design decisions
1. **Store**: `store/notification_sounds.rs` holds the keys, default-on parsing, the writer and the two setters; `settings.rs` carries the two fields and `KNOWN_FIELDS` (31 entries).
2. **IPC**: `ipc/settings_notification_sounds.rs` registers `settings.setSessionNotificationSounds` and `settings.setAlarmSounds` (`require_bool`, whole-row `persist_whole`, `emit_settings_changed`).
3. **Session sound**: `lib.rs` setup does `app.manage(settings.clone())`; the notification path reads it with `try_state::<Arc<AsyncMutex<SettingsStore>>>()` (absent means on) and adds `.sound("Reminder")` or `.sound("Default")`.
4. **Alarm toast**: `shell/alarm_toast.rs` (Windows only) builds `Toast` with `Scenario::Alarm` and `Sound::Loop(LoopableSound::Alarm)` or `None`; `app_id` mirrors the plugin's choice so the toast attributes to the same app.
5. **UI**: new `NotificationsSection.tsx` with two `SettingSwitchRow`s; the section id `notifications` goes after `sessions`.
6. **TS parity**: `model.ts`, `ipc.ts`, `tauri-bridge/index.ts`, `settings-store.ts`, `contracts/ipc.md`.

## Files to touch
- `src-tauri/Cargo.toml`, `Cargo.lock`, `src-tauri/src/{lib.rs,store/{mod,settings,notification_sounds}.rs,ipc/{mod,settings_notification_sounds}.rs,shell/{mod,alarms,alarm_toast,notifications}.rs}`
- `src/shared/{model,ipc}.ts`, `src/tauri-bridge/index.ts`, `src/renderer/state/{settings-store,view-store}.ts`, `src/renderer/features/settings/{NotificationsSection,SettingsNav,SettingsScreen}.tsx`
- `specs/001-core-session-workspace/contracts/ipc.md`, `docs/PLAN.md`, `CHANGELOG.md`
- `scripts/verify-tauri-1666.mjs` (live toast XML read-back)

## Risks
- The alarm toast bypasses the plugin, so its click/activation handling is not the plugin's; the alarm toast has no action handler today, so nothing is lost.
- Windows may still mute toasts (Do Not Disturb, per-app sound off); documented in the section intro.
- Audio is not audible from an agent session; the live check proves the toast XML, not the sound.
