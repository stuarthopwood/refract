// Per-launch omp `--config` overlay that pre-approves the three panel tools in omp, so omp's own
// `Allow tool:` prompt never fires. Refract raises its card itself, once, for mutating actions.

use std::io;
use std::path::{Path, PathBuf};

use super::tools_for;
use super::ToolAccess;

const FILE_NAME: &str = "agent-tools-approval.yml";

/// A tool name is written as a bare YAML key, so only the registered `refract_` names go in.
pub fn render(access: ToolAccess) -> String {
    let mut out = String::from("tools:\n  approval:\n");
    for name in tools_for(access) {
        out.push_str(&format!("    {name}: allow\n"));
    }
    out
}

pub fn path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// Writes the overlay atomically, unchanged content left alone, and returns its path.
pub async fn write(dir: &Path, access: ToolAccess) -> io::Result<PathBuf> {
    let file = path(dir);
    crate::omp::token_guard::write_atomic_if_changed(&file, render(access).as_bytes()).await?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_allows_exactly_the_registered_tools() {
        assert_eq!(
            render(ToolAccess::for_depth(1)),
            "tools:\n  approval:\n    refract_list_panels: allow\n    refract_open_panel: allow\n    refract_invoke_panel_action: allow\n    refract_list_sessions: allow\n    refract_get_session_status: allow\n    refract_send_session_message: allow\n    refract_create_session: allow\n    refract_update_session: allow\n"
        );
    }
}
