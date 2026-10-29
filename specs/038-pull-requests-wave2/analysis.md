# Analysis: spec 038

Checked spec, plan and tasks against each other and the code on 2026-10-29. No blockers.

- Every FR maps to a task: FR-001..003 T001/T002/T010; FR-004 T006; FR-005..007 T007/T008/T014; FR-008 T009; FR-009 T011; FR-010 T003/T012; FR-011/012 T002/T013; FR-013 T006/T009/T013; FR-014 T010..T012.
- Principle V: the image fetch is backend-only, https-only, host allow-listed, redirects re-validated, no CSP change (ADR 0004). `close` uses the existing signed-in `gh` path; no token handled.
- File ownership is disjoint between WP1 and WP2; WP3 follows both. Composer overlap limited to additive changes in `Markdown.tsx` and tokens.
- Risk: Rust is written before the build slot; the first compile happens in the slot. Mitigation: WP1 is kept small and modelled on `profile.rs` and `gh_mutations.rs` patterns.
- Open follow-ups: #1314 (Settings image hosts). Reactions (#1199) not touched.
