// `usage.db` is derived data: a corrupt or newer-version file is renamed aside, never repaired.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{Connection, ErrorCode, OptionalExtension, TransactionBehavior};

use super::project_label::LEGACY_PREFIX;

pub const USER_VERSION: i64 = 6;
/// The `prefs` key that holds the Usage view's saved filters.
pub const PREF_FILTERS: &str = "filters";
/// Older files are rebuilt; versions 2 to 5 are migrated in place.
const MIN_MIGRATABLE: i64 = 2;

/// `tail_len` 0 reads as an unknown window: the next ingest pass records it without a reset.
const MIGRATE_2_TO_3: &str = "
ALTER TABLE file_offsets ADD COLUMN tail_len INTEGER NOT NULL DEFAULT 0;
ALTER TABLE file_offsets ADD COLUMN tail_hash INTEGER NOT NULL DEFAULT 0;
";

/// The column holds each tool call's dollars, not a share; renaming keeps the existing history.
const MIGRATE_3_TO_4: &str = "
ALTER TABLE tool_calls RENAME COLUMN cost_share TO cost_usd;
ALTER TABLE tool_rollup RENAME COLUMN cost_share TO cost_usd;
";

/// Spend is keyed by a stable Project id, not the Project's name. Each existing label becomes a
/// `@legacy:` id (its name kept in `projects`) until the next relabel pass maps its files to real
/// ids from their stored cwd; the column rename rewrites the rollup primary keys in place, so no
/// OMP file is re-read and no row is dropped. The names come from the per-file and rollup tables
/// alone: every fact row's label also sits in one of them, and scanning the fact tables would be slow.
const MIGRATE_4_TO_5: &str = "
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL
) WITHOUT ROWID;
INSERT OR IGNORE INTO projects (project_id, name)
  SELECT '@legacy:' || project_label, project_label FROM (
    SELECT project_label FROM file_offsets
    UNION SELECT project_label FROM message_rollup UNION SELECT project_label FROM tool_rollup
    UNION SELECT project_label FROM session_rollup
  ) WHERE project_label <> '';
ALTER TABLE file_offsets RENAME COLUMN project_label TO project_id;
ALTER TABLE messages RENAME COLUMN project_label TO project_id;
ALTER TABLE tool_calls RENAME COLUMN project_label TO project_id;
ALTER TABLE user_messages RENAME COLUMN project_label TO project_id;
ALTER TABLE message_rollup RENAME COLUMN project_label TO project_id;
ALTER TABLE tool_rollup RENAME COLUMN project_label TO project_id;
ALTER TABLE session_rollup RENAME COLUMN project_label TO project_id;
UPDATE file_offsets SET project_id = '@legacy:' || project_id WHERE project_id <> '';
UPDATE messages SET project_id = '@legacy:' || project_id WHERE project_id <> '';
UPDATE tool_calls SET project_id = '@legacy:' || project_id WHERE project_id <> '';
UPDATE user_messages SET project_id = '@legacy:' || project_id WHERE project_id <> '';
UPDATE message_rollup SET project_id = '@legacy:' || project_id WHERE project_id <> '';
UPDATE tool_rollup SET project_id = '@legacy:' || project_id WHERE project_id <> '';
UPDATE session_rollup SET project_id = '@legacy:' || project_id WHERE project_id <> '';
";

/// Tool errors gain a category, and the rollup counts calls whose result arrived (the error-rate
/// denominator). Errors recorded earlier kept no text, so they become `unknown`; `resolved` is
/// rebuilt exactly from the per-call rows in one grouped pass (a per-row subquery would rescan
/// `tool_calls` for every rollup row), so no OMP file is re-read.
const MIGRATE_5_TO_6: &str = "
ALTER TABLE tool_calls ADD COLUMN error_category TEXT;
ALTER TABLE tool_rollup ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0;
UPDATE tool_calls SET error_category = 'unknown' WHERE is_error = 1;
UPDATE tool_rollup SET resolved = r.n FROM (
  SELECT ts - ts % 3600000 AS h, project_id AS p, tool AS t, agent_type AS a, count(is_error) AS n
  FROM tool_calls GROUP BY 1, 2, 3, 4
) AS r WHERE tool_rollup.hour = r.h AND tool_rollup.project_id = r.p
  AND tool_rollup.tool = r.t AND tool_rollup.agent_type = r.a;
