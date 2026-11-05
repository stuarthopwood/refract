# Tasks: Notification sounds (#1666)

No test tasks: the prototyping rule forbids new tests; existing tests are only run.

## Phase 1: Discovery
- [x] T001 Confirm the plugin cannot request the alarm scenario or a looping sound, and find the Settings store pattern. (FR-003, FR-004)

## Phase 2: Backend (US1, US2, US3)
- [x] T002 `store/settings.rs` and `store/notification_sounds.rs`: two default-on booleans, `KNOWN_FIELDS`. (FR-001)
- [x] T003 `ipc/settings_notification_sounds.rs`: the two setters, registered in `ipc/mod.rs`. (FR-002)
- [x] T004 `shell/alarm_toast.rs` and `shell/alarms.rs`: alarm scenario toast with a looping sound; `Cargo.toml` dependency. (FR-004)
- [x] T005 `shell/notifications.rs` and `lib.rs`: `Reminder` and `Default` gated on the setting. (FR-003)

## Phase 3: Frontend and contract
- [x] T006 `model.ts`, `ipc.ts`, bridge, `settings-store.ts`, `contracts/ipc.md`. (FR-007)
- [x] T007 `NotificationsSection.tsx`, nav entry, screen route. (FR-005)

## Phase 4: Docs
- [x] T008 CHANGELOG entry and `docs/PLAN.md` entry for #1666 set to in review. (FR-007)

## Phase 5: Live check
- [ ] T009 `scripts/verify-tauri-1666.mjs` in a scratch debug build: read the toast XML back from `ToastNotificationManager.History` for needs-you, finished and alarm, each with the setting on and off. (SC-001)

## Phase 6: Checks
- [ ] T010 `pnpm ci:local`. (SC-002)
