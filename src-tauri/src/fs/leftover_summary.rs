// Issue #891, Stuart's 2026-10-19 grill item 3: "a background walk when the Delete dialog
// opens" listing generated folders (for example `node_modules`) by name with file counts, and
// other files by path, capped with "and N more". Read-only and purely informational -- Delete
// stays enabled throughout (the walk never blocks it), and this module never removes anything;
// that is `fs::remove_tree`'s job.
//
// Deliberately separate from `git::worktree_delete_check`'s own `DeleteCheck`: that is a GIT
// query (uncommitted files, unpushed commits), answered in milliseconds regardless of how much
// the worktree folder itself holds on disk. This is a FILESYSTEM walk that can take real time
// against a full `node_modules` tree (156k files in the issue's own report), so it runs as its
// own independent, cancellable background call (`sessions.deleteLeftoverSummary`) rather than
// slow down `deleteCheck`'s own git-only answer.
//
// Never follows a link (symlink or junction, decided the same way `fs::remove_tree` decides it
// -- `symlink_metadata`'s own `is_symlink()`): a generated-folder bucket under a link reports a
// zero file count rather than walking through it, and the link itself counts as one "other"
// entry. This both keeps the walk fast against pnpm's own junctions inside `node_modules/.pnpm`
// and matches the removal path's own "never descend through a link" rule, so this summary never
// promises to delete more than `remove_tree` will actually touch.

use std::path::Path;

use serde::Serialize;

/// Well-known directory names this summary buckets by NAME (merging every occurrence anywhere
/// in the tree into one entry with a combined file count) rather than listing each one
/// individually by path -- the issue's own example, plus the other common ones a Node/Rust/
/// Python toolchain leaves behind in a worktree.
const GENERATED_FOLDER_NAMES: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    "__pycache__",
    ".venv",
];

/// Caps how many individual "other" files this summary lists by path before folding the rest
/// into `more_count` -- the issue's own "capped list with 'and N more'".
const MAX_OTHER_FILES_LISTED: usize = 50;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedFolderEntry {
    pub name: String,
    pub file_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftoverSummary {
    pub generated_folders: Vec<GeneratedFolderEntry>,
    pub other_files: Vec<String>,
    pub more_count: u64,
}

struct Walker<'a> {
    root: &'a Path,
    generated: std::collections::BTreeMap<String, u64>,
    other_files: Vec<String>,
    more_count: u64,
}

impl<'a> Walker<'a> {
    fn relative(&self, p: &Path) -> String {
        p.strip_prefix(self.root)
            .unwrap_or(p)
            .to_string_lossy()
            .replace('\\', "/")
    }

    fn add_other_file(&mut self, p: &Path) {
        if self.other_files.len() < MAX_OTHER_FILES_LISTED {
            self.other_files.push(self.relative(p));
        } else {
            self.more_count += 1;
        }
    }

    /// Walks `dir` (a plain directory, never a link -- the caller already checked), bucketing
    /// any entry whose name matches `GENERATED_FOLDER_NAMES` and recursing into everything
    /// else.
    fn walk_dir(&mut self, dir: &Path) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.file_type().is_symlink() {
                self.add_other_file(&path);
                continue;
            }
            if meta.is_dir() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name == ".git" {
                    continue;
                }
                if GENERATED_FOLDER_NAMES.contains(&name.as_str()) {
                    let count = count_files(&path);
                    *self.generated.entry(name).or_insert(0) += count;
                } else {
                    self.walk_dir(&path);
                }
            } else {
                self.add_other_file(&path);
            }
        }
    }
}

/// Counts every real file under `dir` (never following a link), for one matched generated-folder
/// bucket. A link anywhere inside counts as zero of its own contents -- consistent with
/// `fs::remove_tree` never descending through one either.
fn count_files(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut count = 0u64;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            count += count_files(&entry.path());
        } else {
            count += 1;
        }
    }
    count
}

fn compute_sync(worktree_path: &Path) -> LeftoverSummary {
    let mut walker = Walker {
        root: worktree_path,
        generated: std::collections::BTreeMap::new(),
        other_files: Vec::new(),
        more_count: 0,
    };
    walker.walk_dir(worktree_path);
    LeftoverSummary {
        generated_folders: walker
            .generated
            .into_iter()
            .map(|(name, file_count)| GeneratedFolderEntry { name, file_count })
            .collect(),
        other_files: walker.other_files,
        more_count: walker.more_count,
    }
}

/// Runs the walk on a blocking-pool thread (plain sync `std::fs`, not `tokio::fs`: bulk
/// directory enumeration is faster synchronously, and this is explicitly the "background walk"
/// the dialog's own "Checking files…" state waits on, never the async runtime's own worker
/// threads). An empty summary for a worktree folder that is not actually there (nothing to
/// report; the dialog simply shows no leftovers at all).
pub async fn compute_leftover_summary(worktree_path: &Path) -> LeftoverSummary {
    let path = worktree_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        if std::fs::symlink_metadata(&path).is_err() {
            return LeftoverSummary {
                generated_folders: Vec::new(),
                other_files: Vec::new(),
                more_count: 0,
            };
        }
        compute_sync(&path)
    })
    .await
    .unwrap_or_else(|_| LeftoverSummary {
        generated_folders: Vec::new(),
        other_files: Vec::new(),
        more_count: 0,
    })
}

