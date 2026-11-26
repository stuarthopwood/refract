// Runs against scratch folders from `test_scratch`, removed when each test ends.

use super::*;

fn scratch_db(label: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = crate::test_scratch::path(format!(
        "refract-usage-{label}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("usage.db")
}

fn version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap()
}

/// Turns a fresh file back into the shape version 4 left: Projects keyed by a name in `project_label`.
const AS_VERSION_4: &str = "
DROP TABLE projects;
ALTER TABLE file_offsets RENAME COLUMN project_id TO project_label;
ALTER TABLE messages RENAME COLUMN project_id TO project_label;
ALTER TABLE tool_calls RENAME COLUMN project_id TO project_label;
ALTER TABLE user_messages RENAME COLUMN project_id TO project_label;
ALTER TABLE message_rollup RENAME COLUMN project_id TO project_label;
ALTER TABLE tool_rollup RENAME COLUMN project_id TO project_label;
ALTER TABLE session_rollup RENAME COLUMN project_id TO project_label;
";

#[test]
fn version_2_database_keeps_its_rows_and_gains_the_tail_columns() {
    let path = scratch_db("migrate-2");
    let conn = open_db(&path).unwrap();
    conn.execute_batch(AS_VERSION_4).unwrap();
    conn.execute_batch(
        "ALTER TABLE file_offsets DROP COLUMN tail_len;
         ALTER TABLE tool_calls RENAME COLUMN cost_usd TO cost_share;
         ALTER TABLE tool_rollup RENAME COLUMN cost_usd TO cost_share;
         ALTER TABLE file_offsets DROP COLUMN tail_hash;
         INSERT INTO file_offsets (session_file, offset, head_len, head_hash) VALUES ('f', 42, 7, 9);
         PRAGMA user_version = 2;",
    )
    .unwrap();
    drop(conn);

    let conn = open_db(&path).unwrap();
    assert_eq!(version(&conn), USER_VERSION);
    let row: (i64, i64, i64, i64) = conn
        .query_row(
            "SELECT offset, head_len, tail_len, tail_hash FROM file_offsets WHERE session_file = 'f'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(row, (42, 7, 0, 0));
    assert!(std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .all(|e| !e.unwrap().file_name().to_string_lossy().contains(".bak-")));
}

/// A file as version 3 left it: the dollar columns still named `cost_share`, holding rows.
fn write_v3_db(path: &Path) {
    let conn = open_db(path).unwrap();
    conn.execute_batch(AS_VERSION_4).unwrap();
    conn.execute_batch(
        "ALTER TABLE tool_calls RENAME COLUMN cost_usd TO cost_share;
         ALTER TABLE tool_rollup RENAME COLUMN cost_usd TO cost_share;
         INSERT INTO tool_calls (session_file, tool_call_id, ts, entry_id, tool, cost_share)
           VALUES ('f', 'c1', 1000, 'e1', 'bash', 1.5);
         INSERT INTO tool_rollup (hour, project_label, tool, agent_type, calls, cost_share)
           VALUES (0, 'p', 'bash', 'main', 1, 1.5);
         PRAGMA user_version = 3;",
    )
    .unwrap();
}

#[test]
fn version_3_database_keeps_its_tool_history_under_the_renamed_column() {
    let path = scratch_db("migrate-3");
    write_v3_db(&path);

    let conn = open_db(&path).unwrap();

    assert_eq!(version(&conn), USER_VERSION);
    let call: f64 = conn
        .query_row("SELECT cost_usd FROM tool_calls", [], |r| r.get(0))
        .unwrap();
    let rollup: f64 = conn
        .query_row("SELECT cost_usd FROM tool_rollup", [], |r| r.get(0))
        .unwrap();
    assert_eq!((call, rollup), (1.5, 1.5));
    assert!(conn.prepare("SELECT cost_share FROM tool_calls").is_err());
    assert!(std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .all(|e| !e.unwrap().file_name().to_string_lossy().contains(".bak-")));
}

/// A file as version 4 left it: Projects keyed by name, every table holding a row, one with no label.
fn write_v4_db(path: &Path) {
    let conn = open_db(path).unwrap();
    conn.execute_batch(AS_VERSION_4).unwrap();
    conn.execute_batch(
        "INSERT INTO file_offsets (session_file, offset, project_label) VALUES ('f', 9, 'Refract');
         INSERT INTO file_offsets (session_file, offset, project_label) VALUES ('g', 4, '');
         INSERT INTO messages (session_file, entry_id, ts, project_label) VALUES ('f', 'm1', 1000, 'Refract');
         INSERT INTO tool_calls (session_file, tool_call_id, ts, entry_id, tool, cost_usd, project_label)
           VALUES ('f', 'c1', 1000, 'e1', 'bash', 1.5, 'Refract');
         INSERT INTO user_messages (session_file, entry_id, ts, project_label) VALUES ('f', 'u1', 1000, 'Refract');
         INSERT INTO message_rollup (hour, project_label, model, reasoning, agent_type, calls)
           VALUES (0, 'Refract', 'm', '', 'main', 1);
         INSERT INTO tool_rollup (hour, project_label, tool, agent_type, calls, cost_usd)
           VALUES (0, 'Refract', 'bash', 'main', 2, 3.0);
         INSERT INTO tool_rollup (hour, project_label, tool, agent_type, calls, cost_usd)
           VALUES (0, 'Other', 'bash', 'main', 1, 0.5);
         INSERT INTO session_rollup (session_file, first_ts, last_ts, calls, project_label)
           VALUES ('f', 1000, 1000, 1, 'Refract');
         PRAGMA user_version = 4;",
    )
    .unwrap();
}

#[test]
fn version_4_migration_rekeys_every_table_and_leaves_an_unlabelled_row_unlabelled() {
    let path = scratch_db("migrate-4-tables");
    write_v4_db(&path);

    let conn = open_db(&path).unwrap();

    for table in [
        "file_offsets",
        "messages",
        "tool_calls",
        "user_messages",
        "message_rollup",
        "tool_rollup",
        "session_rollup",
    ] {
        let legacy: i64 = conn
            .query_row(
                &format!("SELECT count(*) FROM {table} WHERE project_id = '@legacy:Refract'"),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(legacy, 1, "{table}");
    }
    let unlabelled: String = conn
        .query_row(
            "SELECT project_id FROM file_offsets WHERE session_file = 'g'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(unlabelled, "");
    let names: i64 = conn
        .query_row("SELECT count(*) FROM projects WHERE name = ''", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(names, 0);
}

fn saved_filters(conn: &Connection) -> serde_json::Value {
    serde_json::from_str(&prefs_get(conn, PREF_FILTERS).unwrap().unwrap()).unwrap()
}

#[test]
fn version_4_migration_maps_a_saved_project_name_to_its_legacy_id() {
    let path = scratch_db("migrate-4-prefs");
    write_v4_db(&path);
    let conn = Connection::open(&path).unwrap();
    prefs_set(
        &conn,
        PREF_FILTERS,
        r#"{"range":"7d","project":"Refract","model":"m"}"#,
    )
    .unwrap();
    drop(conn);

    let conn = open_db(&path).unwrap();

    let filters = saved_filters(&conn);
    assert_eq!(filters["project"], "@legacy:Refract");
    assert_eq!(
        (&filters["range"], &filters["model"]),
        (&"7d".into(), &"m".into())
    );
}

#[test]
fn version_4_migration_clears_an_empty_saved_project_filter() {
    let path = scratch_db("migrate-4-prefs-empty");
    write_v4_db(&path);
    let conn = Connection::open(&path).unwrap();
    prefs_set(&conn, PREF_FILTERS, r#"{"range":"7d","project":" "}"#).unwrap();
    drop(conn);

    let conn = open_db(&path).unwrap();

    assert!(saved_filters(&conn)["project"].is_null());
}

#[test]
fn version_4_database_keeps_every_row_and_name_under_a_legacy_project_id() {
    let path = scratch_db("migrate-4");
    write_v4_db(&path);

    let conn = open_db(&path).unwrap();

    assert_eq!(version(&conn), USER_VERSION);
    let rollup: Vec<(String, i64)> = conn
        .prepare("SELECT project_id, calls FROM tool_rollup ORDER BY project_id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        rollup,
        vec![
            ("@legacy:Other".to_string(), 1),
            ("@legacy:Refract".to_string(), 2)
        ]
    );
    let offset_id: String = conn
        .query_row("SELECT project_id FROM file_offsets", [], |r| r.get(0))
        .unwrap();
    let call_id: String = conn
        .query_row("SELECT project_id FROM tool_calls", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        (offset_id.as_str(), call_id.as_str()),
        ("@legacy:Refract", "@legacy:Refract")
    );
    let name: String = conn
        .query_row(
            "SELECT name FROM projects WHERE project_id = '@legacy:Refract'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(name, "Refract");
    assert!(conn
        .prepare("SELECT project_label FROM tool_rollup")
        .is_err());
    assert!(std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .all(|e| !e.unwrap().file_name().to_string_lossy().contains(".bak-")));
}

#[test]
fn reopening_a_migrated_database_leaves_it_unchanged() {
    let path = scratch_db("migrate-3-twice");
    write_v3_db(&path);
    drop(open_db(&path).unwrap());

    let conn = open_db(&path).unwrap();

    let rows: i64 = conn
        .query_row("SELECT count(*) FROM tool_calls", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 1);
}

#[test]
fn migrating_an_already_current_file_is_a_no_op_that_keeps_its_data() {
    let path = scratch_db("migrate-already-4");
    write_v3_db(&path);
    let mut b = Connection::open(&path).unwrap();
    migrate(&mut b).unwrap();
    assert_eq!(version(&b), USER_VERSION);

    migrate(&mut b).unwrap();

    assert_eq!(version(&b), USER_VERSION);
    let (cost, rows): (f64, i64) = b
        .query_row("SELECT cost_usd, count(*) FROM tool_calls", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!((cost, rows), (1.5, 1));
    assert!(b.prepare("SELECT cost_share FROM tool_calls").is_err());
}

// Probabilistic: correct code passes every interleaving, but a non-atomic pre-check with a deferred BEGIN only fails when the threads happen to collide.
#[test]
fn two_openers_racing_to_migrate_a_version_3_file_both_succeed() {
    for round in 0..20 {
        let path = scratch_db(&format!("migrate-race-{round}"));
        write_v3_db(&path);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let (path, barrier) = (path.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    try_open(&path).map(drop)
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap().unwrap();
        }

        let conn = Connection::open(&path).unwrap();
        assert_eq!(version(&conn), USER_VERSION);
        let cost: f64 = conn
            .query_row("SELECT cost_usd FROM tool_calls", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cost, 1.5);
        assert!(conn.prepare("SELECT cost_share FROM tool_calls").is_err());
    }
}

#[test]
fn version_1_database_is_set_aside_and_rebuilt() {
    let path = scratch_db("migrate-1");
    let conn = open_db(&path).unwrap();
    conn.pragma_update(None, "user_version", 1).unwrap();
    drop(conn);

    let conn = open_db(&path).unwrap();
    assert_eq!(version(&conn), USER_VERSION);
    assert!(std::fs::read_dir(path.parent().unwrap()).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains(".bak-")));
}
