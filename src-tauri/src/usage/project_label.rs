// Spec 060 (S1-06): the Project label of a session file. The `cwd` in the file's `session` entry
// decides: a Refract Project or one of its Worktrees takes the Project's name, any other folder
// shows as its own path. The lossy folder name OMP gives the session folder is the fallback when
// the header is missing.

use std::path::Path;

use crate::store::registry::Registry;

/// Windows-style comparison form: `\\?\` stripped, `/` folded to `\`, trailing separators
/// trimmed, lower-cased.
pub fn normalise_path(raw: &str) -> String {
    let trimmed = raw.trim();
    let without_prefix = trimmed
        .strip_prefix(r"\\?\")
        .or_else(|| trimmed.strip_prefix("//?/"))
        .unwrap_or(trimmed);
    let folded = without_prefix.replace('/', "\\").to_lowercase();
    folded.trim_end_matches('\\').to_string()
}

/// Projects and their Worktrees as `(normalised path, Project name)` pairs.
#[derive(Debug, Clone, Default)]
pub struct ProjectIndex {
    entries: Vec<(String, String)>,
}

impl ProjectIndex {
    pub fn from_pairs<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        let mut entries: Vec<(String, String)> = pairs
            .into_iter()
            .map(|(path, name)| (normalise_path(path), name.to_string()))
            .filter(|(path, _)| !path.is_empty())
            .collect();
        // Longest path first so a Worktree nested under another Project's folder wins.
        entries.sort_by_key(|(path, _)| std::cmp::Reverse(path.len()));
        Self { entries }
    }

    pub fn from_registry(registry: &Registry) -> Self {
        let names: std::collections::HashMap<&str, &str> = registry
            .repositories
            .iter()
            .map(|r| (r.id.as_str(), r.name.as_str()))
            .collect();
        let projects = registry
            .repositories
            .iter()
            .map(|r| (r.path.as_str(), r.name.as_str()));
        let worktrees = registry.sessions.iter().filter_map(|s| {
            names
                .get(s.repository_id.as_str())
                .map(|name| (s.worktree_path.as_str(), *name))
        });
        Self::from_pairs(projects.chain(worktrees))
    }

    /// The Project name whose path equals `cwd` or contains it.
    pub fn match_cwd(&self, cwd: &str) -> Option<&str> {
        let normalised = normalise_path(cwd);
        if normalised.is_empty() {
            return None;
        }
        self.entries
            .iter()
            .find(|(path, _)| {
                normalised == *path
                    || (normalised.starts_with(path.as_str())
                        && normalised.as_bytes().get(path.len()) == Some(&b'\\'))
            })
            .map(|(_, name)| name.as_str())
    }

    /// Project name, else the cwd path itself, else the session folder name under `sessions_root`.
    pub fn label(&self, cwd: Option<&str>, session_file: &Path, sessions_root: &Path) -> String {
        match cwd.map(str::trim).filter(|c| !c.is_empty()) {
            Some(cwd) => self.match_cwd(cwd).unwrap_or(cwd).to_string(),
            None => folder_name_fallback(session_file, sessions_root),
        }
    }
}

/// First folder under the sessions root (OMP's lossy encoding of the cwd), or `unknown`.
pub fn folder_name_fallback(session_file: &Path, sessions_root: &Path) -> String {
    session_file
        .strip_prefix(sessions_root)
        .ok()
        .filter(|rel| rel.components().count() > 1)
        .and_then(|rel| rel.components().next())
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .unwrap_or_else(|| "unknown".to_string())
}

#[cfg(test)]
#[path = "project_label.test.rs"]
mod tests;
