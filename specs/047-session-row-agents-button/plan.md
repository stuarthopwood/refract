# Plan: Session row agents button

Spec: `spec.md`. Constitution: Principle V unaffected (no capability, CSP or IPC change). ADR 0003: built from `Button` and `Tooltip`; the one new control stays beside its only consumer until a second caller appears (ui-architect-v3 ruling).

## Renderer, plus one small Rust change (see spec.md origin/main check)
- `src/renderer/features/sessions/SessionAgentsButton.tsx` (new): icon, count text, Tooltip, name, click handler.
- `SessionRow.tsx` (453 lines, under cap): mount the button in the trailing group; padding table for line 1; hide the time cell on touch while it shows; select-then-open handler.
- `docs/PLAN.md` row C2d status.

## Verification
Typecheck, vitest, lint, `check:file-size` without the slot; `ci:local` and the live check with it.
