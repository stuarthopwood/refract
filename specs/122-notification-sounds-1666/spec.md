# Feature Specification: Notification sounds

**Feature Branch**: `feat/1666-notification-sounds`
**Created**: 2026-11-05
**Status**: Draft
**Input**: GitHub issue #1666 (grilled with Stuart 2026-11-04, decision restated 2026-11-05). Route: specify.

## Problem
Refract's Windows OS notifications are silent, so a Session that needs your input, or an Alarm that fires, is easy to miss when you are not looking at the screen. Neither notification call site sets a sound: `shell/notifications.rs` builds the Session toast with no `.sound(...)`, and `shell/alarms.rs` shows the alarm through the same plugin. Without a sound, the Windows backend (`tauri-winrt-notification` 0.8.1) writes `<audio silent="true"/>` into the toast XML, so the silence is explicit, not a system default.

## Clarifications

### Session 2026-11-05 (from grill)
Answers come from the issue's "Decisions" block; no questions were put to Stuart.

- Q: Which surfaces? -> A: OS notifications only. In-app toasts (Sonner) stay silent.
- Q: Which sounds for Session notifications? -> A: "needs your input" plays `Reminder`; "finished" plays `Default`. Each plays once, through the plugin's `.sound(...)`.
- Q: How do alarms sound? -> A: The Windows alarm scenario. The toast stays on screen and `Looping.Alarm` loops until the user dismisses it. The plugin's string API cannot request this (`Sound::from_str("Alarm")` yields `Sound::Single`, and `notify-rust` maps only `Urgent` to the alarm scenario), so the alarm toast uses `tauri-winrt-notification` directly.
- Q: Settings? -> A: Two switches under a new Settings > Notifications section: **Session notification sounds** and **Alarm sounds**, both on by default.
- Q: What does "off" mean? -> A: The notification still shows, silently (alarm: still the alarm scenario, no audio).
- Q: Other platforms? -> A: Not changed. The alarm toast module is Windows only; the Session sound string is passed through the plugin, which applies it on Windows.
- Q: Open questions? -> A: None.

## User Scenarios & Testing

### User Story 1 - A Session that needs me makes a sound (Priority: P1)
**Acceptance Scenarios**:
1. **Given** Session notification sounds on and Refract unfocused, **When** a Session needs input, **Then** the OS toast carries the `Reminder` sound, once.
2. **Given** the same, **When** a Session finishes, **Then** the toast carries the `Default` sound, once.
3. **Given** the switch off, **Then** both toasts show with no sound (`<audio silent="true"/>`).

### User Story 2 - An alarm cannot be slept through (Priority: P1)
**Acceptance Scenarios**:
1. **Given** Alarm sounds on, **When** an Alarm fires, **Then** the toast uses the alarm scenario and loops `Looping.Alarm` until dismissed.
2. **Given** Alarm sounds off, **Then** the alarm toast still stays on screen (alarm scenario) but plays no audio.

### User Story 3 - I can turn each off (Priority: P2)
**Acceptance Scenarios**:
1. **Given** Settings > Notifications, **Then** two switches show, labelled "Session notification sounds" and "Alarm sounds", both on on a fresh profile.
2. **Given** a switch toggled, **Then** the value persists across restart and applies to the next notification with no restart.

### Edge Cases
- A settings file without the new keys (older profile): both read as on.
- A non-boolean stored value: reads as on.
- Windows Do Not Disturb / Focus assist and the user's per-app sound setting still mute toasts; the section intro says so.
- The notification path runs before the settings store is managed: treated as on (no Session can have notified that early).

## Requirements

### Functional Requirements
- **FR-001**: `Settings` gains `sessionNotificationSounds` and `alarmSounds`, default `true`, persisted in the settings file and carried on the `settings:changed` wire shape.
- **FR-002**: `settings.setSessionNotificationSounds(enabled)` and `settings.setAlarmSounds(enabled)` persist one boolean each, reply with the whole `Settings`, emit `settings:changed`, and reject a non-boolean with `invalid-argument`.
- **FR-003**: The Session OS notification calls `.sound("Reminder")` when a Session becomes needs-you and `.sound("Default")` when it finishes, only while `sessionNotificationSounds` is on.
- **FR-004**: The alarm OS notification is built with `tauri-winrt-notification`: `Scenario::Alarm`, and `Sound::Loop(LoopableSound::Alarm)` while `alarmSounds` is on, no sound otherwise.
- **FR-005**: Settings > Notifications shows the two switches (shared `SettingSwitchRow`), reading `!== false` so an absent value is on.
- **FR-006**: In-app toasts are unchanged.
- **FR-007**: `contracts/ipc.md`, `src/shared/{model,ipc}.ts`, the bridge and the settings store carry the new fields and methods; CHANGELOG and the `docs/PLAN.md` entry for #1666 are updated.

### Success Criteria
- **SC-001**: Live: the toast XML read back from `ToastNotificationManager.History` shows the audio element for needs-you (`Reminder`), finished (`Default`), alarm (`Looping.Alarm`, alarm scenario) and, with each switch off, `silent="true"`.
- **SC-002**: `pnpm ci:local` passes; no new tests (prototyping rule).
- **Known evidence gaps** (stated in the PR): the plugin's `create_template` is private, so the XML is read back from history rather than from the builder; audio cannot be heard from an agent session.
