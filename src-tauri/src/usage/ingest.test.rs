// Runs against scratch files under the OS temp folder, left in place like the other test modules.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::json;

use super::*;
use crate::usage::schema;

fn scratch(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "refract-usage-{label}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(dir.join("sessions").join("folder")).unwrap();
    dir
}

fn append(path: &Path, text: &str) {
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    f.write_all(text.as_bytes()).unwrap();
}

fn line(value: serde_json::Value) -> String {
    format!("{value}\n")
}

fn header() -> String {
    line(
        json!({"type":"session","id":"s1","timestamp":"2026-10-01T10:00:00.000Z","cwd":"C:\\Work\\proj\\src"}),
    ) + &line(
        json!({"type":"model_change","id":"m1","timestamp":"2026-10-01T10:00:01.000Z","model":"github-copilot/claude-sonnet"}),
    ) + &line(
        json!({"type":"thinking_level_change","id":"t1","timestamp":"2026-10-01T10:00:02.000Z","thinkingLevel":"high"}),
    )
}

fn assistant(id: &str, ts: i64, cost: f64, extra: Vec<serde_json::Value>) -> String {
    let mut content = vec![json!({"type":"text","text":"ok"})];
    content.extend(extra);
    line(
        json!({"type":"message","id":id,"timestamp":"2026-10-01T10:00:03.000Z","message":{
        "role":"assistant","content":content,"timestamp":ts,
        "usage":{"input":10,"output":5,"cacheRead":100,"cacheWrite":0,"totalTokens":115,
                 "cost":{"input":0.01,"output":0.02,"cacheRead":0.0,"cacheWrite":0.0,"total":cost}}}}),
    )
}

struct Fixture {
    root: PathBuf,
    file: PathBuf,
    conn: rusqlite::Connection,
    projects: ProjectIndex,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let dir = scratch(label);
        let root = dir.join("sessions");
        Self {
            file: root.join("folder").join("a.jsonl"),
            conn: schema::open_db(&dir.join("usage.db")).unwrap(),
            projects: ProjectIndex::from_pairs([("C:\\Work\\proj", "proj")]),
            root,
        }
    }

    fn ingest(&mut self) -> IngestOutcome {
        ingest_file(
            &mut self.conn,
            &self.file,
            "main",
            &self.root,
            &self.projects,
        )
        .unwrap()
    }

    fn count(&self, table: &str) -> i64 {
        self.conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }
}

#[test]
fn resume_after_append_and_dedupe_on_reread() {
    let mut fx = Fixture::new("resume");
    append(&fx.file, &header());
    append(&fx.file, &assistant("a1", 1_790_000_000_000, 0.5, vec![]));
    assert_eq!(fx.ingest().new_messages, 1);

    // Nothing new: a second pass adds nothing, and the rollup still counts one call.
    assert_eq!(fx.ingest().new_messages, 0);
    let calls: i64 = fx
        .conn
        .query_row("SELECT sum(calls) FROM message_rollup", [], |r| r.get(0))
        .unwrap();
    assert_eq!(calls, 1);

    // Resume from the stored offset: only the appended message is read.
    append(&fx.file, &assistant("a2", 1_790_000_100_000, 0.25, vec![]));
    assert_eq!(fx.ingest().new_messages, 1);
    assert_eq!(fx.count("messages"), 2);

    // Forcing a full re-read (offset reset) still dedupes on (file, entry id).
    fx.conn
        .execute("UPDATE file_offsets SET offset = 0", [])
        .unwrap();
    assert_eq!(fx.ingest().new_messages, 0);
    assert_eq!(fx.count("messages"), 2);
}

