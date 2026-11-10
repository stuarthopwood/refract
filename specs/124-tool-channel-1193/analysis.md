# Analysis: Agent tool channel and panel tools (#1193)

Read-only cross-check of spec.md, plan.md and tasks.md against origin/main 4a2ac76. No unresolved CRITICAL findings.

## Coverage

| Requirement | Plan section | Task |
| --- | --- | --- |
| FR-001 register per launch, `essential` | `agent_tools/mod.rs`, `launch.rs` one-liner | T002, T006 |
| FR-002 approval overlay | `overlay.rs`, `process_args.rs` | T005 |
| FR-003, FR-004 stream-owner id, unknown tool | `router.rs` | T003, T006 |
| FR-005 to FR-008 event, timeout, errors, cancel, exit | `router.rs`, `events.rs`, `ipc/agent_tools.rs` | T003, T007, T013 |
| FR-009 to FR-012 registry, list, open, invoke | contract JSON, `panel-registry.ts`, `agent-tool-dispatch.ts` | T001, T008, T010 |
| FR-013 mutating approval | `approval.rs`, `requests.rs` | T004 |
| FR-014 to FR-016 closed stays closed, announce, front Session | dispatcher, announcer | T010, T011 |
| FR-017 v1 actions | `agent-panel-actions.ts` | T009 |
| FR-018 docs | ADR 0007, CONTEXT.md, PLAN.md | done in this PR, T016 |
| SC-001 to SC-004 | live scripts | T014, T015, T016 |

Every FR maps to a task; no task lacks a requirement.

## Findings

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | MEDIUM | The `pull-request` panel is a pinned panel (`PinnedPanelId`); `open_pull_request` needs #1155's open path, which was not located in this pass. | T009 locates it first and reuses it; if the path needs a store entry point, it is added in that store only. No new open path. |
| 2 | MEDIUM | `tools.approval` overlay merge with the user's global config is documented as an object deep-merge but unproven for host tool names on omp 18.17.0. | SC-003 (T015) proves it before merge; fallback and known limitation are written into the plan Risks and ADR 0007. |
| 3 | LOW | `RightPaneShell` moves focus on a fresh open; `{ focus: false }` plus `suppressNextContentFocus` is the existing guard. | T010 asserts composer focus in the fake-omp live check (SC-001). |
| 4 | LOW | `jsonschema` crate may not be a dependency. | T001 decides; a hand check of `type`, `required`, `properties`, `additionalProperties` is the fallback and is enough for the seven actions. |
| 5 | LOW | #1785 and #1837 edit `launch.rs` and `frame.rs`. | Edits limited to one call and two match arms; rebase risk accepted. |
| 6 | INFO | Chunks A (`src-tauri/**`), B (`src/renderer/**` except `App.tsx`) and C are file-disjoint; both A and B read `contracts/panel-actions.json`, written once in T001. | None needed. |

## Open

- Real-omp behaviour of the overlay (finding 2) is the one unknown; it is a live check, not a question for Stuart.
