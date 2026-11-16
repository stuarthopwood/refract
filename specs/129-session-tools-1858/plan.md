# Implementation Plan: Agent Session read tools and messaging

**Spec**: [spec.md](spec.md) | **Issue**: #1858 | **Route**: specify (spec 129) | **Builds on**: spec 124 (#1193), ADR 0007

## Summary

Three Host tools join the Root row of the spec 124 access table: `refract_list_sessions`, `refract_get_session_status`, `refract_send_session_message`. Rust answers all three itself (they read the registry and the live agents; no renderer round trip, no approval card). A sent message travels the existing chat send path wrapped in a fixed envelope. The transcript parser turns that envelope into a `source` on the user item, and the renderer shows a "From Session <name>" line. Nothing here starts, stops or changes a Session.

## Grounding (read at origin/main 8305cbc2; verify again at implement time)

- `src-tauri/src/agent_tools/mod.rs:33-39` `tools_for`: Root gets panel tools, Child none. Add the three Session tools to the Root arm only.
- `agent_tools/router.rs` is 523 lines (`plan` :85, `run` :393): it gets dispatch lines only. All new logic goes in new `agent_tools/sessions.rs` (and `sessions_send.rs` if it nears 600).
- `agent_tools/approval.rs:21-23` `needs_approval(mutates, yolo)`: the three tools declare `mutates: false`, so no card ever appears.
- `session/agent/types.rs:7-13` `SessionStatus {Idle, Working, NeedsYou, Stopped}`; stop reasons are in memory (`session/agent/mod.rs:59-60`, set via `set_stopped_unless_already_stopped` with `agent-exited` / `start-failed`). `store/registry.rs` carries `stopped_on_request_conversation` for the on-request marker; `worktree-missing` and `not-started` are derived.
- `store/registry.rs:35-72` `Session`: `archived_at`, `hidden_at`, `last_activity_at`, `paused_held`; no PR field.
- PR: `session/readout.rs:55-57` cache for running Sessions; `readout_pr.rs` `pull_request_for_branch` for the rest.
- Send: `ipc/chat.rs:154` `chat_send` -> `session/agent/chat.rs` `send` (`hold_if_paused`, followUp when busy, `agent-not-running` when stopped, never auto-launches). `send_unheld` skips the pause gate.
- `omp/transcript.rs:40-53` `TranscriptItem::User` has `id, text, at, file_attachments, images`; there is no `source`.
- Renderer: `src/renderer/components/SourceTag.tsx` (inert icon + word, ADR 0003 shared tag); `features/chat/UserMessageRow.tsx` renders the bubble; `state/sessions-store.ts` `open(id, userAction)` is the user-initiated switch.

## Design

### Tool channel (Rust)

- `ToolAccess` Root row adds the three tool defs from `sessions::tool_defs()`; `plan()` recognises them and returns `Plan::Native(name, args)` (a new variant answered in Rust: no `agentTools.call` event, no 10 s renderer timeout).
- `sessions::run(manager, registry, caller_id, plan)` is the single entry; `caller_id` is the stream owner.
- Errors reuse the spec 124 `ToolError` shape; new codes: `unknown_project`, `invalid_target`, `session_not_running`, `rate_limited` (see contracts/tools.md).
- **Status mapping** (`sessions::status_of`): live process + Working -> `working`; NeedsYou -> `waiting-for-approval`; Idle -> `idle`; `paused_held.is_some()` (or `is_paused`) wins over idle/working -> `paused`; no live process -> `stopped` + `stopReason` from in-memory reason, else registry marker -> `stopped-on-request`, else missing worktree dir -> `worktree-missing`, else `not-started`. Archived is a separate boolean and archived Sessions without a process read `stopped`.
- **list**: snapshot registry, filter (project by id or case-insensitive name; archived only on request), build rows, mark `self`/`hidden`, trim to 8 KiB (keep caller row, set `truncated`, `total`).
- **PR**: running -> read the readout cache; otherwise one `pull_request_for_branch` call with a short timeout and an in-memory per-branch back-off (reuse the readout backoff constants if present); failure -> `null`.
- **send**: check order per spec decision 13. Delivery: build envelope (`sessions::envelope`), call the same function `chat_send` uses (`SessionAgent::send`), map the outcome: Idle -> `sent`, busy -> `queued`, paused -> `held`. Not applying `decorate_prompt` is guaranteed by calling the undecorated send entry; if `send` always decorates, add a `decorate: bool` parameter and keep existing callers passing `true`.
- **Loop guard**: `Mutex<HashMap<(sender, target), VecDeque<Instant>>>` held in `sessions.rs`; prune on each check; record only after a successful delivery; cleared for a Session id on delete is not required (entries age out).

