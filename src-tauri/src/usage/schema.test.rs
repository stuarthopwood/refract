// Runs against scratch folders under the OS temp folder, left in place like the other test modules.

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

#[test]
fn version_2_database_keeps_its_rows_and_gains_the_tail_columns() {
    let path = scratch_db("migrate-2");
    let conn = open_db(&path).unwrap();
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
