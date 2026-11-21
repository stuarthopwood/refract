# Implementation Plan: Checklist per-item controls and the send path (#2013)

**Branch**: `feat/checklist-controls-2013` | **Date**: 2026-11-20 | **Spec**: [spec.md](./spec.md)
**Input**: spec 140; protocol in [ADR 0011](../../docs/adr/0011-checklist-protocol.md) and [the design](../../docs/design/checklist-protocol.md) lines 294-345.

## Summary

Backend first. The envelope file learns a second tag; a new `checklist_envelope` module builds and parses `<checklist-item>`; `SessionAgent::send_checklist_item` delivers it undecorated; `checklist/item_message.rs` holds the pure engine (validate, build, state change, record); `ipc/checklist_item.rs` serves `checklist.itemMessage`. The `pendingComplete` primitives #2011 stored now get callers: `clear_resolved` after every op, `start_entry` from the transcript frame, `settle_started` at turn settle, `settle_unstarted` in `stop()`, `settle_all` at relaunch. The renderer then adds the per-item controls inside the #2012 panel. No `MessageSource` variant, no row rendering (#2014).

No `research.md` or `data-model.md`: every open question is closed in spec.md Clarifications.

## Technical Context

- Rust (Tauri 2, tokio) plus React/TypeScript. Tests: `cargo test` for Rust (`#[path]` test files, as `agent_tools/mod.rs:124-126`), Vitest for the renderer.
- Existing anchors (T001 re-reads each): `agent_tools/envelope.rs:6-11,100-166`; `agent_tools/sessions_send.rs:164-186`; `session/agent/chat.rs:36-162,166-265`; `session/agent/frame.rs:39-50,80-81,195-231`; `checklist/records.rs:68-211`; `checklist/developer_ops.rs:13-95`; `ipc/checklist.rs:62-168`; `src/shared/ipc-checklist.ts`; `src/tauri-bridge/checklist.ts`.

## Design decisions

1. **Tag table.** `envelope.rs` keeps `session-message` wire format byte-identical. `tag_at` matches either name from one `TAGS: [&str; 2]` table, so `shift_tags` is tag-agnostic. `parse` is unchanged in behaviour; the rejection rule (a raw tag of either name in the body) now also covers `checklist-item`. New attribute-ordered wrap/parse for `<checklist-item>` lives in `agent_tools/checklist_envelope.rs` and reuses `escape_attr`, `unescape_attr`, `escape_body`, `unescape_body` (made `pub(super)`).
2. **Delivery.** `chat.rs` gets `send_checklist_item`; `send_session_message` and it call one private `deliver_undecorated(text)`. `MessageDelivery` is reused; the IPC maps it with the existing `sessions_send::outcome_name`.
3. **Engine.** `checklist/item_message.rs` exposes `prepare(file, args) -> Result<Prepared, ChecklistError>` that runs under the store lock: validate, apply `setValue` or `accept_complete`, build the text via the builder closure, add the send record, return `{ text, rev }`. `records::accept_complete` is changed to the builder form (Clarifications).
4. **Handler.** `ipc/checklist_item.rs`: live-session check, agent lookup (`state.session_manager.get_agent`), `ask`/`complete` fail `agent-not-running` first, then `apply_detached_then(prepare)`, emit `checklist:update`, then `send_checklist_item`; on `Err` a second apply undoes the record (and the entry via `refuse_complete`) and emits again, then the handler returns the `IpcError`.
5. **Start and settle hooks.** `session/agent/checklist_pending.rs` holds `start_from_frame`, `settle_started`, `settle_unstarted`, `settle_all` as thin calls to `records.rs` plus the emit; `frame.rs`, `chat.rs` and the relaunch path each add one call.
6. **Renderer.** Pure derivation helpers (`item-controls.ts`), a drafts store, one `ChecklistItemControls` component plus a small `ItemForm`, wired into the #2012 item row. Components use `ui/button`, `ui/radio-group`, `ui/textarea`; no new colour tokens.

## File budget

| File | Now | Change | Budget |
|---|---|---|---|
| `agent_tools/envelope.rs` | 170 | tag table | 190 |
| `agent_tools/checklist_envelope.rs` + test | new | wrap/parse | 150 + 220 |
| `session/agent/chat.rs` | 339 | `send_checklist_item`, stop settle | 390 |
| `session/agent/frame.rs` | 385 | two calls | 410 |
| `session/agent/checklist_pending.rs` + test | new | hooks | 120 + 200 |
| `checklist/item_message.rs` + test | new | engine | 200 + 300 |
| `checklist/records.rs` | 215 | builder signature | 225 |
| `checklist/ops.rs`, `result.rs` | n/a | one error code | +6 each |
| `ipc/checklist.rs` | 205 | register | 210 |
| `ipc/checklist_item.rs` + test | new | handler | 180 + 260 |
| `src/shared/ipc-checklist.ts`, bridge | 80, 15 | itemMessage | +30, +5 |
| renderer files | new | controls | each under 250 |

T001 measures the touched existing files; a file that would pass 600 lines splits first. Nothing goes into `scripts/file-size-baseline.json`.

## Test strategy

Every task names its co-located test file and test names. Guard tests are mutation-proven (remove the guard, watch it fail, restore). The live check (T022) runs on a scratch Tauri debug build isolated per `docs/rust-build.md`, CDP, real input, screenshots, fake omp.

## Risks

- **Transcript hook shape**: the `message_start` frame text must equal the sent text for the hash to match; T010 reads `transcript.rs` frame handling first and records the result.
- **Stale panel names**: #2012 may name files differently; T001 records the names and tasks T013-T018 use them.
- **Eviction after 500 sends**: accepted by the design; tested in T011.

## Complexity

No constitution violation. Two new Rust modules under `agent_tools` and `session/agent` and one under `checklist`; the alternative, growing `chat.rs` and `frame.rs`, risks the 600-line cap.
