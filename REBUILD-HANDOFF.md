# Rebuild handoff (2026-09-30)

Delete this file once the rebuild is committed and verified.

## Situation

This repo was wiped on 2026-09-30 by an agent command (`rm -rf "C:${unsetVar:-}"` became `rm -rf "C:"`, which is the cwd on Windows). It was restored from `origin/main` at `ac25cce`. All uncommitted work after `ac25cce` is lost and must be rebuilt. Read `AGENTS.md` first: it holds the destructive-operations rules. Guards (`~/.omp/agent/hooks/pre/destructive-guard.ts`, `~/.omp/agent/rules/no-unsafe-rm.md`) load in a NEW session only.

## Sources for the lost work

- Transcripts with every write/edit call: `~/.omp/agent/sessions/--C--Repos-personal-pinion--/2026-09-30T12-46-39-553Z_01a0f25a-4dc1-74b8-9246-ec45a066a917/<Agent>.jsonl` (MainCore, TranscriptUI, RendererRest, ListReadiness, InputSwitcher, SecAudit, CodeReview, Scaffold).
- Spec state: `specs/`, `.specify/`, `docs/FINDINGS.md`, `.specify/memory/constitution.md` (v1.4.0 here; v1.5.0 was lost).
- Tasks: T001-T015 ticked and closed. T016-T045 were implemented but not ticked and issues #34-#63 were not closed. T046-T049 pending. Issue #22 (T004 openExternal breakaway check) open.

## Rules for the rebuild

1. Commit and push after EVERY verified wave.
2. Every worker brief carries the safe-deletion clause from `AGENTS.md`.
3. No deletes inside the repo except named scratch files. Clean up from a cwd outside it.

## Lost work to reapply

A. Preload: expose `sessions.setVisible` and `repositories.pickFolder` in `src/preload/index.ts` (preload must list every `PinionApi` method; 0 of 29 missing after the fix). Remove the `?.` guard in `src/renderer/state/sessions-store.ts`.

B. Transcript UI:
- `transcript-store` reset adopts sessionId.
- `sessions-store` `setVisible` try/catch, `open()` token and `openingIds`.
- `ChatPane` try/catch and a "Starting the agent..." state.
- `NoticeRow.tsx` (clamp long notices, collapsible) with `Transcript.tsx` delegating to it.
- `safe-url.ts` plus `Markdown.tsx`: only http/https links, otherwise plain text.
- `RequestCard`: `inputKind` choice/text/confirm, message, `optionDetails` strings, confirm sends `{confirmed}`.
- `ErrorBoundary.tsx` wrapping `SessionList` and `ChatPane` in `App.tsx`.
- `queue-store` keyed `bySession`.

C. Renderer rest: `toggle.tsx` selected style (`aria-checked`/`aria-pressed`, `bg-primary`); `tooltip.tsx` instant-open state.

D. Main process core:
- `sessions.open` does not auto-restart for `agent-exited`/`start-failed` (`canAutoStart`; recover restarts).
- Idle mode change applies immediately (`setPendingMode` restarts when idle; reverting clears pending; `syncFromState` records `currentConversation`/`lastMessageCount` only when `messageCount > 0`).
- `startNewConversation` sets `currentConversation` null.
- `recreateWorktree` then `open` reattaches via `switch_session`.
- REMOVE `--resume` everywhere; use `switch_session` via `attachAndVerify`.
- `dialogs.pickApprovalTarget` prefers `Path:`/`File:`/`Command:` first detail line only.
- Security: `openExternalSafe` (http/https only); `NoDefaultCurrentDirectoryInExePath=1` plus `resolveExecutable` absolute paths (git/omp/taskkill/pwsh) in `src/main/process/executables.ts`; `conversations.open` file validation (`.jsonl`, inside `session.sessionDir`, from `listConversations`) plus consistent state on failed verify; exact-origin `will-navigate` and block drag-drop navigation; `baseBranch` membership in `listBranches` and no leading `-`; `sessions.delete` only deletes jsonl files of that Session inside `~/.omp/agent/sessions`; pid validation in `pidRecords`; permission request/check handlers deny; serialized registry/settings/pid writes with unique tmp names.
- Review fixes: cancel frame `targetId`; confirm mapping; `optionDetails` objects to strings; restart re-entry guard plus dedupe settle; `start()` single-flight, shutdown awaits start, delete removes agent; failed start kills child; `openConversation` consistency; `emitPatchReset` clears `pendingOps` and merges transcript; ipc error codes (`prompt-failed`, `agent-not-running`) with try/map in chat handlers; chunk error rejects pending; stop `waitForIdle` ends on stopped; remove `pinionScaffoldCheck`; dedupe ipc `util.ts`; `SessionAgent` at most about 800 lines.

E. Docs: constitution v1.5.0 (Principle III: MUST NOT use `--resume`; bind via `switch_session`); `FINDINGS` items 17 (`--resume` unsafe after worktree recreate; `get_state` `sessionFile` before first message) and 18 (E2E run summary); `data-model`, `plan`, `research`, `omp-usage` edits (`switch_session`, idle mode change immediately, only record `currentConversation` once `messageCount > 0`).

## After the rebuild

