// Plan mode under rpc-ui (#2116): omp has no plan toggle there and its own plan-mode guard never runs,
// so Refract enforces "plan only" through per-tool approval policy on the launch `--config` overlay.
// omp honours `tools.approval.<tool>` in every approval mode, so `deny` holds even under `yolo`.

use std::io;
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "plan-mode-approval.yml";

/// The built-in tools that change files, from omp 18.22.2 `builtin-names.ts` (`write`, `edit`,
/// `ast_edit`; omp has no separate notebook, rename or delete tool, those go through `edit`).
const WRITE_TOOLS: [&str; 3] = ["write", "edit", "ast_edit"];

/// `bash` cannot be told apart from a file change by name, so it asks every time instead of being denied.
pub fn render() -> String {
    let mut out = String::from("tools:\n  approval:\n");
    for tool in WRITE_TOOLS {
        out.push_str(&format!("    {tool}: deny\n"));
    }
    out.push_str("    bash: prompt\n");
    out
}

pub fn path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// Writes the overlay atomically, unchanged content left alone, and returns its path.
pub async fn write(dir: &Path) -> io::Result<PathBuf> {
    let file = path(dir);
    super::token_guard::write_atomic_if_changed(&file, render().as_bytes()).await?;
    Ok(file)
}

#[cfg(test)]
#[path = "plan_overlay.test.rs"]
mod tests;
