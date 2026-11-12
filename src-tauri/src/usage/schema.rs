// `usage.db` is derived data: a corrupt or newer-version file is renamed aside, never repaired.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{Connection, ErrorCode, OptionalExtension, TransactionBehavior};

pub const USER_VERSION: i64 = 4;
/// Older files are rebuilt; versions 2 and 3 are migrated in place.
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
  project_label TEXT NOT NULL DEFAULT '',
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
  project_label TEXT NOT NULL DEFAULT '',
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
  result_chars INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  project_label TEXT NOT NULL DEFAULT '',
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
  project_label TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_file, entry_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS message_rollup (
  hour INTEGER NOT NULL,
  project_label TEXT NOT NULL,
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
  PRIMARY KEY (hour, project_label, model, reasoning, agent_type)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS tool_rollup (
  hour INTEGER NOT NULL,
  project_label TEXT NOT NULL,
  tool TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  result_chars INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, project_label, tool, agent_type)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS session_rollup (
  session_file TEXT PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT '',
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  credits REAL NOT NULL DEFAULT 0,
  project_label TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS prefs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts);
CREATE INDEX IF NOT EXISTS messages_project_ts ON messages (project_label, ts);
CREATE INDEX IF NOT EXISTS messages_model_ts ON messages (model, reasoning, ts);
CREATE INDEX IF NOT EXISTS tool_calls_tool_ts ON tool_calls (tool, ts);
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
    // Older rows may be gone from a rewritten session file, so a version 2 or 3 file is altered, not rebuilt.
    let ddl = match version {
        2 => format!("{MIGRATE_2_TO_3}{MIGRATE_3_TO_4}"),
        3 => MIGRATE_3_TO_4.to_string(),
        _ => DDL.to_string(),
    };
    tx.execute_batch(&format!("{ddl}PRAGMA user_version = {USER_VERSION};"))?;
    tx.commit()
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
