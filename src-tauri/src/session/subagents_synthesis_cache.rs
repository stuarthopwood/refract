// Disk cache of the synthesis per `toolCallId`, in the Session's data folder (ADR 0013 Q4). Replay and
// restart read it, and a history item with no entry stays unlabelled: nothing synthesises on render.

use std::collections::HashMap;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::Value;

use super::subagents_synthesis::Synthesis;
use crate::checklist::store::is_plain_id;
use crate::omp::transcript::synthesis_labels::{SubagentLabels, SynthesisLookup};

const CACHE_FILE: &str = "subagent-synthesis.json";
/// A cache holds a few short labels per `task()` call; a larger file was not written by this code.
const MAX_FILE_BYTES: u64 = 1_048_576;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// `<data_dir>/sessions/<session_id>`, or `None` for an id that is not a plain id.
pub fn session_cache_dir(data_dir: &Path, session_id: &str) -> Option<PathBuf> {
    is_plain_id(session_id).then(|| data_dir.join("sessions").join(session_id))
}

/// Deletes the Session's cache file, any leftover temp file and then its folder when that is empty;
/// never a recursive remove. Best-effort, because a leftover file is only an orphan.
pub async fn remove_session_cache(data_dir: &Path, session_id: &str) {
    let Some(dir) = session_cache_dir(data_dir, session_id) else {
        return;
    };
    let _ = tokio::task::spawn_blocking(move || {
        let _ = std::fs::remove_file(dir.join(CACHE_FILE));
        for tmp in leftover_tmp_files(&dir) {
            let _ = std::fs::remove_file(tmp);
        }
        let _ = std::fs::remove_dir(&dir);
    })
    .await;
}

/// Which snapshot reached the disk last, shared by the cache and its pending writes so one lock
/// serialises the writers and a stale snapshot can never replace a newer file.
#[derive(Debug, Default)]
struct WriterState {
    written: u64,
    /// Set when the Session is deleted, so a write still in flight cannot recreate its folder.
    discarded: bool,
}

type SharedWriter = Arc<Mutex<WriterState>>;

fn lock_writer(writer: &SharedWriter) -> MutexGuard<'_, WriterState> {
    // The state is two plain fields, so a panic in a writer cannot leave it half-updated.
    writer.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The syntheses of one Session, held in memory and mirrored to one JSON file.
#[derive(Debug)]
pub struct SynthesisCache {
    file: PathBuf,
    entries: HashMap<String, Synthesis>,
    version: u64,
    writer: SharedWriter,
}

/// One serialised snapshot to put on disk. It is made under the cache's lock and written after the
/// lock is released, so a slow disk never blocks a transcript frame reading the labels.
#[derive(Debug)]
pub struct PendingWrite {
    file: PathBuf,
    data: Vec<u8>,
    version: u64,
    writer: SharedWriter,
}

impl SynthesisCache {
    /// A missing, oversized or corrupt file is an empty cache; one corrupt entry drops only itself.
    pub fn load(session_dir: &Path) -> Self {
        let file = session_dir.join(CACHE_FILE);
        for tmp in leftover_tmp_files(session_dir) {
            let _ = std::fs::remove_file(tmp);
        }
        let entries = read_capped(&file)
            .and_then(|bytes| serde_json::from_slice::<HashMap<String, Value>>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(id, value)| {
                let synthesis: Synthesis = serde_json::from_value(value).ok()?;
                Some((id, synthesis.clamped()))
            })
            .collect();
        Self {
            file,
            entries,
            version: 0,
            writer: SharedWriter::default(),
        }
    }

    /// The cached labels for one `task()` call.
    pub fn get(&self, tool_call_id: &str) -> Option<&Synthesis> {
        self.entries.get(tool_call_id)
    }

    /// Keeps the entry in memory, so the same call is not synthesised twice even if the write fails.
    pub fn insert(&mut self, tool_call_id: &str, synthesis: Synthesis) -> io::Result<PendingWrite> {
        self.entries.insert(tool_call_id.to_string(), synthesis);
        self.version += 1;
        Ok(PendingWrite {
            file: self.file.clone(),
            data: serde_json::to_vec_pretty(&self.entries)?,
            version: self.version,
            writer: self.writer.clone(),
        })
    }

    /// Refuses every later write. Waits for a write in flight, so none lands after the folder is removed.
    pub fn discard(&self) {
        lock_writer(&self.writer).discarded = true;
    }
}

impl PendingWrite {
    /// Temp file, flush, then rename, so a crash never leaves a torn cache. A snapshot older than the
    /// one on disk is skipped: every snapshot holds all earlier entries.
    pub fn write(self) -> io::Result<()> {
        let mut state = lock_writer(&self.writer);
        if state.discarded || self.version <= state.written {
            return Ok(());
        }
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut tmp_name = self.file.as_os_str().to_os_string();
        tmp_name.push(format!(".{}.{n}.tmp", std::process::id()));
        let tmp = PathBuf::from(tmp_name);
        let written =
            write_synced(&tmp, &self.data).and_then(|()| std::fs::rename(&tmp, &self.file));
        if written.is_err() {
            let _ = std::fs::remove_file(&tmp);
            return written;
        }
        state.written = self.version;
        Ok(())
    }
}

impl SynthesisLookup for SynthesisCache {
    fn labels(&self, tool_call_id: &str, spec_index: u32) -> SubagentLabels {
        self.get(tool_call_id)
            .map(|synthesis| SubagentLabels {
                role: synthesis.roles.get(spec_index as usize).cloned().flatten(),
                overall_goal: synthesis.overall_goal.clone(),
            })
            .unwrap_or_default()
    }
}

/// The file's bytes, or `None` when it is missing, unreadable or over the cap. Reads one byte past
/// the cap, so a file that grew after a size check still cannot be read whole.
fn read_capped(file: &Path) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    std::fs::File::open(file)
        .ok()?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= MAX_FILE_BYTES).then_some(bytes)
}

/// A crash between the temp write and the rename leaves `<file>.<pid>.<n>.tmp` behind.
fn leftover_tmp_files(dir: &Path) -> Vec<PathBuf> {
    let prefix = format!("{CACHE_FILE}.");
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    read.filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.starts_with(&prefix) && name.ends_with(".tmp")
        })
        .map(|entry| entry.path())
        .collect()
}

fn write_synced(path: &Path, data: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::File::create(path)?;
    file.write_all(data)?;
    file.sync_all()
}

#[cfg(test)]
#[path = "subagents_synthesis_cache.test.rs"]
mod tests;
