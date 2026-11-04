// Runs against scratch files under the OS temp folder, left in place like the other test modules.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;

use serde_json::json;

use super::*;
use crate::usage::{ingest, schema};

struct Fixture {
    root: PathBuf,
    conn: Connection,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "refract-relabel-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(dir.join("sessions")).unwrap();
        Self {
            root: dir.join("sessions"),
            conn: schema::open_db(&dir.join("usage.db")).unwrap(),
        }
    }

    /// One session file with a single 0.5-cost assistant message, ingested under `projects`.
    fn seed(&mut self, folder: &str, name: &str, cwd: Option<&str>, projects: &ProjectIndex) {
        let dir = self.root.join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{name}.jsonl"));
        let mut header = json!({"type":"session","id":name,"timestamp":"2026-10-01T10:00:00.000Z"});
        if let Some(cwd) = cwd {
            header["cwd"] = json!(cwd);
        }
        let message = json!({"type":"message","id":"a1","timestamp":"2026-10-01T10:00:03.000Z",
            "message":{"role":"assistant","content":[{"type":"text","text":"ok"}],
            "timestamp":1_790_000_000_000_i64,
            "usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":15,
                     "cost":{"input":0.1,"output":0.1,"cacheRead":0.0,"cacheWrite":0.0,"total":0.5}}}});
        let model = json!({"type":"model_change","id":"m1","timestamp":"2026-10-01T10:00:01.000Z",
            "model":"github-copilot/claude-sonnet"});
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(file, "{header}\n{model}\n{message}").unwrap();
        ingest::ingest_file(&mut self.conn, &path, "main", &self.root, projects).unwrap();
    }

    fn relabel(&mut self, projects: &ProjectIndex) {
        relabel(&mut self.conn, &self.root, projects).unwrap();
    }

    /// Calls per label across the rollup.
    fn by_label(&self) -> BTreeMap<String, i64> {
        let mut stmt = self
            .conn
            .prepare("SELECT project_label, sum(calls) FROM message_rollup GROUP BY project_label")
            .unwrap();
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .unwrap();
        rows.map(Result::unwrap).collect()
    }

    fn message_labels(&self) -> BTreeMap<String, i64> {
        let mut stmt = self
            .conn
            .prepare("SELECT project_label, count(*) FROM messages GROUP BY project_label")
            .unwrap();
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .unwrap();
        rows.map(Result::unwrap).collect()
    }

    fn total_cost(&self) -> f64 {
        self.conn
            .query_row("SELECT sum(cost_total) FROM message_rollup", [], |r| {
                r.get(0)
            })
            .unwrap()
    }
}

fn counts(pairs: &[(&str, i64)]) -> BTreeMap<String, i64> {
    pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}

fn seeded() -> Fixture {
    let before = ProjectIndex::from_pairs([]);
    let mut fx = Fixture::new("seeded");
    let pinion_folder = "--C--Repos-personal-pinion--";
    fx.seed(
        pinion_folder,
        "a",
        Some("C:\\Repos\\personal\\pinion"),
        &before,
    );
    fx.seed(pinion_folder, "b", None, &before);
    fx.seed(
        "--C--tmp-scratch--",
        "c",
        Some("C:\\tmp\\scratch1"),
        &before,
    );
    fx.seed("--C--tmp-scratch2--", "d", None, &before);
    fx.seed(
        "--C--Second-Brain--",
        "e",
        Some("c:\\second-brain"),
        &before,
    );
    fx.seed(
        "--C--Second-Brain-b--",
        "f",
        Some("C:\\Second-Brain"),
        &before,
    );
    fx
}

fn registered() -> ProjectIndex {
    ProjectIndex::from_pairs([
        ("C:\\Repos\\personal\\pinion", "pinion-app"),
        (
            "C:\\Repos\\personal\\pinion-worktrees\\pinion",
            "pinion-app",
        ),
    ])
}

#[test]
fn relabels_rows_to_projects_other_and_one_merged_folder_without_changing_totals() {
    let mut fx = seeded();
    let cost = fx.total_cost();
    assert_eq!(
        fx.by_label(),
        counts(&[
            ("Repos-personal-pinion", 1),
            ("pinion", 1),
            ("Second-Brain", 1),
            ("Other", 2),
            ("second-brain", 1),
        ])
    );

    fx.relabel(&registered());

    let expected = counts(&[("Other", 2), ("Second-Brain", 2), ("pinion-app", 2)]);
    assert_eq!(fx.by_label(), expected);
    assert_eq!(fx.message_labels(), expected);
    assert_eq!(fx.total_cost(), cost);
}

#[test]
fn a_registry_change_moves_rows_back_and_forth() {
    let mut fx = seeded();
    fx.relabel(&registered());
    fx.relabel(&ProjectIndex::from_pairs([]));

    let labels = fx.by_label();
    assert_eq!(labels.get("pinion"), Some(&2));
    assert!(!labels.contains_key("pinion-app"));
    assert_eq!(labels.values().sum::<i64>(), 6);
}

#[test]
fn a_second_pass_changes_nothing() {
    let mut fx = seeded();
    fx.relabel(&registered());
    let once = fx.by_label();
    fx.relabel(&registered());
    assert_eq!(fx.by_label(), once);
}
