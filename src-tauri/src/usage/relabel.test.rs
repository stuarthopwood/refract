// Runs against scratch files under the OS temp folder, left in place like the other test modules.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;

use serde_json::json;

use super::*;
use crate::usage::{ingest, schema};

const TABLES: [&str; 7] = [
    "file_offsets",
    "messages",
    "tool_calls",
    "user_messages",
    "message_rollup",
    "tool_rollup",
    "session_rollup",
];

struct Fixture {
    root: PathBuf,
    db: PathBuf,
    conn: Connection,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = crate::test_scratch::path(format!(
            "refract-relabel-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(dir.join("sessions")).unwrap();
        Self {
            root: dir.join("sessions"),
            db: dir.join("usage.db"),
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

    /// Calls per Project id across the rollup.
    fn by_id(&self) -> BTreeMap<String, i64> {
        let mut stmt = self
            .conn
            .prepare("SELECT project_id, sum(calls) FROM message_rollup GROUP BY project_id")
            .unwrap();
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .unwrap();
        rows.map(Result::unwrap).collect()
    }

    fn message_ids(&self) -> BTreeMap<String, i64> {
        let mut stmt = self
            .conn
            .prepare("SELECT project_id, count(*) FROM messages GROUP BY project_id")
            .unwrap();
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .unwrap();
        rows.map(Result::unwrap).collect()
    }

    /// The display name the lookup table holds for `id`.
    fn name_of(&self, id: &str) -> Option<String> {
        self.conn
            .query_row(
                "SELECT name FROM projects WHERE project_id = ?1",
                [id],
                |r| r.get(0),
            )
            .ok()
    }

    fn total_cost(&self) -> f64 {
        self.conn
            .query_row("SELECT sum(cost_total) FROM message_rollup", [], |r| {
                r.get(0)
            })
            .unwrap()
    }

    /// Rewrites the database into the shape version 4 left (Projects keyed by the name `label`) and
    /// reopens it, so the real v4 to v5 migration produces the `@legacy:` rows.
    fn migrate_from_v4(&mut self, label: &str) {
        let c = &self.conn;
        c.execute_batch("DROP TABLE projects").unwrap();
        for table in TABLES {
            c.execute_batch(&format!(
                "ALTER TABLE {table} RENAME COLUMN project_id TO project_label; \
                 UPDATE {table} SET project_label = '{label}'"
            ))
            .unwrap();
        }
        c.execute_batch("PRAGMA user_version = 4").unwrap();
        drop(std::mem::replace(
            &mut self.conn,
            Connection::open_in_memory().unwrap(),
        ));
        self.conn = schema::open_db(&self.db).unwrap();
    }

    /// Rows per Project id in every table that carries one.
    fn legacy_rows(&self) -> i64 {
        TABLES
            .iter()
            .map(|table| {
                self.conn
                    .query_row(
                        &format!("SELECT count(*) FROM {table} WHERE project_id LIKE '@legacy:%'"),
                        [],
                        |r| r.get::<_, i64>(0),
                    )
                    .unwrap()
            })
            .sum()
    }

    fn rollup_cost(&self, id: &str) -> f64 {
        self.conn
            .query_row(
                "SELECT coalesce(sum(cost_total), 0) FROM message_rollup WHERE project_id = ?1",
                [id],
                |r| r.get(0),
            )
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
        fx.by_id(),
        counts(&[
            ("@folder:repos-personal-pinion", 1),
            ("@folder:pinion", 1),
            ("@folder:second-brain", 2),
            ("@other", 2),
        ])
    );

    fx.relabel(&registered());

    let expected = counts(&[("@other", 2), ("@folder:second-brain", 2), ("pinion-app", 2)]);
    assert_eq!(fx.by_id(), expected);
    assert_eq!(fx.message_ids(), expected);
    assert_eq!(fx.total_cost(), cost);
    assert_eq!(fx.name_of("@folder:second-brain").as_deref(), Some("Second-Brain"));
    assert_eq!(fx.name_of("@other").as_deref(), Some("Other"));
}

#[test]
fn a_removed_project_keeps_its_rows_and_last_name() {
    let mut fx = seeded();
    fx.relabel(&registered());
    fx.relabel(&ProjectIndex::from_pairs([]));

    let ids = fx.by_id();
    assert_eq!(ids.get("pinion-app"), Some(&2));
    assert_eq!(ids.values().sum::<i64>(), 6);
    assert_eq!(fx.name_of("pinion-app").as_deref(), Some("pinion-app"));
}

#[test]
fn a_renamed_project_shows_the_new_name_with_the_same_rows() {
    let mut fx = seeded();
    fx.relabel(&registered());
    let renamed = ProjectIndex::from_triples([(
        "C:\\Repos\\personal\\pinion".to_string(),
        "pinion-app".to_string(),
        "Refract".to_string(),
    )]);
    fx.relabel(&renamed);

    assert_eq!(fx.by_id().get("pinion-app"), Some(&2));
    assert_eq!(fx.name_of("pinion-app").as_deref(), Some("Refract"));
}

#[test]
fn a_second_pass_changes_nothing() {
    let mut fx = seeded();
    fx.relabel(&registered());
    let once = fx.by_id();
    fx.relabel(&registered());
    assert_eq!(fx.by_id(), once);
}

#[test]
fn a_project_renamed_and_then_removed_keeps_the_new_name() {
    let mut fx = seeded();
    fx.relabel(&registered());
    fx.relabel(&ProjectIndex::from_triples([(
        "C:\\Repos\\personal\\pinion".to_string(),
        "pinion-app".to_string(),
        "Refract".to_string(),
    )]));

    fx.relabel(&ProjectIndex::from_pairs([]));

    assert_eq!(fx.name_of("pinion-app").as_deref(), Some("Refract"));
    assert_eq!(fx.by_id().get("pinion-app"), Some(&2));
}

const PINION_CWD: &str = "C:\\Repos\\personal\\pinion";
const PINION_FOLDER: &str = "--C--Repos-personal-pinion--";

fn refract() -> ProjectIndex {
    ProjectIndex::from_triples([(
        PINION_CWD.to_string(),
        "repo-1".to_string(),
        "Refract".to_string(),
    )])
}

/// A v4 database whose one session file is labelled `Refract`, migrated to v5 but not yet relabelled.
fn migrated_v4() -> Fixture {
    let mut fx = Fixture::new("v4");
    fx.seed(PINION_FOLDER, "a", Some(PINION_CWD), &ProjectIndex::from_pairs([]));
    fx.migrate_from_v4("Refract");
    fx
}

#[test]
fn a_migrated_v4_file_moves_from_its_legacy_id_to_the_real_id_with_totals_unchanged() {
    let mut fx = migrated_v4();
    assert_eq!(fx.by_id(), counts(&[("@legacy:Refract", 1)]));
    assert!(fx.legacy_rows() > 0);
    let cost = fx.total_cost();

    fx.relabel(&refract());

    assert_eq!(fx.by_id(), counts(&[("repo-1", 1)]));
    assert_eq!(fx.message_ids(), counts(&[("repo-1", 1)]));
    assert_eq!(fx.rollup_cost("repo-1"), cost);
    assert_eq!(fx.legacy_rows(), 0);
    assert_eq!(fx.name_of("repo-1").as_deref(), Some("Refract"));
    assert_eq!(fx.name_of("@legacy:Refract"), None);
}

#[test]
fn relabelling_a_legacy_file_adds_to_a_real_id_rollup_row_that_already_exists() {
    let mut fx = migrated_v4();
    // Ingest after the upgrade but before the relabel: the same hour, model and agent land under the real id.
    fx.seed(PINION_FOLDER, "x", Some(PINION_CWD), &refract());
    assert_eq!(fx.by_id(), counts(&[("@legacy:Refract", 1), ("repo-1", 1)]));
    let cost = fx.total_cost();

    fx.relabel(&refract());

    assert_eq!(fx.by_id(), counts(&[("repo-1", 2)]));
    assert_eq!(fx.rollup_cost("repo-1"), cost);
    assert_eq!(fx.legacy_rows(), 0);
    let rows: i64 = fx
        .conn
        .query_row("SELECT count(*) FROM message_rollup", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 1);
}
