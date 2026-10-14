# Transcript golden fixtures

Issue #795 (lane R12b), part 3: "the transcript golden tests ... the same frames must produce
the same `TranscriptItem` JSON in Rust and in the TypeScript." These four files are the fixture
half of that proof; the two readers are `src/main/omp/transcript.golden.test.ts` (TS) and
`src-tauri/tests/transcript_golden.rs` (Rust).

## Files

| File | What it is |
| --- | --- |
| `history-scenario.json` | A plain `OmpMessage[]` history array (the shape `get_messages`/`message_start`/`message_end` carry, `src/shared/frames.ts`), fed to `fromHistory`/`TranscriptState::from_history`. |
| `live-frames-scenario.json` | A plain `Frame[]` array (`src/shared/frames.ts`), replayed one at a time through `applyFrame`/`TranscriptState::apply_frame` starting from an empty transcript. |
| `history-golden.json` | The exact `TranscriptItem[]` JSON `fromHistory(history-scenario messages, new Set())` produces. |
| `live-frames-golden.json` | The exact `TranscriptItem[]` JSON produced by folding `live-frames-scenario.json` through `applyFrame` in order (`hasUserActed: false` throughout, matching `TranscriptState`'s own default). |

## Provenance

Both scenarios are reshaped from real recorded traffic in
`scripts/fixtures/omp-frames/session.jsonl` (R12a, issue #795 part 2, see that directory's own
README for how `session.jsonl` was captured against a real signed-in `omp`): the same `write`
tool call/result pair and the same streaming `"xy"` -> `"xyzzy9"` assistant reply that tape
records. `history-scenario.json` additionally invents one `edit` tool call/result pair (not
present in `session.jsonl`) so the history fixture also exercises `buildEditField`/
`build_edit_field`, since R12a's own tape only ever drives a `write` call. No other message/frame
shapes were invented; every field name matches `src/shared/frames.ts`.

## Known Rust/TS divergence this fixture set deliberately avoids

`history-scenario.json`'s and `live-frames-scenario.json`'s `write` tool result/end frame both
set an explicit `"details": null` rather than omitting the `details` key entirely (the real
`session.jsonl` tape omits it for this exact call). This is required, not cosmetic: when the
source JSON key is missing outright, `transcript.ts`'s `attachToolResult`/`applyToolExecutionEnd`
read `message.details`/`frame.result.details` as `undefined`, which `JSON.stringify` drops from
the output entirely -- but `transcript.rs`'s `attach_tool_result`/`apply_tool_execution_end` read
a missing key via `.unwrap_or(Value::Null)` and then unconditionally wrap it `Some(details)`,
which serializes as a present `"details": null` instead of an omitted key. Found while building
this golden test (2026-10-14); not fixed here, since this fixture set edits no existing file.
Setting the key explicitly to `null` in the fixture sidesteps the divergence (both sides then
agree the field is present and `null`) without touching `transcript.rs`. Flag to whoever owns
`transcript.rs`/`transcript.ts` next: either make the Rust side skip `details` when the source
key was truly absent (mirroring the TS `undefined`-drops-the-key behavior), or decide the two are
allowed to diverge on this one case and drop this note.

## Wall-clock fields are normalized, not golden

`fromHistory`/`from_history` never call `Date.now()`/`SystemTime::now()` (`captureTiming`/
`capture_timing` is always `false` for history), so `history-golden.json` is fully deterministic
as produced. `applyFrame`/`apply_frame`, by contrast, always stamps a live `tool` item's
`startedAt`/`started_at` (and, once resolved, `durationMs`/`duration_ms`) from the real wall
clock -- there is no mockable clock seam in `transcript.rs`, and this fixture set does not modify
that file. `live-frames-golden.json` therefore stores `0` for `startedAt`/`durationMs` as a fixed
sentinel: both `transcript.golden.test.ts` and `transcript_golden.rs` apply the identical
normalization (walk the computed `TranscriptItem[]`/`Value` tree, overwrite any `startedAt`/
`durationMs` key's value with `0`, leave every other field exactly as built) to their own
freshly-computed output before comparing it against this golden file. This is the only
normalization applied anywhere in this fixture set; every other field (ids, text, tool names,
args, `write`/`edit` payloads, status) is compared byte-for-byte as built.

## Regenerating

If `history-scenario.json` or `live-frames-scenario.json` ever change, regenerate both golden
files by hand (do not hand-edit them separately -- they must come from an actual run of the real
builders):

1. Re-create a throwaway vitest file under `src/main/omp/` that imports `fromHistory`/
   `applyFrame` from `./transcript`, reads the two `*-scenario.json` fixtures from this
   directory, computes the two item lists the same way `transcript.golden.test.ts` does
   (`fromHistory(messages, new Set())`; fold `live-frames-scenario.json` through
   `applyFrame(items, frame, false)` one frame at a time), applies the `startedAt`/`durationMs`
   -> `0` normalization described above, and `JSON.stringify(normalized, null, 2) + '\n'`s the
   result to `history-golden.json`/`live-frames-golden.json`.
2. Run it once: `pnpm vitest run src/main/omp/<throwaway-file>`.
3. Delete the throwaway file -- it is a one-off generator, not a kept test.
4. Re-run `pnpm vitest run src/main/omp/transcript.golden.test.ts` and
   `cargo test --test transcript_golden` (from `src-tauri/`, with `CARGO_TARGET_DIR`/
   `CARGO_INCREMENTAL` set per the repo's build rules) to confirm both readers still agree with
   the regenerated golden files.
