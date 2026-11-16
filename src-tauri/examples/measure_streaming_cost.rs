// `cargo run --example measure_streaming_cost --release` (issue #795, lane R12b part 5, scope
// change 2026-10-14 relayed by the lane's parent): standalone print-the-numbers tool for #776
// (diff_transcript O(n) not O(n^2)) and #778 (PatchCoalescer merges same-id upserts within a
// window, "last write wins"). Lives under `examples/`, which plain `cargo test`/CI never
// discovers or runs (Cargo's own convention -- `examples/` binaries only run via `cargo run
// --example <name>`, same reasoning `scripts/measure-footprint.mjs` already documents for why
// footprint numbers are informational, not gated) -- this used to be a `#[test]` fn in
// `src-tauri/tests/perf_proof.rs` (deleted) with a single absolute-timing bound asserted as a
// pass/fail gate; moved here specifically so NOTHING in this repo asserts an absolute-timing or
// growth-ratio threshold as a CI pass/fail criterion. Numbers below are printed for a human to
// read, never asserted.
//
// Measurement method, unchanged from the deleted test: the minimum of several warmed timing
// samples (one throwaway run discarded first, so branch predictor/allocator state has settled)
// at N=3000 divided by the same at N=300 is printed as a growth ratio -- linear growth produces
// something close to 10x (the input-size ratio), quadratic growth produces something close to
// 100x. Run with the `--release` profile (Cargo's default `cargo run --example` is debug; this
// tool is explicitly invoked `--release` so the numbers reflect the optimised build everything
// else in this PR's footprint comparison also uses) for the most representative timings.
//
// The two structural `assert!`s below (exactly one Upsert op per N; `PatchCoalescer` flushing
// exactly one upsert per distinct id) guard this TOOL's own correctness -- a broken measurement
// would otherwise silently benchmark the wrong thing -- they are not a timing/performance
// assertion and would fire (panicking this standalone binary, never affecting `cargo test`/CI)
// only if `diff_transcript`/`PatchCoalescer` themselves regressed structurally, independent of
// how fast or slow they ran.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use refract_tauri_lib::omp::diff::{diff_transcript, PatchCoalescer, TranscriptOp};
use refract_tauri_lib::omp::transcript::TranscriptItem;

const SMALL_N: usize = 300;
const LARGE_N: usize = 3000;
const WARMUP_RUNS: usize = 1;
const TIMED_RUNS: usize = 5;

fn build_items(n: usize) -> Vec<Arc<TranscriptItem>> {
    (0..n)
        .map(|i| {
            Arc::new(TranscriptItem::User {
                id: format!("item-{i}"),
                text: format!("message number {i}"),
                at: i as i64,
                file_attachments: Vec::new(),
                images: Vec::new(),
                source: None,
            })
        })
        .collect()
}

/// Runs `diff_transcript(prev, next)` `WARMUP_RUNS` discarded times then `TIMED_RUNS` timed
/// times, returning the MINIMUM elapsed duration and the ops from the last timed run (the diff
/// is pure/deterministic, so any timed run's ops are representative).
fn min_of_warmed_runs(
    prev: &[Arc<TranscriptItem>],
    next: &[Arc<TranscriptItem>],
) -> (Duration, Vec<TranscriptOp>) {
    for _ in 0..WARMUP_RUNS {
        let _ = diff_transcript(prev, next);
    }
    let mut min_elapsed: Option<Duration> = None;
    let mut last_ops = None;
    for _ in 0..TIMED_RUNS {
        let start = Instant::now();
        let ops = diff_transcript(prev, next);
        let elapsed = start.elapsed();
        min_elapsed = Some(min_elapsed.map_or(elapsed, |m| m.min(elapsed)));
        last_ops = Some(ops);
    }
    (min_elapsed.unwrap(), last_ops.unwrap())
}

