# Implementation Plan: Stacked pull requests via gh stack

**Spec**: [spec.md](spec.md) | **Research**: [research.md](research.md) | **Issue**: #1867 | **Route**: specify (spec 132)

## Summary

One boolean setting plus a small gh-stack module in Rust (probe, view, merge, install), a pure chaining function shared by the renderer, a stack block appended to the Session rules file, and UI additions to the existing Pull requests components. No new IPC channel for the agent; no change to `gh pr merge`'s own path.

## Grounding (origin/main 7149e691; re-verify at implement time)

- Setting pattern to copy: `codeLigatures` (`store/settings.rs`, `store/code_ligatures.rs`, `ipc/settings_code_ligatures.rs`, `ipc/mod.rs`, `src/shared/ipc.ts`, `shared/model.ts`, `tauri-bridge/index.ts`, `state/settings-store.ts`). Default true uses the `!== false` read.
- `github/gh.rs`: `gh_raw(cwd, args, not_found_code, timeout)` and `resolve_gh()` (portable `gh` first). `TIMEOUT_MS` is 15 s, too short for a stack merge or an extension install; callers pass their own timeout.
- `github/gh_mutations.rs:394` `merge_pull_request`; `ipc/pull_requests/handlers.rs:416` its handler. Both stay; the new route is a sibling.
- `omp/process_args.rs` -> `token_guard::launch_args(dir, plan_mode)` -> `args.rs:56` pushes `--append-system-prompt <rules file>`; `token_guard/rules.rs` writes `include_str!("../../../resources/refract-rules.md")` (a test pins it between 1000 and 2000 chars).
- Renderer: `src/renderer/features/pull-requests/{MergeDialog,PullRequestDetail,PullRequestRow,PullRequestList}.tsx`; UI is built from `src/renderer/components/` (ADR 0003).

## Design decisions

- **D1 Setting.** `stackedPullRequests`, default true, plumbed like `codeLigatures`. The toggle reads the live gh-stack state (D3) and shows the inline not-installed row with **Install**.
- **D2 Stack data and merge routing.** New `github/stacks.rs` (about 200 lines, with `stacks.test.rs`):
  - `view_stack(repo_path, head_branch)` runs `gh stack view --json <branch>`, parses `viewJSONOutput` (research.md), maps exit 2 to "not stacked".
  - Renderer `src/shared/stack-chain.ts` (pure, tested): from the loaded pull requests, chains by base/head and returns `{ position, total, layers[] }`. Used when the Project has no checkout or view fails with exit 2/ missing.
  - `pullRequests.merge` gains `stackHint: 'stacked' | 'plain'` from the renderer. Rust: checkout view says stacked -> stack path; view says not stacked -> plain path (a stale hint never wins over a successful view); no view available -> hint decides.
  - Stack path runs `gh stack merge <pr> --yes --squash`, timeout 120 s. **Guard:** because a bare number is tried as a stack number first (research.md), Rust first asks `GET repos/{o}/{r}/stacks/<pr>`; if a stack with that number exists and does not contain the pull request, it refuses with a clear error instead of merging. No fallback to `gh pr merge` on failure.
  - Exit codes map per FR-007 into the existing merge error type; exit 9 also records the repository as `unavailable-for-repo` (D3).
- **D3 State.** `github/gh_stack_state.rs`: `GhStackState { Ready, Missing, Outdated, }` from `gh stack --version` (parsed, floor 0.3.0), cached with a short TTL and invalidated by Install; `unavailable_repos: Mutex<HashSet<(owner,repo)>>` in memory only, empty at launch (so the re-probe is the first call). IPC `githubStack.state` returns `{ tool, unavailableForRepo }`; `githubStack.install` runs install (or upgrade when `Outdated`) with a 120 s timeout then re-probes. Not-installed and `GhUnavailable` stay distinct.
- **D4 UI.** `StackBadge` and `StackLayers` in `pull-requests/` built from shared `Badge`/`LinkButton`/`Callout` components (extend by prop if one is missing; no copies). Row shows "2 of 3"; detail lists layers with links that select the pull request in the view. `MergeDialog` shows the not-installed callout with **Install** and the "merges layers 1 to N together" line for stacked pull requests. `PullRequestList` computes chaining once per load.
- **D5 Agent notes.** The stack block is a second resource `resources/refract-stack-rules.md` (under 1,500 chars; commands from `docs/stacked-prs.md`: positional branch names, `submit --auto`, `view --json`, never prompt commands, exit 9 means stop and report, do not use `gh pr create`). `rules::write(dir, stacked)` writes rules or rules plus the block into the same `refract-rules.md`, so there is still one `--append-system-prompt` flag and omp's repeat behaviour does not matter. `launch_args` gains `stacked: bool`; `OmpProcessOptions` gets `stacked_prs: bool` set at the Session launch site from the setting and the cached state (`Ready` only).
- **#1859 merge order.** Both lanes edit `token_guard/args.rs` near the append line. This lane changes only the `launch_args` signature and the `rules::write` call; if #1859 lands first, rebase and keep its additions; if this lands first, #1859 adapts. Either way the conflict is confined to `args.rs` and resolved by keeping both.
- **Size caps.** `gh_mutations.rs`, `handlers.rs` and the PR components stay under 600 lines; new code goes in the new modules above and handlers/dispatch lines only.

## Verification

- Unit: setting default/persist/parse; version parse and floor; exit-code mapping; view JSON parse (fixture from research.md); chaining (3-layer, forked, merged middle, no chain); merge argv for stacked vs plain; the collision guard; rules file with and without the block; every guard has a test that fails when the guard is removed (AGENTS.md).
- Live: `scripts/verify-tauri-1867.mjs` using a fake `gh` first on PATH (pattern: `scripts/verify-tauri-874.mjs`, isolated per `refract-tauri-live-check-isolation`): toggle, notes in the rules file, missing -> Install -> ready, 3-layer position render, stacked merge argv, exit 9 once per repository and again after relaunch. Screenshots in the PR.

## Risks
- The REST shape of `stacks/<n>` is unobserved (no stacked PR existed on the repo); T003 spikes it with the real `gh` before D2's guard is coded, and falls back to the CLI's own refusal if the endpoint is unusable.
- `gh stack view --json` is per current branch; running it for every candidate head is N process launches. Cap at the pull requests on screen and cache per load.