CREATE INDEX IF NOT EXISTS tool_calls_errors_ts ON tool_calls (ts) WHERE is_error = 1;
";

/// Unknown key parts are `''` rather than NULL so the primary keys stay unique.
const DDL: &str = "
CREATE TABLE IF NOT EXISTS file_offsets (
  session_file TEXT PRIMARY KEY,
  offset INTEGER NOT NULL DEFAULT 0,
  last_modified INTEGER NOT NULL DEFAULT 0,
  file_len INTEGER NOT NULL DEFAULT 0,
  session_id TEXT NOT NULL DEFAULT '',
  cwd TEXT,
  agent_type TEXT NOT NULL DEFAULT 'main',
  project_id TEXT NOT NULL DEFAULT '',
  cur_model TEXT NOT NULL DEFAULT '',
  cur_reasoning TEXT NOT NULL DEFAULT '',
  head_len INTEGER NOT NULL DEFAULT 0,
  head_hash INTEGER NOT NULL DEFAULT 0,
  tail_len INTEGER NOT NULL DEFAULT 0,
  tail_hash INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  session_file TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  reasoning TEXT NOT NULL DEFAULT '',
  agent_type TEXT NOT NULL DEFAULT 'main',
  purpose TEXT,
  project_id TEXT NOT NULL DEFAULT '',
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  cost_input REAL NOT NULL DEFAULT 0,
  cost_output REAL NOT NULL DEFAULT 0,
  cost_cache_read REAL NOT NULL DEFAULT 0,
  cost_cache_write REAL NOT NULL DEFAULT 0,
  credits REAL,
  premium_requests REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  ttft_ms INTEGER,
  stop_reason TEXT,
  PRIMARY KEY (session_file, entry_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS tool_calls (
  session_file TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  entry_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  is_error INTEGER,
  error_category TEXT,
  result_chars INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  project_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  reasoning TEXT NOT NULL DEFAULT '',
  agent_type TEXT NOT NULL DEFAULT 'main',
  PRIMARY KEY (session_file, tool_call_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS user_messages (
  session_file TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  chars INTEGER NOT NULL DEFAULT 0,
  yelling INTEGER NOT NULL DEFAULT 0,
  profanity INTEGER NOT NULL DEFAULT 0,
  blame INTEGER NOT NULL DEFAULT 0,
  project_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_file, entry_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS message_rollup (
  hour INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  cost_input REAL NOT NULL DEFAULT 0,
  cost_output REAL NOT NULL DEFAULT 0,
  cost_cache_read REAL NOT NULL DEFAULT 0,
  cost_cache_write REAL NOT NULL DEFAULT 0,
  credits REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, project_id, model, reasoning, agent_type)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS tool_rollup (
  hour INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0,
  result_chars INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, project_id, tool, agent_type)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS session_rollup (
  session_file TEXT PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT '',
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  credits REAL NOT NULL DEFAULT 0,
  project_id TEXT NOT NULL DEFAULT ''
);
-- Stable Project id to its current or last-known name, so a renamed or removed Project keeps its rows.
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS prefs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts);
CREATE INDEX IF NOT EXISTS messages_project_ts ON messages (project_id, ts);
CREATE INDEX IF NOT EXISTS messages_model_ts ON messages (model, reasoning, ts);
CREATE INDEX IF NOT EXISTS tool_calls_tool_ts ON tool_calls (tool, ts);
CREATE INDEX IF NOT EXISTS tool_calls_errors_ts ON tool_calls (ts) WHERE is_error = 1;
CREATE INDEX IF NOT EXISTS user_messages_ts ON user_messages (ts);
";

/// Serialises create and rebuild so no reader races a rename.
static INIT_LOCK: Mutex<()> = Mutex::new(());

/// Opens `path`, creating and migrating it. A corrupt or incompatible file is set aside first.
pub fn open_db(path: &Path) -> rusqlite::Result<Connection> {
    let _guard = INIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match try_open(path) {
        Err(err) if is_rebuildable(&err) => {
            quarantine(path);
            try_open(path)
        }
        other => other,
    }
}

/// Opens a read connection with `query_only` set, so queries cannot write.
pub fn open_reader(path: &Path) -> rusqlite::Result<Connection> {
    let conn = open_db(path)?;
    conn.pragma_update(None, "query_only", true)?;
    Ok(conn)
}

fn try_open(path: &Path) -> rusqlite::Result<Connection> {
    let mut conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version > USER_VERSION || (version > 0 && version < MIN_MIGRATABLE) {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_NOTADB),
            Some("usage.db has a different schema version".to_string()),
        ));
    }
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    if version < USER_VERSION {
        migrate(&mut conn)?;
    }
    Ok(conn)
}

/// Takes the write lock before reading the version, so a second process that opened the same
/// file at the same old version finds it already migrated and skips instead of failing.
fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version: i64 = tx.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version >= USER_VERSION {
        return Ok(());
    }
    // Older rows may be gone from a rewritten session file, so an older file is altered, not rebuilt.
    let ddl = match version {
        2 => format!("{MIGRATE_2_TO_3}{MIGRATE_3_TO_4}{MIGRATE_4_TO_5}{MIGRATE_5_TO_6}"),
        3 => format!("{MIGRATE_3_TO_4}{MIGRATE_4_TO_5}{MIGRATE_5_TO_6}"),
        4 => format!("{MIGRATE_4_TO_5}{MIGRATE_5_TO_6}"),
        5 => MIGRATE_5_TO_6.to_string(),
        _ => DDL.to_string(),
    };
    tx.execute_batch(&format!("{ddl}PRAGMA user_version = {USER_VERSION};"))?;
    if (MIN_MIGRATABLE..=4).contains(&version) {
        migrate_saved_filter(&tx)?;
    }
    tx.commit()
}

