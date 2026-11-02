# Spec 111: Composer working-mode menu (#433)

## Summary

A per-Session single-choice working-mode menu beside the Approval mode pill: Interactive, Plan mode, Grill mode, Away mode. Approval mode stays app-wide and unchanged.

## Probe results (OMP 18.14.0, rpc-ui)

- `/plan` is not in `available_commands_update` and, sent as a prompt, reaches the model as plain text. It is not a toggle, so `plan` stays refused in `src/shared/slash-commands.ts`.
- `get_state` has no plan or mode field.
- `--config` with `plan.defaultOnStartup: true` enters plan mode at startup (system prompt grows by about 18k characters). Plan switching is therefore a Session restart at idle with a per-Session overlay.
- Gap: how OMP's plan approval ("Approve and execute", "Approve and compact context", "Refine plan") arrives over RPC was not verified, as it needs a billed model run. It is expected as an `extension_ui_request` `select`, which already renders as a question card. If it does not surface, the user cannot approve in-app; a dedicated review pane is out of scope.

## Requirements

1. Menu: keyboard-operable trigger whose accessible name states the current mode; icon plus text label per mode.
2. Plan: switching restarts the Session at idle with `plan.defaultOnStartup` forced via a variant overlay file. Mid-turn the change is pending and the pill shows "{Mode} after this turn" (same wording as the Approval pill, naming the target). Leaving Plan works the same way.
3. Grill: while on, each prompt gets a hidden instruction (interview one question at a time with a recommended answer, against CONTEXT.md and docs/adr, no code edits until told). No restart. The instruction is not shown in the transcript.
4. Away (policy lives in `session/working_mode/away.rs`, reusable by #479):
   - `ask` requests are answered at once with the recommended option; with none, the reply is "The user is away. Choose the best option yourself, state your choice, and continue."
   - Approvals: Approval mode decides first. Any still pending are denied after 5 minutes with "Not approved: the user is away. Pick a safe alternative or skip this step and continue." Never auto-approved. `REFRACT_AWAY_APPROVAL_TIMEOUT_MS` shortens the timer for live checks only.
   - Every automatic answer or denial is recorded as a transcript notice starting "Automatic (Away mode)" with the original question.
   - Leaving Away posts a "While you were away" summary notice.
   - Away never starts a turn.
5. Defaults: new Session starts Interactive, or Plan when the `plan.defaultOnStartup` setting (`useStartInPlanMode`) is on. The mode persists per Session in `working-modes.json`; Away is never persisted, so it reads back as Interactive after a restart or crash.

## Known gaps

- Plan proposal/approval over RPC is unverified (needs a billed run); no review pane is built.
- The denial reason is sent as a best-effort steer prompt; OMP may ignore it.
- Grill is not applied to queued follow-ups, only prompts sent while idle.
- Question dialogs (non-ask, non-approval) stay pending in Away.
- `REFRACT_AWAY_APPROVAL_TIMEOUT_MS` shortens the 5-minute denial timer in debug builds only (live check).
- The restart for a Plan switch may briefly flash a stopped state.

## Out of scope

Goals (#479), prewalk (#695), Approval mode values, a plan review pane.
