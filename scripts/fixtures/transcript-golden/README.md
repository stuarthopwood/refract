# Transcript golden fixtures

Issue #795 (lane R12b), part 3: "the transcript golden tests ... the same frames must produce
the same `TranscriptItem` JSON in Rust and in the TypeScript." These files are the fixture half
of that proof. The original TS reader, `src/main/omp/transcript.golden.test.ts`, was deleted
during gate remediation (AGENTS.md's "no new tests while prototyping" rule, PR #834 review): the
sole reader of every fixture pair below is now `src-tauri/tests/transcript_golden.rs`, one
`#[test]` function per pair. Each golden file is still produced by an actual run of the real TS
builders (never hand-typed) via a one-time throwaway generator script, deleted immediately after
use -- see "Regenerating" below.

## Files

| Scenario | Consumed via | Fixture input | Golden output |
| --- | --- | --- | --- |
| History round trip | `fromHistory`/`TranscriptState::from_history` | `history-scenario.json` -- a plain `OmpMessage[]` history array (`src/shared/frames.ts`) | `history-golden.json` |
| Live frames round trip | `applyFrame`/`TranscriptState::apply_frame`, folded from empty, `hasUserActed: false` | `live-frames-scenario.json` -- a plain `Frame[]` array | `live-frames-golden.json` |
| `thinking` | `fromHistory` | `thinking-scenario.json` | `thinking-golden.json` |
| `isError` | `fromHistory` | `isError-scenario.json` | `isError-golden.json` |
| `subagent` | `applyFrame`, `hasUserActed: false` | `subagent-scenario.json` | `subagent-golden.json` |
| `notice` | `applyFrame`, `hasUserActed: false` | `notice-scenario.json` | `notice-golden.json` |
| `hasUserActed: true` | `applyFrame`, `hasUserActed: true` | `hasUserActed-scenario.json` | `hasUserActed-golden.json` |
| `reset-on-removal` | `applyFrame` folded over two frames, `hasUserActed: false` | `reset-on-removal-scenario.json` | `reset-on-removal-golden.json` |
| `request` | `TranscriptState::upsert_item` (NOT `fromHistory`/`applyFrame` -- see below) | `request-scenario.json` | `request-golden.json` |

## Provenance

`history-scenario.json`/`live-frames-scenario.json` are reshaped from real recorded traffic in
`scripts/fixtures/omp-frames/session.jsonl` (R12a, issue #795 part 2, see that directory's own
README for how `session.jsonl` was captured against a real signed-in `omp`): the same `write`
tool call/result pair and the same streaming `"xy"` -> `"xyzzy9"` assistant reply that tape
records. `history-scenario.json` additionally invents one `edit` tool call/result pair (not
present in `session.jsonl`) so the history fixture also exercises `buildEditField`/
`build_edit_field`, since R12a's own tape only ever drives a `write` call. No other message/frame
shapes were invented; every field name matches `src/shared/frames.ts`.

The seven new scenarios below are each derived from one specific, real code path in
`src/main/omp/transcript.ts` (read directly, not guessed), reusing the same `write`-call wire
shapes where relevant:

- **`thinking-scenario.json`**: an assistant history message with a `{ type: 'thinking' }`
  content part followed by a `{ type: 'text' }` part, exercising `buildAssistantItems`'s
  `part.type === 'thinking'` branch. Via `fromHistory`, `captureTiming` is always `false`, so the
  golden `thinking` item carries no `startedAt`/`endedAt` (T075/FR-009).
- **`isError-scenario.json`**: the real tape's `write` toolCall, but with a `toolResult` whose
  `isError: true` (the tape's own call never fails), exercising `attachToolResult`'s `isError`
  branch -- the resulting `tool` item settles to `status: 'error'`.
- **`subagent-scenario.json`**: a `tool_execution_start` frame for a `task` toolCall carrying one
  `args.tasks[]` entry, exercising `applyToolExecutionStart`'s `upsertSubagentItems` call
  (FINDINGS item 22(e)). The resulting `subagent` item is live-built, so its `startedAt` is
  normalized (see below).
- **`notice-scenario.json`**: a `notice` frame applied with `hasUserActed: false`, exercising
  `applyFrame`'s `'notice'` case in the window before the user has acted -- the id gets
  `STARTUP_NOTICE_PREFIX` (`src/shared/model.ts`).
- **`hasUserActed-scenario.json`**: a `command_output` frame (a different real frame shape, for
  extra coverage) applied with `hasUserActed: true` -- same notice-building branch, but the id is
  the plain `notice-<n>` form instead. `hasUserActed` is an `applyFrame` parameter; `fromHistory`
  has no equivalent parameter (double-checked against both function signatures).
- **`reset-on-removal-scenario.json`**: `message_start` for `msg-r1` with content
  `[thinking, text]`, then `message_end` for the SAME `msg-r1` with content `[text]` only (the
  model's final snapshot drops the thinking part entirely). Exercises `replaceMessageItems`:
  every existing item for `msg-r1` (both the old `thinking` and the old partial `text`) is
  removed, not merged, and replaced wholesale by the new one-item build.
- **`request-scenario.json`**: `kind: 'request'` items are never built by `fromHistory`/
  `applyFrame` at all -- confirmed by reading both functions end to end, neither has a branch
  producing this kind. They are built directly by `SessionAgent.ts`'s own private
  `upsertTranscriptItem` (`request:<requestId>`, first with no `resolved`, later the same id
  re-upserted with `resolved` set), ported on the Rust side as `TranscriptState::upsert_item`.
  This fixture is therefore a plain `TranscriptItem[]` sequence (not an `OmpMessage[]`/`Frame[]`)
  fed through `upsert_item` one at a time, replicating `upsertTranscriptItem`'s exact 3-line
  replace-by-id-or-append logic (read verbatim from `SessionAgent.ts`, not reinvented).

## Fixed: `details` null-vs-absent divergence (PR #834 gate-round-1 HIGH #3)

`history-scenario.json`'s and `live-frames-scenario.json`'s `write` tool result/end frame
previously set an explicit `"details": null` by hand rather than omitting the `details` key
entirely (the real `session.jsonl` tape omits it for this exact call) -- the golden test could
therefore never observe the real Rust/TS divergence it was built to catch. Root cause, found in
`transcript.rs`'s `attach_tool_result`/`apply_tool_execution_end`: both read a possibly-absent
`details`/`result.details` key via `.get("details").cloned().unwrap_or(Value::Null)` and then
unconditionally stored it as `Some(details)` on the built/updated `TranscriptItem::Tool`, so an
absent source key serialized as a present `"details": null` -- whereas `transcript.ts`'s
`attachToolResult`/`applyToolExecutionEnd` simply assign `details: message.details` (`undefined`
when the key is absent), which `JSON.stringify` drops entirely. Fixed (2026-10-14) by keeping the
raw `Option<Value>` (`message.get("details").cloned()`, no `unwrap_or`) all the way into the
stored field instead of collapsing "absent" and "present-and-null" to the same `Value::Null`
before wrapping. The two fixtures now omit the `details` key on that `write` result/end frame
entirely, matching `session.jsonl`'s real wire shape, and `history-golden.json`/
`live-frames-golden.json` were regenerated accordingly (that `tool` item's golden JSON no longer
has a `details` key at all).

## Wall-clock fields are normalized, not golden

`fromHistory`/`from_history` never call `Date.now()`/`SystemTime::now()` (`captureTiming`/
`capture_timing` is always `false` for history), so every history-derived golden file is fully
deterministic as produced. `applyFrame`/`apply_frame`, by contrast, always stamps a live `tool`/
`subagent` item's `startedAt`/`started_at` (and, once resolved, `durationMs`/`duration_ms`) from
the real wall clock -- there is no mockable clock seam in `transcript.rs`, and this fixture set
does not modify that file. Every live-frame-derived golden file therefore stores `0` for
`startedAt`/`durationMs` as a fixed sentinel: `transcript_golden.rs`'s `normalize_timing` (and,
when it existed, `transcript.golden.test.ts`'s own `normalizeTiming`) walks the computed
`TranscriptItem[]`/`Value` tree and overwrites any `startedAt`/`durationMs` key's value with `0`,
leaving every other field exactly as built, before comparing against the golden file. This is the
only normalization applied anywhere in this fixture set; every other field (ids, text, tool
names, args, `write`/`edit` payloads, status) is compared byte-for-byte as built.

## Regenerating

If any `*-scenario.json` file changes, regenerate its paired `*-golden.json` (do not hand-edit
golden files -- they must come from an actual run of the real builders):

1. Write a throwaway script under `src/main/omp/` (a `vitest`-runnable file, since `fromHistory`/
   `applyFrame` live behind this repo's `src/**` path aliases) that imports `fromHistory`/
   `applyFrame` from `./transcript`, reads the relevant `*-scenario.json` fixture(s) from this
   directory, computes the item list the same way the deleted `transcript.golden.test.ts` did
   (`fromHistory(messages, new Set())`, or fold frames one at a time through
   `applyFrame(items, frame, hasUserActed)`), applies the `startedAt`/`durationMs` -> `0`
   normalization described above, and `JSON.stringify(normalized, null, 2) + '\n'`s the result to
   the paired `*-golden.json`. For `request-scenario.json` specifically, there is no
   `fromHistory`/`applyFrame` call at all -- replicate `SessionAgent.ts`'s private
   `upsertTranscriptItem` (read it fresh; it is a 3-line replace-by-id-or-append) and fold the
   fixture's `TranscriptItem[]` through that instead.
2. Run it once: `pnpm vitest run src/main/omp/<throwaway-file>`.
3. Delete the throwaway file (`git rm` if tracked, otherwise a plain delete by its literal path)
   -- it is a one-off generator, not a kept test. AGENTS.md's "no new tests" rule means no
   `src/main/omp/*.test.ts` file may survive this process.
4. Re-run `cd src-tauri && cargo test --test transcript_golden` (with `CARGO_TARGET_DIR`/
   `CARGO_INCREMENTAL` set per the repo's build rules) to confirm the Rust reader still agrees
   with every regenerated golden file.
