# Analysis: Session row agents button

Spec, plan and tasks agree: every FR maps to T1 and T2; no IPC work (one small Rust change to `activity_value`, see spec.md); no constitution or ADR conflict; no file is near the 600-line cap (`SessionRow.tsx` 453). Risk: `SessionList.tsx` has other open changes, but this plan does not touch it. No remaining ambiguity.
