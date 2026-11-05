# Analysis: Notification sounds (#1666)

## Coverage
- FR-001/FR-002: `store/notification_sounds.rs`, `ipc/settings_notification_sounds.rs`, `store/settings.rs` (`KNOWN_FIELDS` now 31 entries).
- FR-003: `shell/notifications.rs` reads the setting through the managed store and sets `Reminder` or `Default`.
- FR-004: `shell/alarm_toast.rs`, called from `shell/alarms.rs`.
- FR-005: `NotificationsSection.tsx`; FR-007: TS parity files and `contracts/ipc.md`.
- SC-001 is asserted by `scripts/verify-tauri-1666.mjs` against a scratch debug build.

## Findings
- The plugin's `Notification::sound(String)` reaches `Sound::from_str`; there is no path to `Sound::Loop` or `Scenario::Alarm` from the plugin's public API, which is why the alarm toast is built directly.
- `create_template` is private, so the builder's XML cannot be inspected; the live check reads the XML of the toast actually shown from the Windows notification history.

## Open
- Audio is not audible from an agent session. The sound itself is a human check on a real desktop.