/// #776: prints `diff_transcript`'s minimum-of-`TIMED_RUNS`-warmed-runs elapsed time at
/// `SMALL_N`/`LARGE_N` and the growth ratio between them. Never asserts a threshold -- this is
/// the whole point of moving it out of `cargo test`.
fn measure_diff_transcript() {
    println!("=== #776: diff_transcript growth (minimum of {TIMED_RUNS} warmed runs each, {WARMUP_RUNS} discarded warmup run) ===");
    let mut min_elapsed_by_n: HashMap<usize, Duration> = HashMap::new();

    for n in [SMALL_N, LARGE_N] {
        let prev = build_items(n);
        let mut next = prev.clone();
        let changed_index = n / 2;
        next[changed_index] = Arc::new(TranscriptItem::User {
            id: format!("item-{changed_index}"),
            text: "changed by a single streaming update".to_string(),
            at: changed_index as i64,
            file_attachments: Vec::new(),
            images: Vec::new(),
            source: None,
        });

        let (elapsed, ops) = min_of_warmed_runs(&prev, &next);
        println!("  N={n} -> {elapsed:?}");

        // Guards this tool's own correctness, not a timing assertion -- see module doc comment.
        assert_eq!(
            ops.len(),
            1,
            "measure_streaming_cost: exactly one item changed at N={n}, expected exactly one TranscriptOp -- benchmark is measuring something broken"
        );
        assert!(
            matches!(&ops[0], TranscriptOp::Upsert { item } if item.id() == format!("item-{changed_index}")),
            "measure_streaming_cost: the single op at N={n} must be an Upsert for the one item that actually changed -- benchmark is measuring something broken"
        );

        min_elapsed_by_n.insert(n, elapsed);
    }

    let small = min_elapsed_by_n[&SMALL_N];
    let large = min_elapsed_by_n[&LARGE_N];
    let small_secs = small.as_secs_f64().max(1e-9);
    let large_secs = large.as_secs_f64().max(1e-9);
    let growth_ratio = large_secs / small_secs;
    let expected_linear = (LARGE_N as f64) / (SMALL_N as f64);
    let expected_quadratic = expected_linear.powi(2);
    println!(
        "  growth ratio N={LARGE_N}/N={SMALL_N} = {growth_ratio:.2}x (linear would be ~{expected_linear:.0}x, quadratic ~{expected_quadratic:.0}x) -- no threshold asserted, read it yourself"
    );
}

/// #778: prints the structural proof that `PatchCoalescer` flushes exactly one upsert per
/// distinct id across 20 queued frames touching only 3 ids, each carrying its last-write-wins
/// text -- no timing involved, since this property never needed one.
async fn measure_patch_coalescer() {
    println!("=== #778: PatchCoalescer last-write-wins structural proof (no timing) ===");
    let flushed: Arc<Mutex<Vec<TranscriptOp>>> = Arc::new(Mutex::new(Vec::new()));
    let flushed_for_closure = flushed.clone();
    let coalescer = PatchCoalescer::new(
        Duration::from_secs(60),
        Box::new(move |ops: Vec<TranscriptOp>| {
            flushed_for_closure
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .extend(ops);
        }),
    );

    let ids = ["a", "b", "c"];
    for frame in 0..20usize {
        let id = ids[frame % ids.len()];
        coalescer.queue(vec![TranscriptOp::Upsert {
            item: Box::new(TranscriptItem::AssistantText {
                id: id.to_string(),
                text: format!("frame {frame}"),
                streaming: true,
            }),
        }]);
    }
    coalescer.flush_now();

    let ops = flushed.lock().unwrap_or_else(|p| p.into_inner());
    println!(
        "  20 queued frames across 3 distinct ids flushed {} op(s) (expected 3)",
        ops.len()
    );
    assert_eq!(
        ops.len(),
        3,
        "measure_streaming_cost: expected exactly one upsert per distinct id (last write wins, issue #778), got {} ops -- benchmark is measuring something broken",
        ops.len()
    );
    let mut ids_seen: Vec<&str> = ops
        .iter()
        .map(|op| match op {
            TranscriptOp::Upsert { item } => item.id(),
            TranscriptOp::Reset { .. } => {
                panic!("measure_streaming_cost: unexpected Reset op: only Upserts were ever queued")
            }
        })
        .collect();
    ids_seen.sort_unstable();
    assert_eq!(ids_seen, vec!["a", "b", "c"]);

    for op in ops.iter() {
        let TranscriptOp::Upsert { item } = op else {
            unreachable!()
        };
        if let TranscriptItem::AssistantText { id, text, .. } = item.as_ref() {
            let last_frame_for_id = (0..20usize)
                .rev()
                .find(|f| ids[f % ids.len()] == id)
                .unwrap();
            assert_eq!(
                text,
                &format!("frame {last_frame_for_id}"),
                "measure_streaming_cost: id {id} must carry its LAST queued frame's text"
            );
            println!("  id={id} -> {text:?} (last-write-wins confirmed)");
        }
    }
}

#[tokio::main]
async fn main() {
    measure_diff_transcript();
    measure_patch_coalescer().await;
}
