// Stable Project id (and its display name) of a session file, from the `cwd` in its session header.

use std::collections::HashMap;
use std::path::Path;

use crate::git::worktrees::worktrees_root;
use crate::store::registry::Registry;

/// Display name of the shared bucket for scratch runs: temp folders and worktrees whose Project is not registered.
pub const OTHER_LABEL: &str = "Other";
/// Ids that are not registry Project ids start with `@`, so none can collide with a repository id.
pub const OTHER_ID: &str = "@other";
pub const PERSONAL_ID: &str = "@personal";
pub const PERSONAL_LABEL: &str = "Personal";
/// Prefix of the ids the v5 migration derives from a stored name; relabel resolves them to real ids.
pub const LEGACY_PREFIX: &str = "@legacy:";
const FOLDER_PREFIX: &str = "@folder:";
const WORKTREES_DIR: &str = "pinion-worktrees";

/// A registry Project id or the Personal bucket: attribution that survives the Project's removal.
pub fn is_stable_id(id: &str) -> bool {
    id == PERSONAL_ID || (!id.is_empty() && !id.starts_with('@'))
}

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

/// A stable Project id and the name it is shown under now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRef {
    pub id: String,
    pub name: String,
}

/// How a cwd or session folder is attributed in the Usage view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolved {
    Project(ProjectRef),
    /// The Personal Agent's Sessions, which have no Project.
    Personal,
    Other,
    /// An unmatched folder, shown by its name.
    Folder(String),
}

impl Resolved {
    pub fn into_ref(self) -> ProjectRef {
        match self {
            Self::Project(project) => project,
            Self::Personal => ProjectRef {
                id: PERSONAL_ID.to_string(),
                name: PERSONAL_LABEL.to_string(),
            },
            Self::Other => ProjectRef {
                id: OTHER_ID.to_string(),
                name: OTHER_LABEL.to_string(),
            },
            Self::Folder(name) => ProjectRef {
                id: format!("{FOLDER_PREFIX}{}", name.to_lowercase()),
                name,
            },
        }
    }
}

/// Projects, their worktrees roots and Worktrees as `(normalised path, Project id)` pairs, plus each
/// registered id's current name.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectIndex {
    entries: Vec<(String, String)>,
    names: HashMap<String, String>,
    /// Normalised home folder: the Personal Agent's cwd, matched exactly since every other
    /// folder under it is just a folder.
    personal_home: Option<String>,
    /// Normalised temp folders; the process temp dir can be an 8.3 short path, so
    /// `AppData\Local\Temp` is matched by segment as well.
    temp_roots: Vec<String>,
}

impl ProjectIndex {
    /// Test helper: each name doubles as its id.
    #[cfg(test)]
    pub fn from_pairs<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        Self::from_triples(
            pairs
                .into_iter()
                .map(|(path, name)| (path.to_string(), name.to_string(), name.to_string())),
        )
    }

    /// `(path, project id, project name)` entries; a name belongs to its id, not to the path.
    pub fn from_triples(triples: impl IntoIterator<Item = (String, String, String)>) -> Self {
        let mut names = HashMap::new();
        let mut entries: Vec<(String, String)> = Vec::new();
        for (path, id, name) in triples {
            names.insert(id.clone(), name);
            let path = normalise_path(&path);
            if !path.is_empty() {
                entries.push((path, id));
            }
        }
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
            names,
            personal_home: None,
            temp_roots,
        }
    }

    /// Attributes a cwd equal to `home` to the Personal bucket.
    pub fn with_personal_home(mut self, home: &str) -> Self {
        let home = normalise_path(home);
        self.personal_home = (!home.is_empty()).then_some(home);
        self
    }

    pub fn from_registry(registry: &Registry) -> Self {
        // A reaped worktree is gone from the registry; its folder still sits under the root.
        let roots = registry
            .repositories
            .iter()
            .filter(|r| Path::new(&r.path).file_name().is_some())
            .map(|r| {
                let root = worktrees_root(Path::new(&r.path));
                (
                    resolve_dots(&normalise_path(&root.to_string_lossy())),
                    r.id.clone(),
                    r.name.clone(),
                )
            });
        let projects = registry
            .repositories
            .iter()
            .map(|r| (r.path.clone(), r.id.clone(), r.name.clone()));
        let worktrees = registry.sessions.iter().filter_map(|s| {
            let binding = s.project_binding()?;
            let repo = registry
                .repositories
                .iter()
                .find(|r| r.id == binding.repository_id)?;
            Some((
                binding.worktree_path.to_string(),
                repo.id.clone(),
                repo.name.clone(),
            ))
        });
        let index = Self::from_triples(projects.chain(worktrees).chain(roots));
        match (
            registry.sessions.iter().any(|s| s.is_personal()),
            dirs::home_dir(),
        ) {
            (true, Some(home)) => index.with_personal_home(&home.to_string_lossy()),
            _ => index,
        }
    }

    /// Every id this index can name, for the `projects` lookup table.
    pub fn known(&self) -> Vec<ProjectRef> {
        let mut refs: Vec<ProjectRef> = self
            .names
            .iter()
            .map(|(id, name)| ProjectRef {
                id: id.clone(),
                name: name.clone(),
            })
            .collect();
        refs.push(Resolved::Personal.into_ref());
        refs.push(Resolved::Other.into_ref());
        refs
    }

    /// The Project id whose path equals `cwd` or contains it.
    pub fn match_cwd(&self, cwd: &str) -> Option<&str> {
        let normalised = normalise_path(cwd);
        if normalised.is_empty() {
            return None;
        }
        self.entries
            .iter()
            .find(|(path, _)| is_within(&normalised, path))
            .map(|(_, id)| id.as_str())
    }

    fn project(&self, id: &str) -> Resolved {
        Resolved::Project(ProjectRef {
            id: id.to_string(),
            name: self.names.get(id).cloned().unwrap_or_default(),
        })
    }

    /// Project, else Personal for the home folder, else `Other` for scratch cwds, else the cwd's folder name.
    pub fn resolve(&self, cwd: &str) -> Resolved {
        if let Some(id) = self.match_cwd(cwd) {
            return self.project(id);
        }
        let normalised = normalise_path(cwd);
        if self.personal_home.as_deref() == Some(normalised.as_str()) {
            return Resolved::Personal;
        }
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
        if let Some((_, id)) = project {
            return self.project(id);
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

    /// Stored attribution: the Project (or Personal / Other / folder) id and its name.
    pub fn project_ref(
        &self,
        cwd: Option<&str>,
        session_file: &Path,
        sessions_root: &Path,
    ) -> ProjectRef {
        self.resolve_for(cwd, session_file, sessions_root)
            .into_ref()
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
pub(crate) fn resolve_dots(normalised: &str) -> String {
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
