// Spec 060 (S1-03): `usage.db`'s DDL, `PRAGMA user_version`, the rebuild-on-corruption rule and
// the `prefs` table. The file is derived data (ADR 0006): a corrupt file or one written by a newer
// Refract is renamed to `usage.db.bak-<unix-ts>` and recreated, never repaired and never deleted.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{Connection, ErrorCode, OptionalExtension};

pub const USER_VERSION: i64 = 1;

/// `reasoning`, `model` and `project_label` are `''` rather than NULL when unknown so the rollup
/// primary keys stay unique.
const DDL: &str = "
CREATE TABLE IF NOT EXISTS file_offsets (
  session_file TEXT PRIMARY KEY,
  offset INTEGER NOT NULL DEFAULT 0,
  last_modified INTEGER NOT NULL DEFAULT 0,
  session_id TEXT NOT NULL DEFAULT '',
  cwd TEXT,
  agent_type TEXT NOT NULL DEFAULT 'main',
  project_label TEXT NOT NULL DEFAULT '',
  cur_model TEXT NOT NULL DEFAULT '',
  cur_reasoning TEXT NOT NULL DEFAULT ''
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
  cost_share REAL NOT NULL DEFAULT 0,
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
  cost_share REAL NOT NULL DEFAULT 0,
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

/// Serialises create/rebuild so a reader opening while the worker initialises never races the
/// rename of a corrupt file.
static INIT_LOCK: Mutex<()> = Mutex::new(());

/// Opens `path` (creating it), applies pragmas and the schema. A corrupt file or one with a newer
/// `user_version` is set aside as `usage.db.bak-<unix-ts>` and a fresh file is created.
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

/// A connection for queries: the same open path, then `query_only` so a query can never write.
pub fn open_reader(path: &Path) -> rusqlite::Result<Connection> {
    let conn = open_db(path)?;
    conn.pragma_update(None, "query_only", true)?;
    Ok(conn)
}

fn try_open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version > USER_VERSION {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_NOTADB),
            Some("usage.db was written by a newer Refract".to_string()),
        ));
    }
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    if version < USER_VERSION {
        conn.execute_batch(DDL)?;
        conn.pragma_update(None, "user_version", USER_VERSION)?;
    }
    Ok(conn)
}

fn is_rebuildable(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(f, _)
            if matches!(f.code, ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt)
    )
}

/// Renames the database and its `-wal`/`-shm` side files to `<name>.bak-<unix-ts>`.
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

/// One JSON-encoded preference (`jokes`, `filters`).
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
