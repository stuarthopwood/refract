// Clone destination rules: validated and resolved to one literal canonical path before the child
// starts; cleanup removes only that path, and only if this attempt created it.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

const NOT_EMPTY: &str = "That folder already exists and isn't empty.";
const REMOVE_ATTEMPTS: u32 = 5;
const REMOVE_RETRY_DELAY: Duration = Duration::from_millis(300);

#[derive(Debug)]
pub enum DestinationError {
    Invalid(String),
    NotEmpty,
}

impl DestinationError {
    pub fn message(&self) -> &str {
        match self {
            Self::Invalid(message) => message,
            Self::NotEmpty => NOT_EMPTY,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Destination {
    /// The literal, canonicalised path handed to `gh` and recorded for cleanup.
    pub path: PathBuf,
    /// The folder already existed (empty). It is never removed or emptied by cleanup.
    pub existed: bool,
}

fn invalid(message: &str) -> DestinationError {
    DestinationError::Invalid(message.to_string())
}

/// Case-insensitive comparison key for a path (Windows paths are case-insensitive).
pub fn path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn is_reserved_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || (stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && stem.as_bytes()[3].is_ascii_digit())
}

fn inside_project(path: &Path, project_paths: &[String]) -> bool {
    let key = path_key(path);
    project_paths
        .iter()
        .any(|p| key.starts_with(&format!("{}\\", path_key(Path::new(p)))))
}

fn same_as_project(path: &Path, project_paths: &[String]) -> bool {
    let key = path_key(path);
    project_paths.iter().any(|p| path_key(Path::new(p)) == key)
}

/// Rejects relative paths, drive roots, reserved names, UNC prefixes, the home folder, `.git`, and
/// Project paths; an existing non-empty folder is refused, an empty one flagged as pre-existing.
pub async fn validate(
    raw: &str,
    project_paths: &[String],
) -> Result<Destination, DestinationError> {
    let text = raw.trim();
    if text.is_empty() || text.chars().any(char::is_control) {
        return Err(invalid("Choose a folder to clone into."));
    }
    let path = PathBuf::from(text);
    if !path.is_absolute() || text.starts_with(r"\\") || text.starts_with("//") {
        return Err(invalid(
            "Choose a full folder path, for example C:\\Projects\\name.",
        ));
    }
    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(invalid("The folder path can't contain . or .. segments."));
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| invalid("Choose a folder inside a drive, not the drive itself."))?
        .to_string();
    if name.contains(':')
        || name.ends_with('.')
        || name.ends_with(' ')
        || is_reserved_device_name(&name)
    {
        return Err(invalid("That folder name isn't allowed on Windows."));
    }
    let parent = path
        .parent()
        .ok_or_else(|| invalid("Choose a folder inside a drive, not the drive itself."))?;
    match tokio::fs::metadata(parent).await {
        Ok(meta) if meta.is_dir() => {}
        _ => return Err(invalid("The parent folder doesn't exist.")),
    }
    let canonical_parent =
        dunce::canonicalize(parent).map_err(|_| invalid("Couldn't read the parent folder."))?;
    let resolved = canonical_parent.join(&name);
    if resolved
        .components()
        .any(|c| c.as_os_str().eq_ignore_ascii_case(".git"))
    {
        return Err(invalid("Choose a folder outside a .git folder."));
    }
    if resolved.parent().is_none() {
        return Err(invalid(
            "Choose a folder inside a drive, not the drive itself.",
        ));
    }
    if dirs::home_dir().is_some_and(|home| path_key(&home) == path_key(&resolved)) {
        return Err(invalid(
            "Choose a folder inside your home folder, not the home folder itself.",
        ));
    }
    if same_as_project(&resolved, project_paths) {
        return Err(invalid("That folder is already a project."));
    }
    if inside_project(&resolved, project_paths) {
        return Err(invalid("That folder is inside an existing project."));
    }
    let existed = match tokio::fs::symlink_metadata(&resolved).await {
        Ok(meta) => {
            if meta.is_symlink() || !meta.is_dir() {
                return Err(DestinationError::NotEmpty);
            }
            let mut entries = tokio::fs::read_dir(&resolved)
                .await
                .map_err(|_| invalid("Couldn't read that folder."))?;
            if entries
                .next_entry()
                .await
                .map(|e| e.is_some())
                .unwrap_or(true)
            {
                return Err(DestinationError::NotEmpty);
            }
            true
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err(invalid("Couldn't read that folder.")),
    };
    Ok(Destination {
        path: resolved,
        existed,
    })
}

/// Creates `path` exclusively (non-recursive), closing the gap between `validate` and the clone.
/// An already-existing folder is `NotEmpty`.
pub async fn create_exclusive(path: &Path) -> Result<(), DestinationError> {
    match tokio::fs::create_dir(path).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(DestinationError::NotEmpty)
        }
        Err(_) => Err(invalid("Couldn't create that folder.")),
    }
}

/// Removes only `path`, the clone folder this attempt created. Refuses a root, the home folder,
/// a Project path, or any parent of one; an already-gone path counts as removed (`true`).
pub async fn remove_created(path: &Path, project_paths: &[String]) -> bool {
    if path.file_name().is_none() || !path.is_absolute() {
        return false;
    }
    if let Some(home) = dirs::home_dir() {
        if path_key(&home) == path_key(path) {
            return false;
        }
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    match dunce::canonicalize(parent) {
        Ok(canonical) if path_key(&canonical) == path_key(parent) => {}
        _ => return false,
    }
    let key = path_key(path);
    let guarded = project_paths.iter().any(|p| {
        let project = path_key(Path::new(p));
        project == key || project.starts_with(&format!("{key}\\"))
    });
    if guarded {
        return false;
    }
    for attempt in 0..REMOVE_ATTEMPTS {
        match tokio::fs::symlink_metadata(path).await {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) => return false,
            Ok(meta) if meta.is_symlink() || !meta.is_dir() => return false,
            Ok(_) => {}
        }
        if tokio::fs::remove_dir_all(path).await.is_ok() {
            return true;
        }
        if attempt + 1 < REMOVE_ATTEMPTS {
            tokio::time::sleep(REMOVE_RETRY_DELAY).await;
        }
    }
    false
}
