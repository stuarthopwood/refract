// Which shell a terminal tab starts (FR-005, R-4): PowerShell 7 when it is on `PATH`, else Windows
// PowerShell, else `%COMSPEC%`. Lookups go through `ShellEnv` so tests need no real shells.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The saved form of a tab's shell (`pwsh` | `powershell` | `cmd`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellKind {
    Pwsh,
    Powershell,
    Cmd,
}

impl ShellKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ShellKind::Pwsh => "pwsh",
            ShellKind::Powershell => "powershell",
            ShellKind::Cmd => "cmd",
        }
    }

    /// Parses a saved value; anything unknown becomes `Powershell` (data-model.md, saved tab record).
    pub fn parse_saved(value: &str) -> Self {
        match value {
            "pwsh" => ShellKind::Pwsh,
            "cmd" => ShellKind::Cmd,
            _ => ShellKind::Powershell,
        }
    }
}

/// A shell to spawn: what it is and the absolute path of its executable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedShell {
    pub kind: ShellKind,
    pub path: PathBuf,
}

/// The only environment the terminal adds to the app's own; nothing else is injected.
pub const ADDED_ENV: [(&str, &str); 2] = [("TERM", "xterm-256color"), ("COLORTERM", "truecolor")];

/// The two facts shell resolution reads from the machine.
pub trait ShellEnv {
    fn var(&self, name: &str) -> Option<OsString>;
    fn is_file(&self, path: &Path) -> bool;
}

/// The real machine.
pub struct SystemEnv;

impl ShellEnv for SystemEnv {
    fn var(&self, name: &str) -> Option<OsString> {
        std::env::var_os(name)
    }

    // `symlink_metadata` so a Store-installed `pwsh.exe` (an app-execution alias, a reparse point that
    // `metadata` cannot follow) still counts as present.
    fn is_file(&self, path: &Path) -> bool {
        std::fs::symlink_metadata(path).is_ok_and(|meta| !meta.is_dir())
    }
}

/// `pwsh.exe` -> Windows PowerShell -> `%COMSPEC%`. `None` only when none of the three exists.
pub fn resolve_shell(env: &dyn ShellEnv) -> Option<ResolvedShell> {
    if let Some(path) = find_pwsh_on_path(env) {
        return Some(ResolvedShell {
            kind: ShellKind::Pwsh,
            path,
        });
    }
    let system_root = env
        .var("SystemRoot")
        .filter(|root| Path::new(root).is_absolute())
        .map(PathBuf::from);
    if let Some(root) = &system_root {
        let powershell = root
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        if env.is_file(&powershell) {
            return Some(ResolvedShell {
                kind: ShellKind::Powershell,
                path: powershell,
            });
        }
    }
    let comspec = env
        .var("COMSPEC")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && env.is_file(path))
        .or_else(|| {
            system_root
                .map(|root| root.join("System32").join("cmd.exe"))
                .filter(|path| env.is_file(path))
        })?;
    Some(ResolvedShell {
        kind: ShellKind::Cmd,
        path: comspec,
    })
}

// Only absolute `PATH` entries count: an empty or relative entry means the current directory, where a
// planted `pwsh.exe` would run with the user's rights.
fn find_pwsh_on_path(env: &dyn ShellEnv) -> Option<PathBuf> {
    let path_var = env.var("PATH")?;
    std::env::split_paths(&path_var)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join("pwsh.exe"))
        .find(|candidate| env.is_file(candidate))
}

#[cfg(test)]
#[path = "shell.test.rs"]
mod tests;
