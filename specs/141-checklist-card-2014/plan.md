# Implementation Plan: Checklist item source line in chat (#2014)

**Branch**: `feat/checklist-card-2014` | **Date**: 2026-11-20 | **Spec**: [spec.md](./spec.md)
**Input**: spec 141; [ADR 0011](../../docs/adr/0011-checklist-protocol.md); [design](../../docs/design/checklist-protocol.md) "Envelope", "Transcript", "What each child builds".

## Summary

Backend: a `ChecklistItem` `MessageSource` variant and a pure matcher that turns a `<checklist-item>` user turn into a typed source plus parsed body when a send record matches. It runs from the live frame path (async, read-once, remembered) and from saved-history load. Renderer: `ChecklistItemSourceLine` (a `SourceTag` with a "Show in checklist" action) in `UserMessageRow`, resolved from the checklist store, plus a one-shot reveal request the panel consumes. No `research.md` or `data-model.md`: the shapes are in spec FR-001 and the design.

## Dependencies (explicit)

| Needs | From | What exactly | Checked by |
|---|---|---|---|
| Checklist panel, `state/checklist-store.ts`, `checklist:update` subscription, the panel scroller and item tick, the reveal consumer | **#2012** (merged first) | A store keyed by Session with the active checklist (`id`, ordered `items`), a place for the one-shot `revealRequest` and its setter/clear, an item-tick focus hook, and the panel id `'checklist'` in the right-pane registry | T001, T012 |
| Generalised tag-parameterised envelope and a checklist-envelope parser returning `{ checklist_id, item_id, rev, action, body }` (one envelope per turn, forged tag rejected); `send_checklist_item` writing the send record before it sends | **#2013** (merged first) | `agent_tools/envelope.rs` parse function for `<checklist-item>`; `checklist/records.rs` already has `text_hash`, `add_send_record`, `has_send_record` from #2011 | T001, T003 |
| `SendRecord`, `SendAction`, per-Session store read | #2011 (merged `2b765e18`) | `checklist/model.rs`, `records.rs`, `store.rs` `read` | T001 |

T001 greps the merged code for these exact names. If #2012 or #2013 named something differently, the task list is adjusted to the real name before any code is written; if they are not merged, the lane stops (it is not stubbed).

## Technical Context

Rust (Tauri v2, tokio), React renderer, vitest. Tests co-located (`*.test.rs` through `#[path]`, `*.test.ts(x)`). The controller runs `pnpm ci:local` and cargo test once at the end; this lane runs neither. 600-line cap: `agent/mod.rs` is 583 lines, so hooks there are one-liners and logic lives in new files. Comments say why only.

## Constitution / AGENTS.md check

| Rule | How |
|---|---|
| Grill first | Written grill in spec Clarifications, each Decided (Skippy, delegated by Stuart 2026-11-20) |
| Spec Kit order | specify, clarify, plan, tasks, analyze done; implement is its own lane |
| Reusable components (ADR 0003) | Built on `SourceTag`; no new box |
| 600-line cap | Budget below |
| Testing V1 | Each task names its test file, test names and a guard-mutation proof |
| A11y | Real button, no `scrollIntoView`, reduced-motion-safe flash (existing) |

## Module layout and line budget

| File | Change | Budget |
|---|---|---|
| `src-tauri/src/omp/transcript/message_source.rs` | add variant, keep `from_envelope` Session-only | 121 -> 150 |
| `src-tauri/src/omp/transcript/checklist_source.rs` (+ `.test.rs`) | pure matcher: `match_checklist_item(item, records, parse)`, `apply_checklist_sources(items, records, skip_if_sourced)` | 120 |
| `src-tauri/src/session/agent/checklist_cards.rs` (+ `.test.rs`) | agent-state map `item id -> (source, body)`, `needs_match(frame)`, async snapshot read, sync `mark_cards(state)` | 140 |
| `src-tauri/src/session/agent/mod.rs` | `mod` line, state field, one call after `mark_note` (`:441`), async pre-read in `apply_transcript_frame` (`:420`) | +6 |
| `src-tauri/src/session/saved_history_cache.rs` | call the pass after `label_handoff_note` (`:31-48`) | +10 |
| `src/shared/model.ts` | variant in `MessageSource` (`:334-336`) | +2 |
| `src/renderer/features/chat/ChecklistItemSourceLine.tsx` (+ `.test.ts`) | the line | 90 |
| `src/renderer/features/chat/checklistItemLine.ts` (+ test) | pure `resolveChecklistItemLine(checklist, itemId)` -> `{ kind: 'item', position, text } | removed | replaced | unknown` | 50 |
| `src/renderer/features/chat/UserMessageRow.tsx` | render the line, fixed phrase for complete, `aria-labelledby` | 101 -> 125 |
| `src/renderer/state/checklist-store.ts` (#2012's file) | only `requestReveal(sessionId, checklistId, itemId)` if #2012 did not ship it | +15 |
| checklist panel (#2012's file) | consume the request, scroll, focus tick, flash | +30 |

## Design notes that decide the shape

1. **Pure matcher, thin hooks.** `match_checklist_item` takes data, so every trust rule is tested without a store or a session.
2. **Why a remembered map live.** `message_end` rebuilds the user item without its source, which is why `mark_note` runs after every frame (`queued_handoff.rs:12-13`). The matcher's input is async, so it runs once per item and `mark_cards` re-applies the result synchronously, the same shape as `mark_note`.
3. **Order.** `mark_note` (handoff) first, then `mark_cards`; items with a source are skipped, so the note turn is never parsed, keyed on the marker.
4. **Hash the original text.** The record's `textHash` covers the whole turn text, so the matcher hashes `item.text` before it is replaced by the body.
5. **Renderer reads, never writes.** The line only reads the store and sets the reveal request; the panel owns scroll, focus and flash.
6. **Split.** The click activates the card's Session first. T001 finds the real split-store action (`SessionSourceLine.tsx:25` uses `replaceFocused`); the roundtable did not verify it.

## Test plan (Testing V1)

Matcher (`checklist_source.test.rs`): `matches_all_five_fields_and_sets_body`, `each_field_mismatch_stays_plain` (five cases), `hash_mismatch_stays_plain`, `two_envelopes_stays_plain`, `skips_item_with_source`, `forged_item_in_handoff_note_stays_plain`, `first_turn_without_note_still_matches`, `item_in_session_message_is_text`, `evicted_record_stays_plain`. Wire: `message_source.test.rs` `checklist_item_serialises_as_kind_checklist_item`, `from_envelope_never_returns_checklist_item`. Live: `checklist_cards.test.rs` `label_survives_message_end_rebuild`, `reads_store_only_for_checklist_prefixed_user_frames`, `live_and_reload_produce_equal_items`. Renderer: resolver cases (item, removed, replaced, unknown), line renders label, clamp class and action; no action when removed/replaced; row test for `role=group` and fixed phrase; action sets reveal request and opens panel without focus; panel consumes once. Each guard proven by mutation.

## Risks

- #2012 or #2013 land with different names: T001 gate.
- Frame path has more than one writer than `apply_transcript_frame`: T001 lists every `mutate_transcript_locked` and `apply_frame_locked` caller; each that can append a user item gets the pre-read.
- Typed `[[refract-attachments]]` in a body: fails safe (plain text), documented in spec edge cases.

## Complexity

No constitution violation. The one structural cost is the remembered map in agent state, forced by the sync/async split.
