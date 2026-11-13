# spec 072: Advisor tag, Parked agents, Todo task wording, composer Alarms (#1430, #1098, #1432, #1426)

One renderer-heavy batch, plus one Rust feature (Alarms). #1098 is skipped: OMP still has no parked signal.

## Clarifications

### Session 2026-10-30 (self-grill, Skippy delegated by Stuart; ui-architect-v3 ruled on every design question)

- Q: #1430 size? [Decided in the issue] `SourceTag` is `text-sm`; the meta stays `text-xs`.
- Q: #1098 Parked? [Decided: skip] The Parked vocabulary shipped in #1321. OMP 18.13.3 (still the installed version) reports only started, completed, failed, aborted, so Refract cannot tell parked from completed. The issue stays open until OMP adds a signal.
- Q: #1432 fold Tasks into Todo? [Decided in the issue] No structural change. CONTEXT.md gains **Todo task** (avoid "Task" for a subagent). The Settings model-role label "Task" becomes "Subagent" (role id stays `task`).
- Q: Alarm surface? [Decided, ui-architect-v3] One Popover from the clock; no dialog. `ScreenSection` lists Alarms; an inline form (Time, Label, Cancel outline, Save filled) adds and edits.
- Q: Row actions? [Decided, ui-architect-v3] Each row is a `ListCardButton` (click edits); Delete is a text `ghost-destructive` button in `actions`, named "Delete alarm 07:30 Standup", with no confirm.
- Q: Time entry? [Decided] Native `Input type="time"`. A time already passed today means tomorrow, shown as a muted "Tomorrow" hint.
- Q: Clock presentation? [Decided, ui-architect-v3] The clock text is unchanged; with armed Alarms a neutral bell and `CountBadge` appear, and the accessible name reads "Current time 7:02 PM, 2 alarms set. Open alarms".
- Q: Fired Alarms? [Decided, ui-architect-v3] They stay listed, dimmed, with a "Fired" label and Delete; saving an edit re-arms. "Clear fired" is deferred.
- Q: Storage? [Decided] `settings.json` `alarms`: `{id, label, fireAtMs, active}` (absolute UTC ms), with granular upsert and delete IPC so a write cannot race the scheduler. Cap 20 Alarms, 80-character labels.
- Q: Delivery? [Decided] A Rust scheduler sleeps until the soonest active Alarm (at most 60 s per sleep, woken on writes). It always shows an OS notification and emits `alarm:fired`; the renderer toasts only while the window is focused.
- Q: Overdue after sleep or restart? [Decided] An Alarm more than 5 minutes overdue goes inactive without notifying.

## Functional requirements

- FR-1 (#1430): The Advisor row tag uses the same font size as its severity and message.
- FR-2 (#1432): CONTEXT.md defines **Todo task** and **Alarm**; Settings shows "Subagent" for the `task` model role.
- FR-3 (#1426): The clock opens an Alarms popover with create, edit and delete, persisted across restarts.
- FR-4 (#1426): A due Alarm raises an OS notification (always) and an in-app toast (window focused), then becomes inactive.
- FR-5 (#1426): Alarms are one-shot, capped at 20, labels at most 80 characters; the popover is keyboard operable and named for screen readers.

## Success criteria

- SC-1: Each change is visible in the built app (screenshots in the session files folder).
- SC-2: `pnpm ci:local` and `pnpm check:ui-text` pass.
- SC-3: No new tests (rapid-prototyping phase).

## Convergence (#1879, 2026-11-13, Decided (Skippy, delegated))

The #1432 decision to label the `task` model role "Subagent" is reversed: the role label reads "Task" again (Settings Models, model picker, composer chip, all derived from `CHAT_ROLE_DESCRIPTORS`). FR-2's "Subagent" wording is superseded; the role id `task`, the role description ("Subagents started by the task tool.") and every other Subagent label (usage filter, panels, tokenGuard group) are unchanged.
