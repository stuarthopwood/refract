# Analysis: spec 135 (#1861)

Read-only cross-check of `spec.md`, `plan.md` and `tasks.md` against the issue, the 2026-11-17 and 2026-11-18 grill comments and the code at `origin/main` 6f3a93c9.

## Coverage

| Requirement | Plan section | Tasks |
|---|---|---|
| FR-001 three tools | Target plan, Tool results | T007-T010 |
| FR-002 rules | Target plan | T007 |
| FR-003 helper | `start_conversation_with` | T001 |
| FR-004 deferral | Deferral state | T003-T006 |
| FR-005 errors | Target plan | T007 |
| FR-006 event | Event and renderer | T011 |
| FR-007 card text | Target plan step 6 | T007 |

Every scenario in the spec maps to a numbered live check in `plan.md`.

## Findings

- **Resolved 1 (tests).** `AGENTS.md` on `origin/main` (line 36, epic #1918) requires co-located unit tests using the shared test utilities, so the "no new tests" note is dropped. `tasks.md` adds a `*.test.rs` task beside each implementation task; the 15 fake-omp live scenarios stay.
- **Open 2 (superseded text).** The 2026-11-17 rule "another Session that is Working is refused with `invalid_state`" is replaced by deferral (2026-11-18). The spec records the replacement; the issue body should be updated.
- **Open 3 (unverified code).** The plan cites `handle_turn_settled` (`frame.rs:188`) and the stop paths, but the settle handler body was not read in full. Implementation must confirm the hook point is after the status becomes idle and that `turn_abort_requested` is still readable there.
- **Open 4 (agent sees the notice).** Whether a transcript notice reaches omp as context on the next turn is unverified. Scenario 8 checks it; if not, the fallback is to prefix the next user prompt with the notice.
- **Open 5 (stopped target).** The `conversations.startNew` handler body was not read; A5 depends on it (a stopped Session may no-op `startNew`, `conversations.rs:12-22`).
- **Open 6 (spec number).** Number 135 was the next free on `origin/main`; parallel Wave 5 lanes may have picked the same number. The folder suffix `-1861` keeps the paths distinct; Main should renumber on merge if needed.
- **Low (role gating).** Which roles and depths get the tools is assumed to match the other Session tools (A7); `agent_tools/mod.rs` registration should be checked at implementation.
- No duplicated or contradictory requirements found inside the three documents. No requirement lacks a task.

## Implementation findings (2026-11-18)

- **Finding 3 (settle hook).** `handle_turn_settled` clears `turn_abort_requested` in its first lock block, before `set_status(Idle)`. The flag is therefore NOT readable after idle: the hook must read it in that first lock block and pass it on. The hook runs after `set_status(Idle)`, next to `token_guard::on_turn_settled`.
- **Finding 5 (`conversations.startNew`).** A Stopped Session calls `start_with_conversation(None)`, any other status calls `start_new_conversation()` (which refuses with `not-idle` unless Idle with a process). It is not a no-op for a Stopped Session, so A5 holds.
- **Finding 6 (role gating).** `ToolAccess::for_depth` always returns `Role::Root`; `tools_for` offers `SESSION_TOOLS` to every Root Session. Adding the three names to `SESSION_TOOLS` is the whole gating change.
- **Deviation (T001).** The shared helper is `start_conversation_then_send(FirstMessage { text, handoff_note })` in `session/agent/start_with_message.rs` (staged errors `BeforeNew`/`AfterNew`, so a retry never starts a second Conversation), not `start_conversation_with` in `handoff.rs`; `hand_off()` calls it and keeps the `handoff-send-failed` wording.
- **Deviation (T002).** `switch_core` does not return `unchanged`: the IPC `conversations.open` reloads the current Conversation, so that behaviour stays; the tool decides `unchanged` from `is_current` in its own lookup.
- **Deviation (T011).** The event is named `SESSION_CONVERSATION_CHANGED` (`session:conversation-changed`), not `..._SWITCHED`: it fires after a start and a switch alike, and it landed with the T001 helper. The renderer listener only clears the old Conversation's scroll memory; the transcript rides the backend patch reset and the composer draft is untouched, so "keep the draft" holds by not touching it.
- **Deviation (T012).** A registry `Session` list was not added. The sidecar `store/handoff_notes.rs` (`<data_dir>/handoff-notes.json`, keyed by the Conversation's file name) already records every agent-started Conversation, and `saved_history_cache.rs` and `queued_handoff.rs` read it to flag the first message; a second list on `Session` would duplicate it and need a registry migration. The label is `HandoffNoteLine`, a shared `SourceTag`, rendered by `UserMessageRow` for `source.kind === 'handoff'`. The `serde(default)` registry test does not apply; the sidecar tests cover the missing or unreadable file case.
