# Transcript golden fixtures

Issue #795 (lane R12b), part 3: "the transcript golden tests ... the same frames must produce
the same `TranscriptItem` JSON in Rust and in the TypeScript." These files are the fixture half
of that proof. The original TS reader, `src/main/omp/transcript.golden.test.ts`, was deleted
during gate remediation (AGENTS.md's "no new tests while prototyping" rule, PR #834 review): the
sole reader of both fixture pairs below is now `src-tauri/tests/transcript_golden.rs`, one
`#[test]` function per pair. Each golden file is still produced by an actual run of the real TS
builders (never hand-typed) via a one-time throwaway generator script, deleted immediately after
use -- see "Regenerating" below.

`src-tauri/tests/transcript_terminated_unexpectedly_tests.rs` is a separate, fixture-free file:
it ports `src/main/omp/transcript.test.ts`'s own 4 named `it(...)` cases (that file's
`describe('fromHistory terminatedUnexpectedly gating', ...)` block) directly, using inline
`serde_json::json!` message literals instead of a scenario/golden pair, matching the TS test's
own style of building its messages inline in code. It is not covered by this README; see that
file's own header comment.

## Files

| Scenario | Consumed via | Fixture input | Golden output |
| --- | --- | --- | --- |
| History round trip | `fromHistory`/`TranscriptState::from_history` | `history-scenario.json` -- a plain `OmpMessage[]` history array (`src/shared/frames.ts`) | `history-golden.json` |
| Live frames round trip | `applyFrame`/`TranscriptState::apply_frame`, folded from empty, `hasUserActed: false` | `live-frames-scenario.json` -- a plain `Frame[]` array | `live-frames-golden.json` |

Only these 2 fixture pairs exist. A previous round of this lane's work added 7 more scenario
pairs (`thinking`, `isError`, `subagent`, `notice`, `hasUserActed`, `reset-on-removal`, `request`)
derived from reading `transcript.ts`'s own code paths rather than from any named test case --
removed during gate-round-2 remediation (HIGH #2) per Stuart's rule that golden/ported tests must
trace to a real named case, not be invented from reading the implementation.

## Provenance

`history-scenario.json`/`live-frames-scenario.json` reshape the real recorded traffic in
`scripts/fixtures/omp-frames/session.jsonl` (R12a, issue #795 part 2, see that directory's own
README for how `session.jsonl` was captured against a real signed-in `omp`) -- the same single
`write` tool call/result SHAPE that tape drives, every field name matching `src/shared/frames.ts`,
no other message/frame shape invented. The TEXT content differs from the tape on purpose: the
tape's own prompt is the sentinel `$lastMessage` (substituted at replay time, never a fixed
string) and its real reply is just the bare reply token `"xyzzy9"` -- neither makes a readable
fixture, so `history-scenario.json` uses its own representative prompt/reply text instead;
`live-frames-scenario.json`'s message deltas DO use the tape's own literal `"xy"` -> `"xyzzy9"`
streaming text, since that scenario is specifically about the streaming mechanism, not prompt
wording. (`history-scenario.json` previously also invented an extra `edit` tool call/result pair
not present in `session.jsonl`, to exercise `buildEditField`/`build_edit_field` -- removed during
gate-round-2 remediation for the same reason as the 7 scenarios above; the fixture is now
shaped after the single `write` call the real tape drives, nothing more.)

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
does not modify that file. The live-frame-derived golden file therefore stores `0` for
`startedAt`/`durationMs` as a fixed sentinel: `transcript_golden.rs`'s `normalize_timing` (and,
when it existed, `transcript.golden.test.ts`'s own `normalizeTiming`) walks the computed
`TranscriptItem[]`/`Value` tree and overwrites any `startedAt`/`durationMs` key's value with `0`,
leaving every other field exactly as built, before comparing against the golden file. This is the
only normalization applied anywhere in this fixture set; every other field (ids, text, tool
names, args, `write` payloads, status) is compared byte-for-byte as built.

## Regenerating

If either `*-scenario.json` file changes, regenerate its paired `*-golden.json` (do not hand-edit
golden files -- they must come from an actual run of the real builders):

1. Write a throwaway script under `src/main/omp/` (a `vitest`-runnable file, since `fromHistory`/
   `applyFrame` live behind this repo's `src/**` path aliases) that imports `fromHistory`/
   `applyFrame` from `./transcript`, reads the relevant `*-scenario.json` fixture from this
   directory, computes the item list the same way the deleted `transcript.golden.test.ts` did
   (`fromHistory(messages, new Set())`, or fold frames one at a time through
   `applyFrame(items, frame, hasUserActed)`), applies the `startedAt`/`durationMs` -> `0`
   normalization described above, and `JSON.stringify(normalized, null, 2) + '\n'`s the result to
   the paired `*-golden.json`. Name the file so it does NOT match `src/**/*.test.ts` (vitest's
   own `include` pattern, which `pnpm test`/CI run bare) -- e.g.
   `throwaway-regen-<scenario>-golden.ts` -- and run it via a throwaway `vitest.config.ts`
   override (`include: ['src/main/omp/<throwaway-file>']`) passed with `--config`, since bare
   `vitest run <path>` still filters through the repo's default `include` glob first.
2. Run it once: `npx vitest run --config <throwaway-config-path>`.
3. Delete both the throwaway script and the throwaway vitest config (plain delete by their
   literal paths) -- they are one-off generator artifacts, not kept tests. AGENTS.md's "no new
   tests" rule means no `src/main/omp/*.test.ts` file may survive this process.
4. Re-run `cd src-tauri && cargo test --test transcript_golden` (with `CARGO_TARGET_DIR`/
   `CARGO_INCREMENTAL` set per the repo's build rules) to confirm the Rust reader still agrees
   with the regenerated golden file.
