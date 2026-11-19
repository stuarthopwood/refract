# Analysis: Interactive plan data model and per-Session store (#2011)

Cross-artifact consistency pass over spec.md, plan.md and tasks.md, following `.omp/commands/speckit.analyze.md`, against `origin/main` at `f1e2ac62` (design citations as of `dd56b639`). Read-only on code; no cargo run. Every finding below was fixed in the docs before this file was committed unless marked Open.

## Findings

| ID | Category | Severity | Finding | Fix |
|---|---|---|---|---|
| A1 | Inconsistency | High | spec.md pointed the plan-mode live check at `T027` and plan.md pointed the IPC, delete and event work at `T022`, `T024`, which tasks.md numbers T026, T019/T021 and T022. | spec.md and plan.md now cite T026, T019/T021 and T022. |
| A2 | Ungrounded claim | Medium | Decisions for Stuart (6) said the hash crate was "checked in T016" and "the crate used for updater verification". `src-tauri/Cargo.toml:80` has `sha2 = "0.10.8"` (updater `.sha256` check, spec 006), so SHA-256 via `sha2` needs no new dependency. | spec.md Decision 6 and T016 name `sha2`; the "if none fits" branch is removed. |
| A3 | Ungrounded claim | Low | spec.md FR-015 says the tool count goes 17 to 18. `agent_tools/mod.test.rs:38` asserts 17 today, so the claim holds. | None; T020 updates that assertion. |
| A4 | Coverage gap | Medium | The design says a `plan:update` is emitted after write; FR-011 and FR-016 did not own the ordering test. | T018 `plan_update_emitted_after_write_only` owns it; FR-011 coverage lists T018. |
| A5 | Scope boundary | Medium | FR-017 and FR-018 put the send-record, `pendingComplete` and notice work in #2011 while the chat send path is #2013's. Nothing in tasks.md edits `chat.rs` send logic; T023 and T024 edit only the notice slot lines (`chat.rs:140`, `handoff_queue.rs:73,297`). | Boundary stated in spec Clarifications (scope split) and Decisions for Stuart (1). No fix needed. |
| A6 | Ambiguity | Medium | "Archive keeps the plan file" relies on ADR 0009 and the design; `delete_in_flight.rs:158` is cited in the design but a grep of `delete_in_flight.rs` finds `is_deleting` at line 26 only. | T001 re-reads the `remove()` order and the design anchor; the spec labels the line as design-sourced. Open until T001. |
| A7 | Constitution | Low | The 600-line cap is budgeted per file in plan.md; `agent_ops.rs` (330) plus a long property test could pass 600 in its test file. | T006 names the split to `agent_ops_property.test.rs`. |
| A8 | Underspecification | Medium | The `NeedsCard` outcome of `create` (T008) and the card text in the handler (T018) had no named owner of the wording. | T018 raises the card with `approval::session_card` (design "Approval"); wording is the design's: the count of unfinished developer items and their values dropped. |
| A9 | Duplication | Low | Both engines enforce caps. | One validator (`validate.rs`, T004) is used by both; FR-004 says so. |

## Coverage

Every FR-001 to FR-021 and SC-001 to SC-006 maps to at least one task (see the Coverage section of tasks.md). The ADR's guarantees (no session id in the tool, registry-gated paths, detached apply, hash-only send records, no text or values in the hint) each have a named test.

## Constitution check

- AGENTS.md grill first: written grill with Decided (Skippy, delegated by Stuart 2026-11-19) on each question; Decisions for Stuart lists the hard-to-reverse ones.
- Testing V1: every implementation task names its co-located test file and test names, Rust and TS.
- No god files: plan.md budgets each file; none above 330 lines; touched existing files are measured in T001.
- Why-only comments (#1322): stated in tasks.md preamble.
- `todo.ts` untouched: T003 forbids it.
- Safe deletion: one code deletion, the plan file, from a registry id.

## Open questions

- A6: the `delete_in_flight.rs` design line anchor; settled by T001.
- Plan-mode callability of `refract_plan`: settled by live check T026.
