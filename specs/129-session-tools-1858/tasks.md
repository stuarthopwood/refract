# Tasks: Agent Session read tools and messaging (#1858)

Test tasks are part of each task (AGENTS.md Testing rule: new logic gets co-located unit tests; each guard's test must fail when the guard is removed). Files stay under the 600-line cap; `router.rs` (523) gets dispatch lines only. Do not run `ci:local` until the last task.

## Wave 0: contract (first, one worker)

- [x] T001 `src-tauri/src/agent_tools/envelope.rs` (+ `envelope.test.rs`): `wrap`, `parse`, shared escape table. Tests: round trip, forged and nested tags, quote in name, non-envelope stays plain, two envelopes rejected, parse is anchored at both ends. (FR-007, FR-008, FR-015)
- [x] T002 `src-tauri/src/omp/transcript.rs` (+ test): `MessageSource`, `TranscriptItem::User.source`, parser calls `envelope::parse` on load and live; `src/shared/model.ts` mirror. Tests: source set from a valid envelope, body unescaped, absent otherwise. (FR-015)

## Chunk A: Rust tools (files: `src-tauri/src/agent_tools/**`, small session hooks)

- [x] T003 `agent_tools/sessions.rs` (+ test): tool defs, `status_of` mapping table, `list` (project match, archived flag, `self`, `hidden`, 8 KiB trim with `truncated`/`total`), `get_status` with PR from readout cache or one backed-off `pull_request_for_branch`. Tests per case, including trim keeps caller's row and `list` never looks up a PR. (FR-002 to FR-006)
- [x] T004 `agent_tools/sessions_send.rs` (+ test): `send` with check order, outcomes `sent`/`queued`/`held`, `session_not_running` with status, no launch, no decoration, no approval resolution. Tests: each error, order, archived refusal, stopped refusal starts nothing. (FR-007 to FR-012, FR-014)
- [x] T005 `agent_tools/sessions_limit.rs` (+ test): per-pair rolling limit, 10 per 10 min, refused sends not counted, window slides. Test fails if the limit check is removed. (FR-013)
- [x] T006 `agent_tools/mod.rs`, `router.rs`: Root row adds the three tools, Child stays empty, `Plan::Native` dispatch, `needs_approval` false, 8 KiB cap and cancel reused; `SessionAgent::send` gains a `decorate` flag only if needed (existing callers pass `true`). Test: `tools_for(Child)` empty and a Child-role call to a Session tool is `unknown_tool` (SC-004), Root lists all three, none asks approval in any mode, a call from a shutting-down Session is `cancelled`. (FR-001, FR-009, FR-018, FR-019)

## Chunk B: Renderer label (files: `src/renderer/**` only; parallel with A after T002)

- [x] T007 `src/renderer/components/SourceTag.tsx` (+ test): optional `action` slot rendering a real button; plain text when absent. Tests: keyboard Enter/Space activate, no `action` stays inert, existing callers unchanged. (FR-016, ADR 0003)
- [x] T008 `src/renderer/features/chat/UserMessageRow.tsx` (+ test): "From Session <name>" line above the bubble when `source` is set; link calls `useSessionsStore.getState().open(id, true)`; deleted sender shows id as plain text; no extra focus call; bubble accessible name includes the line. (FR-016, FR-017)

## Chunk C: live check and docs (after A and B)

- [ ] T009 `scripts/verify-tauri-1858.mjs` and fake-omp tape support in `scripts/verify-tauri-fake-omp.mjs`, run with the `pnpm verify:tauri` harness: call each of the three tools; check registration, no approval card, list rows and `self`, status vocabulary for running and stopped Sessions, `sent`/`queued`/`held`/`session_not_running`/`rate_limited`, every error with no toast (SC-003), the envelope reaching the target, the label rendering before and after a reload (SC-002) and the link switching Session without focus moving. Screenshots and timings recorded. (SC-001 to SC-004)
- [x] T010 `docs/adr/0008-session-message-envelope.md`, `CONTEXT.md` term **Session message**, `docs/PLAN.md` row 1c.2. (FR-020)
- [ ] T011 `pnpm ci:local`; fix regressions only.

## Dependencies

T001 -> T002 -> (A: T003, T004, T005 -> T006) and (B: T007 -> T008) -> T009 -> T010 -> T011.
