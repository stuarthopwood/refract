// The per-Session checklist store. One lock per Session is held across load, apply, write and swap,
// so the agent's tool and the developer's panel serialise. The apply runs on a clone and the clone
// replaces the in-memory file only after it reached disk, so a failed write changes nothing.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tokio::sync::Mutex as AsyncMutex;

use super::model::ChecklistFile;
use super::ops::ChecklistError;
use super::records::settle_all;
use super::store_load::{load, LoadError};
use crate::store::atomic_json::write_json_file;

const MAX_SESSION_ID_BYTES: usize = 128;

/// Why a store call failed: unknown or ending Session, bad id, or a load or write error.
#[derive(Debug)]
pub enum StoreError {
    /// Not a live Session, or an id that cannot name a file.
    UnknownSession,
    SessionDeleting,
    /// A delete removed this Session's entry; nothing may recreate it.
    Tombstoned,
    /// The file on disk was written by a newer build.
    StoreUnsupported,
    StoreFailed(io::Error),
    Op(ChecklistError),
}

/// Proof that an id came from the live registry and is not being deleted. The store takes this
/// instead of a string, so no caller-supplied text becomes a file path.
#[derive(Debug)]
pub struct LiveSession {
    id: String,
}

impl LiveSession {
    /// Verifies a Session id is live before any file access.
    pub fn check(
        id: &str,
        is_live: impl FnOnce(&str) -> bool,
        is_deleting: impl FnOnce(&str) -> bool,
    ) -> Result<Self, StoreError> {
        if !is_live(id) {
            return Err(StoreError::UnknownSession);
        }
        if is_deleting(id) {
            return Err(StoreError::SessionDeleting);
        }
        Ok(Self { id: id.to_string() })
    }

    /// The Session id this witness was checked for.
    pub fn id(&self) -> &str {
        &self.id
    }
}

enum Slot {
    Unloaded,
    Loaded(Box<ChecklistFile>),
    Tombstoned,
}

type SlotHandle = Arc<AsyncMutex<Slot>>;

/// Per-Session checklist files with one lock each and clone-apply-write-swap updates.
pub struct ChecklistStore {
    dir: PathBuf,
    slots: Mutex<HashMap<String, SlotHandle>>,
    /// Sessions whose omp refused the Refract tools, so the panel can say the agent cannot use a checklist.
    tool_unavailable: Mutex<HashSet<String>>,
}

