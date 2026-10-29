# Analysis: spec 044 consistency

Cross-check of spec.md, plan.md and tasks.md before implement.

| Check | Result |
|---|---|
| Every FR maps to a task | FR-001 T008; FR-002 T002; FR-003 T003-T006; FR-004 T001, T004; FR-005 T007; FR-006, FR-007 T008; FR-008 T004; FR-009 T006 |
| Thresholds identical across spec, #561 decision comment and `health.rs` | yes: 2.0 s twice or 5.0 s once, clear under 1.0 s or 60 s stale, 10 s minimum, 1.5 GB enter, 1.25 GB clear |
| File-size caps | `process.rs` and `ipc.ts` held at baseline by offsets (plan); `lib.rs`, `readout.rs`, `manager.rs` untouched |
| Reusable components (ADR 0003) | reuses `READOUT_ITEM_*` classes, `Tooltip`, the Long conversation announcement pattern; no new primitive |
| Principle V | no capability, CSP or IPC request change |
| No new tests rule | no tests added; existing 148 vitest pass |
| Gap found | none that blocks implement. Not exercised until the build slot: `cargo` compile and clippy of the new Rust, and the live render |
