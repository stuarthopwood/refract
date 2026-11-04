// Project label of a session file, from the `cwd` in its session header.

use std::path::Path;

use crate::git::worktrees::worktrees_root;
use crate::store::registry::Registry;

/// One shared bucket for scratch runs: temp folders and worktrees whose Project is not registered.
pub const OTHER_LABEL: &str = "Other";
const WORKTREES_DIR: &str = "pinion-worktrees";

/// Normalises a path for comparison: strips `\\?\`, folds slashes, lower-cases.
pub fn normalise_path(raw: &str) -> String {
    let trimmed = raw.trim();
    let without_prefix = trimmed
        .strip_prefix(r"\\?\")
        .or_else(|| trimmed.strip_prefix("//?/"))
        .unwrap_or(trimmed);
    let folded = without_prefix.replace('/', "\\").to_lowercase();
    folded.trim_end_matches('\\').to_string()
}

/// How a cwd or session folder is shown in the Usage view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolved {
    Project(String),
    Other,
    /// An unmatched folder, shown by its name.
    Folder(String),
}

impl Resolved {
    pub fn into_label(self) -> String {
        match self {
            Self::Project(name) | Self::Folder(name) => name,
            Self::Other => OTHER_LABEL.to_string(),
        }
    }
}

/// Projects, their worktrees roots and Worktrees as `(normalised path, Project name)` pairs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectIndex {
    entries: Vec<(String, String)>,
    /// Normalised temp folders; the process temp dir can be an 8.3 short path, so
    /// `AppData\Local\Temp` is matched by segment as well.
    temp_roots: Vec<String>,
}

impl ProjectIndex {
    pub fn from_pairs<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        Self::from_owned(
            pairs
                .into_iter()
                .map(|(path, name)| (path.to_string(), name.to_string()))
                .collect(),
        )
    }

    fn from_owned(pairs: Vec<(String, String)>) -> Self {
        let mut entries: Vec<(String, String)> = pairs
            .into_iter()
            .map(|(path, name)| (normalise_path(&path), name))
            .filter(|(path, _)| !path.is_empty())
            .collect();
        // Longest first, so a nested Worktree wins over its parent Project.
        entries.sort_by_key(|(path, _)| std::cmp::Reverse(path.len()));
        let temp_roots = [
            normalise_path(&std::env::temp_dir().to_string_lossy()),
            r"c:\tmp".to_string(),
            r"\tmp".to_string(),
        ]
        .into_iter()
        .filter(|root| !root.is_empty())
        .collect();
        Self {
            entries,
            temp_roots,
        }
    }

    pub fn from_registry(registry: &Registry) -> Self {
        let names: std::collections::HashMap<&str, &str> = registry
            .repositories
            .iter()
            .map(|r| (r.id.as_str(), r.name.as_str()))
            .collect();
        // A reaped worktree is gone from the registry; its folder still sits under the root.
        let roots = registry
            .repositories
            .iter()
            .filter(|r| Path::new(&r.path).file_name().is_some())
            .map(|r| {
                let root = worktrees_root(Path::new(&r.path));
                (
                    resolve_dots(&normalise_path(&root.to_string_lossy())),
                    r.name.clone(),
                )
            });
        let projects = registry
            .repositories
            .iter()
            .map(|r| (r.path.clone(), r.name.clone()));
        let worktrees = registry.sessions.iter().filter_map(|s| {
            names
                .get(s.repository_id.as_str())
                .map(|name| (s.worktree_path.clone(), (*name).to_string()))
        });
        Self::from_owned(projects.chain(worktrees).chain(roots).collect())
    }

    /// The Project name whose path equals `cwd` or contains it.
    pub fn match_cwd(&self, cwd: &str) -> Option<&str> {
        let normalised = normalise_path(cwd);
        if normalised.is_empty() {
            return None;
        }
        self.entries
            .iter()
            .find(|(path, _)| is_within(&normalised, path))
            .map(|(_, name)| name.as_str())
    }

    /// Project, else `Other` for scratch cwds, else the cwd's folder name.
    pub fn resolve(&self, cwd: &str) -> Resolved {
        if let Some(name) = self.match_cwd(cwd) {
            return Resolved::Project(name.to_string());
        }
        let normalised = normalise_path(cwd);
        if self.is_scratch(&normalised) {
            return Resolved::Other;
        }
        Resolved::Folder(last_component(cwd))
    }

    /// Resolves an OMP session folder name (`--C--Repos-Work-x--`, the cwd with `:` and `\`
    /// turned into `-`). The encoding is lossy, so a Project matches when its own encoded
    /// path equals the folder or prefixes it at a hyphen, unless the rest starts a worktrees folder.
    pub fn resolve_folder(&self, folder: &str) -> Resolved {
        let Some(inner) = encoded_inner(folder) else {
            return Resolved::Folder(folder.to_string());
        };
        let project = self.entries.iter().find(|(path, _)| {
            encoded_remainder(&inner, &encode_cwd(path))
                .is_some_and(|rest| !rest.starts_with("worktrees"))
        });
        if let Some((_, name)) = project {
            return Resolved::Project(name.clone());
        }
        if self.is_scratch_encoded(&inner) {
            return Resolved::Other;
        }
        Resolved::Folder(decoded_name(folder))
    }

    /// Resolves from the cwd when the header has one, else from the session folder name.
    pub fn resolve_for(
        &self,
        cwd: Option<&str>,
        session_file: &Path,
        sessions_root: &Path,
    ) -> Resolved {
        match cwd.map(str::trim).filter(|c| !c.is_empty()) {
            Some(cwd) => self.resolve(cwd),
            None => self.resolve_folder(&folder_name_fallback(session_file, sessions_root)),
        }
    }

    /// Stored label: Project name, `Other`, or the folder name.
    pub fn label(&self, cwd: Option<&str>, session_file: &Path, sessions_root: &Path) -> String {
        self.resolve_for(cwd, session_file, sessions_root)
            .into_label()
    }

    fn is_scratch(&self, normalised: &str) -> bool {
        has_segments(normalised, WORKTREES_DIR)
            || has_segments(normalised, r"appdata\local\temp")
            || self
                .temp_roots
                .iter()
                .any(|root| is_within(normalised, root))
    }

    fn is_scratch_encoded(&self, inner: &str) -> bool {
        let padded = format!("-{inner}-");
        padded.contains(&format!("-{WORKTREES_DIR}-"))
            || padded.contains("-appdata-local-temp-")
            || self
                .temp_roots
                .iter()
                .filter(|root| root.contains(':'))
                .any(|root| encoded_remainder(inner, &encode_cwd(root)).is_some())
    }
}