### Envelope and source parsing

- Format: `<session-message from="NAME" session="ID">\nBODY\n</session-message>` (spec decision "Exact envelope layout"). `envelope::wrap` and `envelope::parse` live together in `agent_tools/envelope.rs` and share one escape table so the round trip is tested in one place.
- `omp/transcript.rs`: `TranscriptItem::User` gains `#[serde(default, skip_serializing_if = "Option::is_none")] source: Option<MessageSource>` with `MessageSource::Session { session_id, name }` (kebab/camel per file convention). The parser calls `envelope::parse` on user text; on a match it replaces `text` with the unescaped body and sets `source`. This is the single path for load and live (the live path already builds items with the same function; verify at implement time).
- `src/shared/model.ts` `TranscriptItem` user variant gains `source?: { kind: 'session'; sessionId: string; name: string }`.

### Renderer

- Extend `SourceTag` with an optional `action?: { label: string; onActivate: () => void }` that renders the label as a real `<button type="button">` styled as a link when present, plain text otherwise. No new component file (ADR 0003). Keyboard: native button (Enter/Space), visible focus ring from the shared focus style.
- `features/chat/UserMessageRow.tsx` renders `<SourceTag icon label="From Session" action=...>` above the bubble when `item.source` exists; the action calls `useSessionsStore.getState().open(sessionId, true)`; when the Session is no longer in the store, pass no action (plain id text). The row's accessible name includes the line.
- No focus call is added anywhere.

### Docs

ADR `0008-session-message-envelope.md`, `CONTEXT.md` term **Session message**, `docs/PLAN.md` row 1c.2.

## Tests (AGENTS.md Testing rule: new logic gets co-located unit tests; reviewers check each regression test fails with its guard removed)

- Rust, co-located `*.test.rs`/`#[cfg(test)]` beside each module: `sessions` (status mapping table, list filter/trim/self/hidden, project match, PR source selection, send check order and outcomes, rate limit window and refused-not-counted), `envelope` (round trip, forged tag in body, quote in name, non-envelope stays plain, nested/duplicate envelope rejected), `transcript` (source set on load, absent otherwise).
- Renderer, co-located `*.test.tsx`: `SourceTag` (action vs plain, keyboard activation), `UserMessageRow` (label shown, link calls `open(id, true)`, deleted sender plain text, no `source` unchanged).
- Each guard has a test written to fail when the guard is removed (escape, self-send refusal, rate limit, archived refusal, check order).
- Live: `scripts/verify-tauri-1858.mjs` (fake-omp tape, `pnpm verify:tauri` harness) calls each tool and checks the envelope arrives and the label renders; recorded timings and screenshots in the PR.

## Risks

- `SessionAgent::send` may decorate or consume the pause hold differently than assumed; implement reads it first and adds the smallest parameter.
- The status of a Session that is mid-launch is `working`/`idle` depending on the in-memory state; the table above is the contract.
- `router.rs` has 77 lines of headroom: dispatch only; if a new `Plan` variant pushes it over 600, split `Plan` into `plan.rs` in the same task.