#[test]
fn model_change_replay_credits_and_project_label() {
    let mut fx = Fixture::new("replay");
    append(&fx.file, &header());
    append(&fx.file, &assistant("a1", 1_790_000_000_000, 0.5, vec![]));
    fx.ingest();
    let (provider, model, reasoning, label, credits): (
        String,
        String,
        String,
        String,
        Option<f64>,
    ) = fx
        .conn
        .query_row(
            "SELECT provider, model, reasoning, project_label, credits FROM messages",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .unwrap();
    // The message carries no provider or model: both come from the replayed `model_change`.
    assert_eq!(
        (
            provider.as_str(),
            model.as_str(),
            reasoning.as_str(),
            label.as_str()
        ),
        ("github-copilot", "claude-sonnet", "high", "proj")
    );
    assert!((credits.unwrap() - 50.0).abs() < 1e-9);

    // A resume in a later pass keeps the model and reasoning state from `file_offsets`.
    append(&fx.file, &assistant("a2", 1_790_000_100_000, 1.0, vec![]));
    fx.ingest();
    let n: i64 = fx
        .conn
        .query_row(
            "SELECT count(*) FROM messages WHERE model = 'claude-sonnet' AND reasoning = 'high'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 2);
}

#[test]
fn partial_last_line_waits_for_its_newline() {
    let mut fx = Fixture::new("partial");
    append(&fx.file, &header());
    let full = assistant("a1", 1_790_000_000_000, 0.5, vec![]);
    let (head, tail) = full.split_at(full.len() / 2);
    append(&fx.file, head);
    assert_eq!(fx.ingest().new_messages, 0);
    append(&fx.file, tail);
    assert_eq!(fx.ingest().new_messages, 1);
}

#[test]
fn tool_result_joins_a_call_from_an_earlier_pass_and_user_text_is_not_stored() {
    let mut fx = Fixture::new("tools");
    append(&fx.file, &header());
    let call = json!({"type":"toolCall","id":"c1","name":"bash","arguments":{}});
    append(
        &fx.file,
        &assistant("a1", 1_790_000_000_000, 0.5, vec![call]),
    );
    fx.ingest();
    append(
        &fx.file,
        &line(
            json!({"type":"message","id":"r1","timestamp":"2026-10-01T10:00:04.000Z","message":{
            "role":"toolResult","toolCallId":"c1","toolName":"bash","isError":true,
            "content":[{"type":"text","text":"boom"}]}}),
        ),
    );
    append(
        &fx.file,
        &line(
            json!({"type":"message","id":"u1","timestamp":"2026-10-01T10:00:05.000Z","message":{
            "role":"user","attribution":"user","timestamp":1_790_000_200_000i64,
            "content":[{"type":"text","text":"WHY DID YOU DO THAT!!!"}]}}),
        ),
    );
    fx.ingest();
    let (calls, errors, chars): (i64, i64, i64) = fx
        .conn
        .query_row(
            "SELECT sum(calls), sum(errors), sum(result_chars) FROM tool_rollup",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!((calls, errors, chars), (1, 1, 4));
    let (len, yelling, blame): (i64, i64, i64) = fx
        .conn
        .query_row("SELECT chars, yelling, blame FROM user_messages", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    assert_eq!(len, 22);
    assert!(yelling >= 1 && blame >= 1);
}

#[test]
fn non_copilot_provider_has_no_credits() {
    let mut fx = Fixture::new("credits");
    append(&fx.file, &header().replace("github-copilot/", "anthropic/"));
    append(&fx.file, &assistant("a1", 1_790_000_000_000, 0.5, vec![]));
    fx.ingest();
    let credits: Option<f64> = fx
        .conn
        .query_row("SELECT credits FROM messages", [], |r| r.get(0))
        .unwrap();
    assert_eq!(credits, None);
}

fn rollup_calls(fx: &Fixture) -> i64 {
    fx.conn
        .query_row("SELECT sum(calls) FROM message_rollup", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn longer_rewrite_with_the_same_head_is_reread_without_double_counting() {
    let mut fx = Fixture::new("rewrite-longer");
    append(&fx.file, &header());
    append(&fx.file, &assistant("a1", 1_790_000_000_000, 0.5, vec![]));
    append(&fx.file, &assistant("a2", 1_790_000_100_000, 0.25, vec![]));
    assert_eq!(fx.ingest().new_messages, 2);

    // Same first bytes, longer than the old offset, but the bytes before that offset moved.
    let rewritten = header()
        + &assistant("b1", 1_790_000_200_000, 0.1, vec![])
        + &assistant("a2", 1_790_000_100_000, 0.25, vec![])
        + &assistant("b2", 1_790_000_300_000, 0.2, vec![]);
    std::fs::write(&fx.file, rewritten).unwrap();
    assert_eq!(fx.ingest().new_messages, 2);

    // a1 survives from the old content, a2 is not counted twice, b1 and b2 are new.
    assert_eq!(fx.count("messages"), 4);
    assert_eq!(rollup_calls(&fx), 4);
    assert_eq!(fx.ingest().new_messages, 0);
}

#[test]
fn truncated_and_rewritten_file_is_reread_without_double_counting() {
    let mut fx = Fixture::new("rewrite-shorter");
    append(&fx.file, &header());
    append(&fx.file, &assistant("a1", 1_790_000_000_000, 0.5, vec![]));
    append(&fx.file, &assistant("a2", 1_790_000_100_000, 0.25, vec![]));
    fx.ingest();

    let rewritten = header() + &assistant("b1", 1_790_000_200_000, 0.1, vec![]);
    std::fs::write(&fx.file, rewritten).unwrap();
    assert_eq!(fx.ingest().new_messages, 1);
    assert_eq!(fx.count("messages"), 3);
    assert_eq!(rollup_calls(&fx), 3);
}

#[test]
fn row_saved_before_the_tail_window_existed_records_it_without_a_reset() {
    let mut fx = Fixture::new("tail-unknown");
    append(&fx.file, &header());
    append(&fx.file, &assistant("a1", 1_790_000_000_000, 0.5, vec![]));
    fx.ingest();
    fx.conn
        .execute("UPDATE file_offsets SET tail_len = 0, tail_hash = 0", [])
        .unwrap();

    append(&fx.file, &assistant("a2", 1_790_000_100_000, 0.25, vec![]));
    assert_eq!(fx.ingest().new_messages, 1);
    let tail_len: i64 = fx
        .conn
        .query_row("SELECT tail_len FROM file_offsets", [], |r| r.get(0))
        .unwrap();
    assert_eq!(tail_len, 256);
    assert_eq!((fx.count("messages"), rollup_calls(&fx)), (2, 2));
}
