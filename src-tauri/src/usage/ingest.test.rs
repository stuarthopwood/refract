// Runs against scratch files under the OS temp folder, left in place like the other test modules.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::json;

use super::*;
use crate::usage::rollup::{clean_rollups, relabel_file};
use crate::usage::schema;

fn scratch(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = crate::test_scratch::path(format!(
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
fn model_change_replay_credits_and_project_id() {
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
            "SELECT provider, model, reasoning, project_id, credits FROM messages",
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
    let category: Option<String> = fx
        .conn
        .query_row("SELECT error_category FROM tool_calls", [], |r| r.get(0))
        .unwrap();
    assert_eq!(category.as_deref(), Some("other"));
    let (len, yelling, blame): (i64, i64, i64) = fx
        .conn
        .query_row("SELECT chars, yelling, blame FROM user_messages", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    assert_eq!(len, 22);
    assert!(yelling >= 1 && blame >= 1);
}

fn tool_result(id: &str, call: &str, is_error: bool, text: &str) -> String {
    line(
        json!({"type":"message","id":id,"timestamp":"2026-10-01T10:00:04.000Z","message":{
        "role":"toolResult","toolCallId":call,"toolName":"bash","isError":is_error,
        "content":[{"type":"text","text":text}]}}),
    )
}

fn bash_call(id: &str) -> serde_json::Value {
    json!({"type":"toolCall","id":id,"name":"bash","arguments":{}})
}

fn error_category_of(fx: &Fixture, call: &str) -> (Option<i64>, Option<String>) {
    fx.conn
        .query_row(
            "SELECT is_error, error_category FROM tool_calls WHERE tool_call_id = ?1",
            [call],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
}

/// Every text value in every table, so a leak of result text into any column is caught.
fn every_text_value(conn: &rusqlite::Connection) -> Vec<String> {
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let mut out = Vec::new();
    for table in tables {
        let mut stmt = conn.prepare(&format!("SELECT * FROM \"{table}\"")).unwrap();
        let columns = stmt.column_count();
        let mut rows = stmt.query([]).unwrap();
        while let Some(row) = rows.next().unwrap() {
            for i in 0..columns {
                if let rusqlite::types::ValueRef::Text(bytes) = row.get_ref(i).unwrap() {
                    out.push(String::from_utf8_lossy(bytes).into_owned());
                }
            }
        }
    }
    out
}

#[test]
fn a_failed_result_stores_its_category_and_no_column_holds_the_message() {
    let mut fx = Fixture::new("category");
    append(&fx.file, &header());
    append(
        &fx.file,
        &assistant(
            "a1",
            1_790_000_000_000,
            0.5,
            vec![bash_call("c1"), bash_call("c2")],
        ),
    );
    append(
        &fx.file,
        &tool_result(
            "r1",
            "c1",
            true,
            "Tool \"bash\" is blocked by tool policy. Reason: swordfish-credentials",
        ),
    );
    append(&fx.file, &tool_result("r2", "c2", false, "swordfish-ok"));

    fx.ingest();

    assert_eq!(
        error_category_of(&fx, "c1"),
        (Some(1), Some("policy".to_string()))
    );
    assert_eq!(error_category_of(&fx, "c2"), (Some(0), None));
    let leaked: Vec<String> = every_text_value(&fx.conn)
        .into_iter()
        .filter(|v| v.contains("swordfish") || v.contains("blocked by tool policy"))
        .collect();
    assert!(leaked.is_empty(), "result text reached the db: {leaked:?}");
}

#[test]
fn a_multi_part_failed_result_is_categorised_across_its_parts() {
    let mut fx = Fixture::new("category-parts");
    append(&fx.file, &header());
    append(
        &fx.file,
        &assistant("a1", 1_790_000_000_000, 0.5, vec![bash_call("c1")]),
    );
    append(
        &fx.file,
        &line(
            json!({"type":"message","id":"r1","timestamp":"2026-10-01T10:00:04.000Z","message":{
            "role":"toolResult","toolCallId":"c1","toolName":"bash","isError":true,
            "content":[{"type":"text","text":"command failed"},{"type":"text","text":"eval cell timed out"}]}}),
        ),
    );

    fx.ingest();

    assert_eq!(
        error_category_of(&fx, "c1"),
        (Some(1), Some("timeout".to_string()))
    );
}

fn tool_rollup_sums(fx: &Fixture) -> (i64, i64, i64) {
    fx.conn
        .query_row(
            "SELECT sum(calls), sum(errors), sum(resolved) FROM tool_rollup",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
}

#[test]
fn resolved_counts_only_calls_whose_result_arrived_and_survives_a_reread_and_a_relabel() {
    let mut fx = Fixture::new("resolved");
    append(&fx.file, &header());
    append(
        &fx.file,
        &assistant(
            "a1",
            1_790_000_000_000,
            0.5,
            vec![bash_call("c1"), bash_call("c2"), bash_call("c3")],
        ),
    );
    append(&fx.file, &tool_result("r1", "c1", true, "boom"));
    append(&fx.file, &tool_result("r2", "c2", false, "fine"));
    fx.ingest();
    // c3 is still running: it is a call but has no verdict yet.
    assert_eq!(tool_rollup_sums(&fx), (3, 1, 2));

    // A full re-read finds the same results again and adds nothing.
    fx.conn
        .execute("UPDATE file_offsets SET offset = 0", [])
        .unwrap();
    fx.ingest();
    assert_eq!(tool_rollup_sums(&fx), (3, 1, 2));

    // The late result of the running call resolves it once.
    append(&fx.file, &tool_result("r3", "c3", false, "late"));
    fx.ingest();
    assert_eq!(tool_rollup_sums(&fx), (3, 1, 3));

    // Moving the file to another project moves its rollup rows without changing the sums.
    let session_file: String = fx
        .conn
        .query_row("SELECT DISTINCT session_file FROM tool_calls", [], |r| {
            r.get(0)
        })
        .unwrap();
    relabel_file(&fx.conn, &session_file, "repo-moved").unwrap();
    clean_rollups(&fx.conn).unwrap();
    assert_eq!(tool_rollup_sums(&fx), (3, 1, 3));
    let ids: Vec<String> = fx
        .conn
        .prepare("SELECT DISTINCT project_id FROM tool_rollup")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(ids, vec!["repo-moved".to_string()]);
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

    // Same first bytes, longer than the old offset, but the lines just before that offset differ.
    let rewritten = header()
        + &assistant("a1", 1_790_000_000_000, 0.5, vec![])
        + &assistant("b1", 1_790_000_200_000, 0.1, vec![])
        + &assistant("b2", 1_790_000_300_000, 0.2, vec![]);
    std::fs::write(&fx.file, rewritten).unwrap();
    assert_eq!(fx.ingest().new_messages, 2);

    // a1 is not counted twice, a2 stays from the old content, b1 and b2 are new.
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

fn stamped(fx: &Fixture) -> (String, String, Option<String>) {
    let on_file: String = fx
        .conn
        .query_row("SELECT project_id FROM file_offsets", [], |r| r.get(0))
        .unwrap();
    let on_message: String = fx
        .conn
        .query_row("SELECT project_id FROM messages", [], |r| r.get(0))
        .unwrap();
    let name = fx
        .conn
        .query_row(
            "SELECT name FROM projects WHERE project_id = ?1",
            [&on_file],
            |r| r.get(0),
        )
        .ok();
    (on_file, on_message, name)
}

#[test]
fn a_project_cwd_stamps_the_registry_id_and_records_its_name() {
    let mut fx = Fixture::new("stamp-project");
    fx.projects = ProjectIndex::from_triples([(
        "C:\\Work\\proj".to_string(),
        "repo-7".to_string(),
        "Proj Name".to_string(),
    )]);
    append(&fx.file, &header());
    append(&fx.file, &assistant("a1", 1_790_000_000_000, 0.5, vec![]));

    fx.ingest();

    assert_eq!(
        stamped(&fx),
        (
            "repo-7".to_string(),
            "repo-7".to_string(),
            Some("Proj Name".to_string())
        )
    );
    let rollup_id: String = fx
        .conn
        .query_row("SELECT project_id FROM message_rollup", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rollup_id, "repo-7");
}

#[test]
fn the_personal_home_cwd_stamps_the_personal_id() {
    let mut fx = Fixture::new("stamp-personal");
    fx.projects = ProjectIndex::from_pairs([("C:\\Work\\other", "other")])
        .with_personal_home("C:\\Work\\proj\\src");
    append(&fx.file, &header());
    append(&fx.file, &assistant("a1", 1_790_000_000_000, 0.5, vec![]));

    fx.ingest();

    assert_eq!(
        stamped(&fx),
        (
            "@personal".to_string(),
            "@personal".to_string(),
            Some("Personal".to_string())
        )
    );
}
