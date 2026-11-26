// Disk cache of the synthesis per `toolCallId`, in the Session's data folder (ADR 0013 Q4). Replay and
// restart read it, and a history item with no entry stays unlabelled: nothing synthesises on render.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;

use super::subagents_synthesis::Synthesis;
use crate::checklist::store::is_plain_id;
use crate::omp::transcript::synthesis_labels::{SubagentLabels, SynthesisLookup};

const CACHE_FILE: &str = "subagent-synthesis.json";

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// `<data_dir>/sessions/<session_id>`, or `None` for an id that is not a plain id.
pub fn session_cache_dir(data_dir: &Path, session_id: &str) -> Option<PathBuf> {
    is_plain_id(session_id).then(|| data_dir.join("sessions").join(session_id))
}

/// The syntheses of one Session, held in memory and mirrored to one JSON file.
#[derive(Debug)]
pub struct SynthesisCache {
    file: PathBuf,
    entries: HashMap<String, Synthesis>,
}

impl SynthesisCache {
    /// A missing or corrupt file is an empty cache; one corrupt entry drops only itself.
    pub fn load(session_dir: &Path) -> Self {
        let file = session_dir.join(CACHE_FILE);
        let entries = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<HashMap<String, Value>>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(id, value)| Some((id, serde_json::from_value(value).ok()?)))
            .collect();
        Self { file, entries }
    }

    /// The cached labels for one `task()` call.
    pub fn get(&self, tool_call_id: &str) -> Option<&Synthesis> {
        self.entries.get(tool_call_id)
    }

    /// Keeps the entry in memory even when the write fails, so the same call is not synthesised twice.
    pub fn insert_and_persist(
        &mut self,
        tool_call_id: &str,
        synthesis: Synthesis,
    ) -> io::Result<()> {
        self.entries.insert(tool_call_id.to_string(), synthesis);
        self.persist()
    }

    /// Temp file, flush, then rename, so a crash never leaves a torn cache.
    fn persist(&self) -> io::Result<()> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let data = serde_json::to_vec_pretty(&self.entries)?;
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut tmp_name = self.file.as_os_str().to_os_string();
        tmp_name.push(format!(".{}.{n}.tmp", std::process::id()));
        let tmp = PathBuf::from(tmp_name);
        let written = write_synced(&tmp, &data).and_then(|()| std::fs::rename(&tmp, &self.file));
        if written.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        written
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

fn write_synced(path: &Path, data: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::File::create(path)?;
    file.write_all(data)?;
    file.sync_all()
}

#[cfg(test)]
#[path = "subagents_synthesis_cache.test.rs"]
mod tests;