1. Build, typecheck, tests, then E2E smoke on the built app (CDP over `electron.exe . --remote-debugging-port --user-data-dir`).
2. Tick T016-T045 in `specs/*/tasks.md`; close issues #34-#63 and #22 when verified.
3. Re-run the quality gate (`skill://quality-gate`): SecAudit and CodeReview both returned FAIL before the wipe (1 Critical `openExternal`, 1 High cwd exe search, 7 High from CodeReview).

## Review findings to fold into the rebuild

Process:
- Quality gate is a HARD RULE (`skill://quality-gate`). Run it at every phase checkpoint before pushing: build/typecheck, lint, and ONE parallel batch of `code-reviewer`, `security-auditor`, and `accessibility-auditor` (Pinion is entirely UI). Report the `VERDICT` lines. "No automated tests" only empties the test-suite step.
- Memory: 16 GB box. Keep to one live `omp` probe plus one Electron instance at a time. Do not run dev server, Chromium, and `omp` together (OOMs and crashes OMP).
- If parallel agents each run Electron, give each a distinct `--remoteDebuggingPort` (9223, 9224, 9225), a fresh `--user-data-dir`, and confirm the attached window by a per-agent marker before verifying anything.
- Timebox: check in at 2x the estimate. Usual hangs: an interactive `shadcn init` prompt, or a `pnpm dev`/Electron window that never exits.
- When checking exit codes through a pipe, use `set -o pipefail` or `${PIPESTATUS[0]}`, not the exit code of `tail`.
- Concurrent writers overwrote shared files (preload, `App.tsx`, `sessions-store.ts`, `ChatPane.tsx`, `MessageInput.tsx`, `shared/ipc.ts`). Give each file one owner per wave, and diff against each worker's reported changes before the gate.
- Add `*.tsbuildinfo` to `.gitignore` before the first commit.
- E2E hygiene: write Conversations only under a scratch `--session-dir` or clean up every `~/.omp/agent/sessions/-AppData-Local-Temp-pinion-e2e-*` directory afterwards, delete the scratch repo and worktrees by literal path, and confirm no e2e `omp` or Electron processes are left.
- Do not mark T004 `[X]` or close #22: the `shell.openExternal` breakaway check was never run. Run it before T017 wires `openExternal`, or split it into its own issue (`spike`, `transport`, `p1`).

Design and bug items:
1. `currentConversation` and `sessionDir` are persisted only once a settled turn reports `messageCount > 0`; start without resume while null (data-model.md). Otherwise a healthy empty Session fails reattach after a restart.
2. Idle mode change applies immediately: restart any idle Session with no pending request at once (FR-020 defers only mid-turn). After `startNew`, mark only the new unsaved conversation as current.
3. `--resume` destroys Conversations (after the worktree is removed and re-added at the same path it reports `messageCount: 0` and overwrites the file on exit). Use `switch_session` only. Add a FINDINGS item with repro and before/after file evidence, qualify the C16 `--resume` PASS, bump the constitution (Principle III cites FINDINGS), update `contracts/omp-usage.md` "Launch" and "Start-up sequence", and save the lesson to Skippy-Brain.
4. Readiness: ready when `get_available_models` contains `get_state.model` (same provider and id). Keep `get_login_providers` only for the failure hint. Update `contracts/ipc.md` before T020. Hint text: "Run `omp`, complete `/login`, then re-check." (`omp auth login` does not exist.)
5. `write` tool rows show the written content or "created / overwrote N lines". Build a diff only for `edit`, from `details.oldText`/`newText`. No per-path last-known-content cache. Record this in `omp-usage.md` before T025. The `edit` row target comes from `result.details.path` or the `[path#tag]` header of `args.input`.
6. Fix `src/shared/frames.ts` centrally: add `messageId` to message frames and put `isError` on `tool_execution_end` (not under `result`). Delete the `readMessageId`/`readToolIsError` casts.
7. `pidRecords.recordProcess` must not await PowerShell on spawn (1-4 s). Make it fire-and-forget, or add `GetProcessTimes`/`QueryFullProcessImageNameW` to `jobObject.ts` so no child process is needed.
8. Preload: declare `const api: PinionApi = {...}` (or `satisfies PinionApi`) so an unbridged channel fails the build. Drop the `setVisible?.()` guard and silent `.catch`; log failures.
9. `RequestCard` shows a pending state on click and resolves only on `chat.answer` `ok` or the `request:resolved` event; on failure restore the card with the error (FR-018/FR-019).
10. `/new` routes to `conversations.startNew`; keep `/btw`, `/fork`, `/plan` and the rest refused locally.
11. Registry and settings writes: one promise queue per file with read-modify-write inside it, and unique temp names (`.tmp-<pid>-<n>`), in `atomicJson.ts`/`RegistryStore`. This fixes the rename ENOENT and lost updates.
12. After adding a repository through the real **Add repository** dialog from a fresh `--user-data-dir`, the workspace must replace Readiness without a reload. If not, the store is not refreshed on add.
13. Unread test: start a slow turn in Session A, click Session B, wait for A to go idle, then read A's row. For crash detection subscribe to `session:status` before killing `omp`.
14. Check the dev `userData` `registry.json` is clean (or use a fresh `--user-data-dir`) before any integration run.
