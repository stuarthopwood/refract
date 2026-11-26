// Plan mode under rpc-ui (#2116): omp has no plan toggle there and its own plan-mode guard never runs,
// so Refract enforces "plan only" through per-tool approval policy on the launch `--config` overlay.
// omp honours `tools.approval.<tool>` in every approval mode, so `deny` holds even under `yolo`.

use std::io;
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "plan-mode-approval.yml";

/// The built-in tools that change files, from omp 18.22.2 `builtin-names.ts` (`write`, `edit`,
/// `ast_edit`; omp has no separate notebook, rename or delete tool, those go through `edit`).
const WRITE_TOOLS: [&str; 3] = ["write", "edit", "ast_edit"];

/// Every other tool omp 18.22.2 declares at the `write` or `exec` tier (`approval` in `src/tools`,
/// `src/task`, `src/lsp`, `src/security`; `ssh` is not a tool in this version). A tool whose tier
/// depends on its arguments (`github`, `debug`, `lsp`, `hub`, `learn`, `context_notes`) is listed
/// whole, because the overlay is keyed by tool name and cannot tell a read call from a write call.
/// They ask instead of being denied: `bash` cannot be told apart from a file change by name, and a
/// denied `task` would block read-only exploration agents.
const PROMPT_TOOLS: [&str; 19] = [
    "bash",
    "eval",
    "browser",
    "computer",
    "task",
    "github",
    "debug",
    "lsp",
    "hub",
    "security_scan",
    "security_publish",
    "manage_skill",
    "learn",
    "context_notes",
    "new_context",
    "generate_image",
    "tts",
    "vibe_spawn",
    "vibe_send",
];

/// Plan mode is a strong default, not a sandbox: a tool the user allowlisted in omp's own settings,
/// a remembered `bash` approval or an MCP / `xd://` device that writes still can (ADR 0014, FR-152).
pub fn render() -> String {
    let mut out = String::from("tools:\n  approval:\n");
    for tool in WRITE_TOOLS {
        out.push_str(&format!("    {tool}: deny\n"));
    }
    for tool in PROMPT_TOOLS {
        out.push_str(&format!("    {tool}: prompt\n"));
    }
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
