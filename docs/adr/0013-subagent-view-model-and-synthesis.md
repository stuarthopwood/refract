# One shared view-model and a cached synthesis for the Subagents card

Status: Accepted. Date: 2026-11-26. Decider: Skippy, recommended options, delegated by Stuart (#1925 grill; Stuart was away).

Epic #1931 redesigns the Subagents card in the chat and the **Subagent panel** in the right pane. Today each surface derives its own data. The chat card reads transcript `kind:'subagent'` items. The panel reads readout `SubagentSummary` entries. The redesigned design (`docs/design/subagents-redesign/src/data/chatScenarios.ts`) needs fields neither source carries: a human `role` per agent, an `overallGoal` per orchestration, the files an agent touched, and a live "what is it doing" line. Issue #1925 builds the one module that produces all of it, so the other children of #1931 render and never re-derive.

**Decision:**

- **Q1. Where the view-model lives.** A pure TypeScript module in `src/renderer/features/subagents/viewModel/`, imported by both the chat card and the panel. The derivation is presentation (titles, counts, single or parallel), and the mock's `StageItem` and `SubAgentItem` shape is a UI contract. Rust keeps raw data and the synthesis cache. The type has one consumer area, so it lives beside it, not in `src/shared/`.
- **Q2. Source.** The two surfaces have different inputs, so the module has two entry points returning the same `ChatScenario`, `StageItem` and `SubAgentItem` types. `fromTranscript` serves the chat card: transcript items are the base and readout summaries overlay live fields (status, duration, heartbeat, files touched), matched on `toolCallId` plus `specIndex`. `fromSummaries` serves the Subagent panel, which has no transcript items and reads only `SubagentSummary` from `useReadoutStore`. Transcript items survive a restart through replay, and summaries carry the live heartbeat. Two derivations that each feed one surface are the drift this epic removes, so both entry points share one set of derivation helpers.
- **Q3. Who runs the synthesis.** Rust, as a one-shot model call on the `tiny` role. Rust already holds the spawn arguments and can cache to disk. Running it on the Session's own agent would bill the main model and break the token budget.
- **Q4. When it runs, and the cache.** One batched call per `task()` call, when its arguments are first seen. It returns the Stage's `overallGoal` and a `role` for each agent as JSON. The result is stored in the Session's data folder, keyed by `toolCallId`. Replay and restart read the cache. A history item with no cache entry is never synthesised, so opening an old Session costs nothing. Nothing calls a model on render.
- **Q5. Unset `tiny`, failure or timeout.** Omit `role` and `overallGoal`, and fall back to today's `computeStageLabel` heuristics. Never fall back to `default` or `smol`: an unset `tiny` resolves towards `default`, the expensive model this rule exists to avoid. No retry loop; a later spawn tries again.
- **Q6. Files touched.** Rust accumulates them per agent in `subagents_progress.rs`: the path of each write or edit entry in `recentTools`, deduplicated, capped at 50, emitted on the summary. The renderer remounts and loses frames; Rust sees every frame. `recentTools` is a rolling window, so the UI labels the list "Files touched" and never presents it as complete. The heartbeat's `args` is a preview string today, so the reader takes it as the path and also accepts an object with a `path` key.
- **Q7. Prompt size.** Task text is capped at 2,000 characters per agent and the shared `context` at 4,000, after worktree paths and `Rules (HARD)` boilerplate are stripped. Output is capped at 120 characters for the goal and 40 for each role.
- **Q8. Privacy.** No new setting in #1925. The calls use the provider and model roles the user already configured, and send only the spawn arguments the Session's model already saw. An opt-out is a follow-up if Stuart wants one.

**Field contract (Rust to renderer):**

| Field | Type | Where | Source |
|---|---|---|---|
| `role` | `string?`, at most 40 characters | `SubagentSummary` (the panel reads only this) and the transcript `kind:'subagent'` item | synthesis, or cache on replay |
| `overallGoal` | `string?`, at most 120 characters | the same two, repeated on every agent of one `toolCallId` | synthesis, or cache on replay |
| `filesTouched` | `string[]?`, at most 50, deduplicated, first-seen order | `SubagentSummary` only | heartbeat accumulation |
| `recentSteps` | `{ tool: string; intent?: string; target?: string; isError?: boolean; endMs?: number }[]?`, at most 5, newest last | `SubagentSummary` only | latest heartbeat `recentTools` |

Every field is optional, so an older Rust build, an unset `tiny` role and a replayed history item all render through the fallback path.

**Consequences:**

- Rust gains a synthesis runner, a disk cache and a files-touched accumulator. The renderer gains one module with no IPC of its own. The two sides are file-disjoint and build against the table above in parallel.
- A Session's agents run exactly as before. The synthesis is a side call, never part of the agent's own turn, and its failure changes only the labels.
- History opened before this change shows heuristic titles and no role, because its items have no cache entry. That is deliberate: it costs no tokens.
- `filesTouched` and `recentSteps` are live only. After a restart a finished agent shows no files, because the heartbeat is not replayed.
- The `tiny` call is the first Rust-initiated model call in Refract. The runner goes through the same `omp` executor the config reads use, so tests substitute a fake and no test spends tokens.
- Revisit Q8 if a user asks for an opt-out, and Q5 if OMP ships a per-feature cheap-model hook.
