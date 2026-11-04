# Tasks: Chat header badge tracks Session-written PRs and issues

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)
**Rules**: no new tests (prototyping); `[P]` = different files, no dependency on an unfinished task. Stories: US1 PR created, US2 latest plus overflow, US3 branch PR and origin issue first, US4 restart and reset, US5 other repositories.

## Phase 1: Shared contract (blocks everything)

- [x] T001 Add `TouchedRef` and optional `SessionReadout.touched?` to `src/shared/model.ts` per plan "Data and contract notes".
- [x] T002 [P] Create `src-tauri/src/session/github_writes/shell_words.rs`: quote-aware tokenizer returning simple commands split at unquoted `&&`, `||`, `;`, `|`, `&`, newline; heredoc and `$(...)` bodies stay opaque.
- [x] T003 [P] Create `src-tauri/src/session/github_writes/touched.rs`: `TouchedList` (dedupe by repo, kind, number; newest first; cap 50; move-to-front on repeat) and its `TouchedRef` JSON writer.

## Phase 2: Detector (US1, US2, US5)

- [x] T004 Create `github_writes/gh_commands.rs`: map a simple command to `GithubWrite` for `gh pr create|merge|close|comment`, `gh issue create|edit|close|comment`, and `gh api` with POST, PATCH, PUT, DELETE or `--input` on `repos/{o}/{r}/(pulls|issues)/{n}`; per-verb value-flag skip table; `-R/--repo`; URL and number arguments (depends on T002).
- [x] T005 Create `github_writes/mod.rs`: `ToolCallRecord`, `GithubWrite`, `WriteKind`, `WriteAction`, `detect` (bash command; eval string literals starting `gh `; errors ignored; number from arguments else first GitHub URL in output; unresolved dropped) (depends on T004).
- [x] T006 [US4] Create `github_writes/history.rs`: `detect_in_history` pairing `toolCall` blocks with `toolResult` messages by id, taking timestamps from the messages (depends on T005).
- [x] T007 Declare the new modules in `src-tauri/src/session/mod.rs` (depends on T005, T006).

## Phase 3: Readout integration (US1, US2, US3, US4)

- [x] T008 [P] In `readout_pr.rs` add `item_by_number(repo_path, owner, name, kind, number)` using GraphQL `issueOrPullRequest(number:)`, sharing `UNAVAILABLE_UNTIL` back-off and the title and URL bounds; returns title, url, state (open, closed, merged, draft).
- [x] T009 Create `readout_touched.rs`: stash bash and eval arguments by `toolCallId` at `tool_execution_start` (cap 64), build `ToolCallRecord` at `tool_execution_end`, call `record_writes`; `rebuild_from_history`; `reset` (depends on T005, T006, T003).
- [x] T010 In `readout_touched.rs` implement `record_writes` as the single fan-out point (updates the list, schedules a readout update) and the lazy state refresh: at most one `item_by_number` per item per recompute, spawned, previous state kept on failure (depends on T008, T009).
- [x] T011 In `readout_touched.rs` resolve each item's `repositoryId` by comparing `owner/repo` with registered repositories through `owner_repo_for` (cached) (depends on T009).
- [x] T012 In `readout.rs`: add the touched state to `State`, call `readout_touched` from `on_frame` (start and end frames) and `on_conversation_reset`, write the `touched` key in `assemble` only when non-empty; keep the file under 600 lines (depends on T010, T011).
- [x] T013 [US4] In `agent/launch.rs` and `agent/conversations.rs` pass the loaded history to the readout so the touched list is rebuilt on attach and on opening a Conversation, and cleared for New conversation (depends on T012).

## Phase 4: Header UI (US1, US2, US3, US5)

- [ ] T014 [P] Create `src/renderer/features/chat/header/usePinFromMenu.ts` extracting the pin-then-keep-focus handling from `LinkedIssueControls.tsx` and make `LinkedIssueControls.tsx` use it (no behaviour change).
- [ ] T015 [P] Create `header/openTouched.ts`: pin to the right pane when `repositoryId` is set, `shell.openExternal(url)` otherwise.
- [ ] T016 Create `header/TouchedRefControls.tsx` with `badge` and `overflow` modes from `Badge`, `HeaderActionButton`, `DropdownMenu` (PR state through the shared `StatePill`): kind icon, `owner/repo#N` for a foreign repo, state as text or labelled icon, +N label "N more pull requests and issues", arrow-key menu, rows newest first (depends on T001, T014, T015).
- [ ] T017 Update `HeaderPrControls.tsx`: build the #1315 items, drop touched items that duplicate them, render `TouchedRefControls` in `badge` mode only when neither a branch PR nor linked issues exist, else `overflow` mode after the #1315 controls; return null when nothing exists (depends on T016).

## Phase 5: Verification and docs

- [ ] T018 Acquire the build slot and run `node scripts/ci-local.mjs`; fix only what this story broke, release the slot (depends on T013, T017).
- [ ] T019 Check `pnpm check:comment-density`, the 600-line cap (`readout.rs`, `model.ts`) and `git diff --stat` for whole-file churn (depends on T018).
- [ ] T020 Live check with `pnpm exec tauri build --debug --no-bundle` on a scratch copy and a fake omp: emit bash `gh pr create` start and end frames, assert the badge, then five issue creates for "+4", a branch-PR session for overflow-only mode; add a committed `scripts/verify-header-touched.mjs` CDP driver; screenshots of each state (depends on T018).
- [ ] T021 Keyboard and accessibility pass on the live build: +N accessible name, arrow keys and Enter in the menu, Escape returns focus to the button, state readable without colour (depends on T020).
- [ ] T022 Update this story's `docs/PLAN.md` row (status and PR link) and, if user-facing wording was introduced, `CONTEXT.md`.

## Dependencies and order

Phase 1 first (T002 and T003 parallel). T004 to T007 sequential on T002. T008 parallel with Phase 2. Phase 4's T014 and T015 can start as soon as T001 lands and run beside Phases 2 and 3. T018 onward after both backend and UI land.
