# Analysis: Goal and Prewalk composer modes (#1865)

Read-only consistency check of spec.md, plan.md and tasks.md (2026-11-27).

| Check | Result |
|---|---|
| Every FR (001 to 015) has a task | Yes, see tasks.md Coverage |
| Every SC (001 to 007) has a task | Yes |
| Probe tasks come first and gate the dependent tasks | T001 gates T010, T002 gates T011, T003 gates T006 and T012 |
| Binding decisions from #1865 present | Goal and Prewalk only; second `ModePill`; Refract overlay; no persistence; Goal disabled in Plan; `away.rs` unchanged; two probes first |
| Files named exist on `origin/main` (`1b82db2e`) | Verified by read or grep: `ModePill.tsx`, `WorkingModeMenu.tsx`, `ComposerModePills.tsx`, `shared/workingMode.ts`, `omp/plan_overlay.rs`, `omp/process_args.rs`, `omp/token_guard/overlay.rs`, `session/working_mode/away.rs`, `session/prewalk.rs`, `events.rs` (`PREWALK_UPDATE`), `ipc/chat.rs`, `ipc/working_mode.rs`, `session/agent/commands.rs`, `session/agent/chat.rs`, `session/agent/conversations.rs`, `state/prewalk-store.ts`, `features/sessions/prewalkActions.ts` |
| New files (do not exist yet) | `omp/goal_overlay.rs`, `session/goal.rs`, `session/agent/goal.rs`, `ipc/goal.rs`, `state/goal-store.ts`, `features/chat/GoalPrewalkMenu.tsx` |

## Findings

1. **Unverified location**: the Session row badge slot (`SessionRowParts.tsx`) is a guess; T004 confirms it before T018.
2. **Unverified existence**: whether tests already exist for `ModePill`, `WorkingModeMenu`, `ComposerModePills` and `prewalk-store`; T004 checks, and T015, T016 create them if absent.
3. **Open INFERENCES** (spec Clarifications): single-choice picker, objective dialog, overlay always-on, Plan with a restored goal, failed overlay write is a warning, `/goal` slash command. None is a product decision; Stuart can overrule any.
4. **Unproven OMP behaviour**: abort pauses the goal (P1), `/new` drops the goal (P2), tool exposure and config precedence (P3). The build must not assume any of them.
5. No contradictions between the documents found.
