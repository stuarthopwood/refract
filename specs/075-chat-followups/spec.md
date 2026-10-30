# spec 075: Chat follow-ups (#1333, #1457, #1459)

Review leftovers from specs 072 and 073 plus one flaky Rust test. No new IPC command; `settings_delete_alarm` gains id validation.

## Clarifications

### Session 2026-10-30 (self-grill, Skippy delegated by Stuart; design points ruled by ui-architect-v3)

- Q: #1333 fix shape? [Decided] Poll every 100 ms for up to 20 s until the fatal callback has fired, then assert exactly one and re-check after a quiet period. No dependency on one liveness tick.
- Q: Undo after deleting an alarm? [Decided, #1457] The store's `deleteAlarm` returns a boolean; a toast offers Undo, which re-upserts the deleted alarm.
- Q: Fired-alarm visibility? [Decided, #1457] While the popover is open, a row that flips from armed to Fired is highlighted (`ListCardButton` `highlighted` prop) and scrolled into view; the highlight clears when the popover closes.
- Q: Form heading and count? [Decided] The section title reads "Add alarm" or "Edit alarm" while the form is open; the header count is the armed count so it matches the bell.
- Q: Shared limits? [Decided] `MAX_ALARMS` and `MAX_ALARM_LABEL_CHARS` live in `src/shared/model.ts`, mirroring `store/alarms.rs`.
- Q: Chain card edge? [Decided, #1459] `ring-1 ring-divider` replaces the 1 px border so padding stays on the 4 px step. Stuart then decided border-only: `bg-card` is dropped from the card (user-directed, 2026-10-30).
- Q: Stage status cue? [Decided] A status glyph precedes each Stage label, so status is not colour-only.
- Q: Skipped? [Decided] The `items().to_vec()` snapshot is a shared pattern at five call sites; out of scope. Header chevron alignment is not changed without a visual ruling; filed as a follow-up.

## Functional requirements

- FR-1 (#1333): The watch fatal test waits boundedly and asserts exactly one fatal callback.
- FR-2 (#1457): Alarm popover: Undo toast, "Add alarm"/"Edit alarm" heading, `aria-describedby` on the Tomorrow hint, no focus loss while saving, inline save error, visible 20-alarm limit note, plain-text bell count, default-size Delete button, `aria-controls`, visible focus parking, Escape closes only the form, fired toasts dismissed on open, one announcement per fire, fired row highlight and scroll.
- FR-3 (#1457): The scheduler emits `SETTINGS_CHANGED` when an alarm list changes, including silent overdue deactivation; `settings_delete_alarm` rejects invalid ids.
- FR-4 (#1459): Status words match whole words by stem; `settle_subagent` scans from the end; `apply_jobs` no longer reports a spurious change; chain stages carry a status glyph and `data-status`; the chain header trigger has no box hover.

## Success criteria

- SC-1: Live check with `verify-tauri-072.mjs` and `verify-tauri-1437.mjs` passes at the committed head.
- SC-2: `pnpm ci:local` passes.
- SC-3: No new tests (rapid-prototyping phase).