/// A second guard behind the registry: even a live id never reaches the path unless it is plain.
fn is_plain_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_SESSION_ID_BYTES
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl ChecklistStore {
    /// A store rooted at the given directory.
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            slots: Mutex::new(HashMap::new()),
            tool_unavailable: Mutex::new(HashSet::new()),
        }
    }

    /// Marks a Session's agent as unable to call `refract_checklist`.
    pub fn set_tool_unavailable(&self, id: &str) {
        self.unavailable().insert(id.to_string());
    }

    /// Clears the mark once the tool is known to work for the Session.
    pub fn clear_tool_unavailable(&self, id: &str) {
        self.unavailable().remove(id);
    }

    /// Whether the Session's agent was refused the checklist tool.
    pub fn tool_unavailable(&self, id: &str) -> bool {
        self.unavailable().contains(id)
    }

    fn unavailable(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.tool_unavailable
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// The file path for a Session id, refusing anything that is not a plain id.
    pub fn session_file(&self, id: &str) -> Result<PathBuf, StoreError> {
        if !is_plain_id(id) {
            return Err(StoreError::UnknownSession);
        }
        Ok(self.dir.join(format!("{id}.json")))
    }

    fn slot(&self, id: &str) -> SlotHandle {
        let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(
            slots
                .entry(id.to_string())
                .or_insert_with(|| Arc::new(AsyncMutex::new(Slot::Unloaded))),
        )
    }

    /// Clone, apply to the clone, write, then swap. An engine error or a failed write leaves the
    /// stored checklist as it was. An apply that changes nothing writes nothing.
    pub async fn apply<R, F>(&self, live: &LiveSession, apply: F) -> Result<R, StoreError>
    where
        F: FnOnce(&mut ChecklistFile) -> Result<R, ChecklistError>,
    {
        let path = self.session_file(&live.id)?;
        let handle = self.slot(&live.id);
        let mut slot = handle.lock().await;
        ensure_loaded(&mut slot, &path).await?;
        let Slot::Loaded(current) = &*slot else {
            unreachable!("ensure_loaded leaves the slot loaded");
        };
        let mut next = ChecklistFile::clone(current);
        let out = apply(&mut next).map_err(StoreError::Op)?;
        if next != **current {
            write_json_file(&path, &next)
                .await
                .map_err(StoreError::StoreFailed)?;
            *slot = Slot::Loaded(Box::new(next));
        }
        Ok(out)
    }

    /// Runs the apply on its own task and awaits it, so dropping the caller (a cancelled tool call)
    /// cannot stop the apply halfway.
    pub async fn apply_detached<R, F>(
        self: &Arc<Self>,
        live: LiveSession,
        apply: F,
    ) -> Result<R, StoreError>
    where
        R: Send + 'static,
        F: FnOnce(&mut ChecklistFile) -> Result<R, ChecklistError> + Send + 'static,
    {
        self.apply_detached_then(live, apply, |_| {}).await
    }

    /// Like `apply_detached`, with `after_write` run on the same task once the apply succeeded, so
    /// a write that landed is announced even when the caller was dropped meanwhile.
    pub async fn apply_detached_then<R, F, H>(
        self: &Arc<Self>,
        live: LiveSession,
        apply: F,
        after_write: H,
    ) -> Result<R, StoreError>
    where
        R: Send + 'static,
        F: FnOnce(&mut ChecklistFile) -> Result<R, ChecklistError> + Send + 'static,
        H: FnOnce(&R) + Send + 'static,
    {
        let store = Arc::clone(self);
        tokio::spawn(async move {
            let out = store.apply(&live, apply).await?;
            after_write(&out);
            Ok(out)
        })
        .await
        .unwrap_or_else(|_| {
            Err(StoreError::StoreFailed(io::Error::other(
                "apply task failed",
            )))
        })
    }

    /// Reads a Session's checklist under its lock.
    pub async fn read<R>(
        &self,
        live: &LiveSession,
        read: impl FnOnce(&ChecklistFile) -> R,
    ) -> Result<R, StoreError> {
        let path = self.session_file(&live.id)?;
        let handle = self.slot(&live.id);
        let mut slot = handle.lock().await;
        ensure_loaded(&mut slot, &path).await?;
        let Slot::Loaded(current) = &*slot else {
            unreachable!("ensure_loaded leaves the slot loaded");
        };
        Ok(read(current))
    }

    /// Removes a deleted Session's file and tombstones its entry under the Session lock, so an
    /// in-flight call that already holds a witness cannot write the file back afterwards.
    pub async fn discard(&self, id: &str) -> io::Result<()> {
        self.clear_tool_unavailable(id);
        let path = self
            .session_file(id)
            .map_err(|_| io::Error::other("not a plain Session id"))?;
        let handle = self.slot(id);
        let mut slot = handle.lock().await;
        *slot = Slot::Tombstoned;
        match tokio::fs::remove_file(&path).await {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }
}

async fn ensure_loaded(slot: &mut Slot, path: &std::path::Path) -> Result<(), StoreError> {
    match slot {
        Slot::Tombstoned => Err(StoreError::Tombstoned),
        Slot::Loaded(_) => Ok(()),
        Slot::Unloaded => {
            let mut file = load(path).await.map_err(|e| match e {
                LoadError::Unsupported => StoreError::StoreUnsupported,
                LoadError::Io(err) => StoreError::StoreFailed(err),
            })?;
            // A first load means the process just started, so no turn can still be pending.
            settle_all(&mut file);
            *slot = Slot::Loaded(Box::new(file));
            Ok(())
        }
    }
}

#[cfg(test)]
#[path = "store.test.rs"]
mod tests;
