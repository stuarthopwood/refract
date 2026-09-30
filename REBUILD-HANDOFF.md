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