/// A saved Project filter holds a name before version 5, and the filter now takes an id: the name
/// becomes its `@legacy:` id (which relabel later maps), or the filter is cleared when it is empty.
fn migrate_saved_filter(conn: &Connection) -> rusqlite::Result<()> {
    let has_prefs: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'prefs')",
        [],
        |row| row.get(0),
    )?;
    if !has_prefs {
        return Ok(());
    }
    let Some(stored) = prefs_get(conn, PREF_FILTERS)? else {
        return Ok(());
    };
    let Ok(mut filters) = serde_json::from_str::<serde_json::Value>(&stored) else {
        return Ok(());
    };
    let Some(object) = filters.as_object_mut() else {
        return Ok(());
    };
    let rewritten = match object.get("project") {
        None | Some(serde_json::Value::Null) => return Ok(()),
        Some(serde_json::Value::String(name)) if !name.trim().is_empty() => {
            serde_json::Value::String(format!("{LEGACY_PREFIX}{name}"))
        }
        Some(_) => serde_json::Value::Null,
    };
    object.insert("project".into(), rewritten);
    prefs_set(conn, PREF_FILTERS, &filters.to_string())
}

fn is_rebuildable(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(f, _)
            if matches!(f.code, ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt)
    )
}

/// Renames the database and its WAL side files aside.
fn quarantine(path: &Path) {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for suffix in ["", "-wal", "-shm"] {
        let mut from = path.as_os_str().to_owned();
        from.push(suffix);
        let from = PathBuf::from(from);
        if !from.exists() {
            continue;
        }
        let mut to = path.as_os_str().to_owned();
        to.push(format!(".bak-{stamp}{suffix}"));
        if let Err(err) = std::fs::rename(&from, PathBuf::from(to)) {
            log::warn!("usage.db: could not set aside {from:?}: {err}");
        }
    }
}

/// One JSON-encoded preference.
pub fn prefs_get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM prefs WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .optional()
}

pub fn prefs_set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO prefs (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
}

#[cfg(test)]
#[path = "schema.test.rs"]
mod tests;