/// `path` equals `root` or sits below it (both normalised).
fn is_within(path: &str, root: &str) -> bool {
    path == root || (path.starts_with(root) && path.as_bytes().get(root.len()) == Some(&b'\\'))
}

/// Whole path segments `seq` (itself `\`-separated) occur in `path`.
fn has_segments(path: &str, seq: &str) -> bool {
    format!("\\{path}\\").contains(&format!("\\{seq}\\"))
}

/// Resolves `.` and `..` textually; `normalise_path` does not, and a worktrees root is built with `..`.
fn resolve_dots(normalised: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in normalised.split('\\') {
        match part {
            "." => {}
            ".." => {
                if parts
                    .last()
                    .is_some_and(|p| !p.is_empty() && !p.ends_with(':'))
                {
                    parts.pop();
                }
            }
            _ => parts.push(part),
        }
    }
    parts.join("\\")
}

fn last_component(cwd: &str) -> String {
    let trimmed = cwd.trim().trim_end_matches(['\\', '/']);
    trimmed
        .rsplit(['\\', '/'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(trimmed)
        .to_string()
}

/// The lower-cased text between the `--` edges of an encoded session folder; `None` otherwise.
pub fn encoded_inner(folder: &str) -> Option<String> {
    let inner = folder.strip_prefix("--")?.strip_suffix("--")?;
    (!inner.is_empty()).then(|| inner.to_lowercase())
}

/// A normalised path the way OMP encodes it in a session folder name.
pub fn encode_cwd(normalised: &str) -> String {
    normalised.replace([':', '\\'], "-")
}

/// What follows `key` in `inner` once the hyphen between them is dropped (`""` when equal).
fn encoded_remainder<'a>(inner: &'a str, key: &str) -> Option<&'a str> {
    let rest = inner.strip_prefix(key)?;
    if rest.is_empty() {
        Some("")
    } else {
        rest.strip_prefix('-')
    }
}

/// Encoded folder text without its edges and drive: `--C--Second-Brain--` is `Second-Brain`.
fn decoded_name(folder: &str) -> String {
    let trimmed = folder.trim_matches('-');
    match trimmed.split_once("--") {
        Some((_, rest)) if !rest.is_empty() => rest.to_string(),
        _ => trimmed.to_string(),
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
