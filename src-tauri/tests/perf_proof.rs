// Issue #795 (lane R12b, part 5): performance proof for #776 (diff_transcript O(n) not O(n^2))
// and #778 (PatchCoalescer merges same-id upserts within a window, "last write wins"). Per the
// 2026-10-14 decision relayed to this lane, these are the ONLY two assertions that exist for
// this proof: a loose, generous timing sanity bound (never a tight number, never a cross-machine/
// cross-runtime comparison against the TS issue's own hand-measured figures) and a deterministic
// structural count. Neither this file nor anything else in this lane wires an absolute-timing or
// memory threshold into a pass/fail gate beyond the sanity bound below.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use refract_tauri_lib::omp::diff::{diff_transcript, PatchCoalescer, TranscriptOp};
use refract_tauri_lib::omp::transcript::TranscriptItem;

fn build_items(n: usize) -> Vec<Arc<TranscriptItem>> {
    (0..n)
        .map(|i| {
            Arc::new(TranscriptItem::User {
                id: format!("item-{i}"),
                text: format!("message number {i}"),
                at: i as i64,
            })
        })
        .collect()
}

/// Proves #776: `diff_transcript`'s cost for a single-item change is proportional to what
/// changed, not to the whole transcript -- an O(n^2) regression (e.g. reintroducing a
/// `Vec::iter().find()` scan per item) would blow well past the 50ms bound at N=3000 on any
/// machine, while the real O(n) id->item map implementation finishes in low single-digit
/// milliseconds even there. The printed `N -> elapsed` lines ARE the recorded evidence this test
/// exists to produce; run with `-- --nocapture` to see them.
#[test]
fn diff_transcript_is_linear_not_quadratic() {
    for n in [200usize, 1000, 3000] {
        let prev = build_items(n);
        let mut next = prev.clone();
        let changed_index = n / 2;
        next[changed_index] = Arc::new(TranscriptItem::User {
            id: format!("item-{changed_index}"),
            text: "changed by a single streaming update".to_string(),
            at: changed_index as i64,
        });

        let start = Instant::now();
        let ops = diff_transcript(&prev, &next);
        let elapsed = start.elapsed();
        println!("diff_transcript_is_linear_not_quadratic: N={n} -> {elapsed:?}");

        assert_eq!(
            ops.len(),
            1,
            "exactly one item changed at N={n}, expected exactly one TranscriptOp"
        );
        assert!(
            matches!(&ops[0], TranscriptOp::Upsert { item } if item.id() == format!("item-{changed_index}")),
            "the single op at N={n} must be an Upsert for the one item that actually changed"
        );
        // Loose, non-flaky sanity bound (never a tight number, never compared against the TS
        // issue's own hand-measured figures on a different machine/runtime): generous enough to
        // never flake on a slow CI runner, but still catches a genuine O(n^2) regression.
        assert!(
            elapsed.as_millis() < 50,
            "diff_transcript at N={n} took {elapsed:?}, exceeding the loose 50ms sanity bound -- possible O(n^2) regression (issue #776)"
        );
    }
}

/// Proves #778 structurally (no timing involved, since this property does not need one): driving
/// a `PatchCoalescer` through 20 frames that only ever touch 3 distinct ids within one window
/// must flush exactly 3 upserts -- one per id, last write wins -- never 20 (one per frame, the
/// pre-#778 behaviour). `flush_now` (not the debounce timer) drives the assertion directly, with
/// a window generous enough that the timer can never fire mid-test and race the assertion.
#[tokio::test]
async fn patch_coalescer_sends_one_upsert_per_id_not_per_frame() {
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
    assert_eq!(
        ops.len(),
        3,
        "expected exactly one upsert per distinct id (last write wins, issue #778), got {} ops",
        ops.len()
    );
    let mut ids_seen: Vec<&str> = ops
        .iter()
        .map(|op| match op {
            TranscriptOp::Upsert { item } => item.id(),
            TranscriptOp::Reset { .. } => {
                panic!("unexpected Reset op: only Upserts were ever queued")
            }
        })
        .collect();
    ids_seen.sort_unstable();
    assert_eq!(ids_seen, vec!["a", "b", "c"]);

    // Last-write-wins: the flushed text for each id must be its LAST queued frame, not an
    // earlier one -- proves the merge actually overwrites rather than just deduplicating by id.
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
                "id {id} must carry its LAST queued frame's text"
            );
        }
    }
}
