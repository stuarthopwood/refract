# Analysis 054

Cross-artifact check of spec, plan, research, data model, contract, quickstart and tasks.

## Findings and resolutions

1. **Spinner conflict.** The issue's grill 6 asks for a spinner on the Add project button; the UI ruling (2026-10-29) removes it. Resolved: spec FR-004 and the quickstart follow the ruling; the issue text is superseded and recorded in Clarifications.
2. **Extra channel.** The contract first had a separate `listGitHubOwner` for Retry. Resolved: folded into `listGitHub(owner?)`; the brief's channel list (three channels, one event, one key) is unchanged, plus one setter `settings.setDefaultCloneFolder`.
3. **Setter channel is not in the issue.** Needed because the Settings > Projects row and the "Use this folder" checkbox both write the key. Named to match `settings.set*`; recorded in Clarifications.
4. **`ipc.ts` cap.** The file is at 902 lines. Plan T010 requires a net-zero edit, with types in the new shared module; FR-036 matches. Risk: if net zero is impossible, extract a block in the same change (stated in T010).
5. **`repositories.rs` cap (565).** T004 extracts one function (a few lines net); all other code is in new modules. FR-036 matches.
6. **"Most recently updated" vs gh order.** gh sorts by last push. Resolved: re-sort by `updatedAt` (FR-026, research).
7. **Multiple accounts.** The issue says "every signed-in gh account". gh uses the active account for `repo list` and `api`, and switching accounts would mutate user state. Resolved as a documented limit: own logins plus the active account's organisations; non-active private repositories appear only if the active account can see them. **Open question for Stuart**, non-blocking; paste covers the gap.
8. **Add-step failure after a successful clone.** The issue is silent. Resolved: keep the clone, say so (FR-031, `done-not-added`). Marked as an assumption.
9. **Existing empty destination.** The issue says refuse non-empty. Resolved: allow an empty one but treat it as pre-existing so it is never removed (FR-027, FR-029, edge cases).
10. **`resolve_gh` and #1343.** A stale tools-folder `gh.exe` wins over PATH. The clone uses the same resolution on purpose (FR-022); the quickstart documents how to fake gh without touching the real tools folder.
11. **Coverage.** Every FR maps to a task: FR-001 to 005 to T013, T014, T018; FR-006 to 017 to T011, T015 to T017; FR-018, 019 to T012, T016; FR-020 to T019; FR-021 to 035 to T001 to T007; FR-036 to T009, T010; FR-037 to 039 to T011 to T019 and the gate; FR-040 to the gate (no tests); FR-041 to 046 to T030 to T035.
12. **Principle V.** Argument arrays only, github.com-only parsing in Rust, plain-text descriptions, no remote content, no token handling: FR-022, FR-025, FR-028, FR-037, contract "Process rules". Consistent.
13. **Destructive operation.** The only delete is the created-by-us folder, by literal resolved path, with re-checks (FR-029). Matches the safe-deletion rule.
14. **Prototyping rule.** No new tests anywhere; every task has a quickstart or gate verification. The spec says so (FR-040).
15. **Collisions.** `SessionList.tsx` is also touched by #811, #638, #735, #748; T018 is small and the plan says rebase before the gate. PR 2 is a separate PR to isolate the sweep.
16. **ModelPicker extraction.** `FilterableGroupedListbox` is extracted by pattern; `ModelPicker` is not migrated (FR-007) to avoid regressing it. A later follow-up, not in this story.

## Result

No unresolved inconsistencies. One non-blocking open question (finding 7). Ready for `/speckit.implement` of PR 1.
