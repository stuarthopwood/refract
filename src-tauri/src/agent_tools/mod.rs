// Host tools Refract registers with omp on every launch (spec 124): registration and access.
// Routing lives in `router`, approval in `approval`, the OMP approval overlay in `overlay`.

pub mod approval;
pub mod envelope;
pub mod overlay;
pub mod panels;
pub mod router;
pub mod sessions;
mod sessions_create;
mod sessions_limit;
pub mod sessions_send;
mod sessions_update;
pub mod tree_gate;

use serde_json::{json, Value};

use panels::{tool_description, tool_parameters, INVOKE_PANEL_ACTION, LIST_PANELS, OPEN_PANEL};

pub const TOOL_PREFIX: &str = "refract_";
pub const RENDERER_TIMEOUT_MS: u64 = 10_000;
/// A file-changing action's window, for the renderer's `started` and again for its reply.
pub const MUTATION_TIMEOUT_MS: u64 = 30_000;
pub const MAX_RESULT_BYTES: usize = 8192;
const REGISTER_TIMEOUT_MS: u64 = 10_000;

/// Who a tool is registered for. Every launched Session is `Root`; #1859 keeps `Child` for the
/// empty row of spec 129.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Root,
    Child,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolAccess {
    pub role: Role,
    pub depth: u8,
}

impl ToolAccess {
    /// A Session at `depth` in the Session tree: `Root` at any depth, since a child must be able to
    /// report to its parent. Rust enforces the tree limits from the registry, never from this.
    pub fn for_depth(depth: usize) -> Self {
        Self {
            role: Role::Root,
            depth: u8::try_from(depth).unwrap_or(u8::MAX),
        }
    }

    /// The access for Session `id`, from its depth in the registry rows.
    pub fn for_session(sessions: &[crate::store::registry::Session], id: &str) -> Self {
        Self::for_depth(crate::store::session_tree::depth_of(sessions, id))
    }
}

/// Tool names visible to a Session. The panel tools are available to every root Session.
pub fn tools_for(access: ToolAccess) -> Vec<&'static str> {
    match access.role {
        Role::Root => {
            let mut names = vec![LIST_PANELS, OPEN_PANEL, INVOKE_PANEL_ACTION];
            names.extend(sessions::SESSION_TOOLS);
            names
        }
        Role::Child => Vec::new(),
    }
}

/// The `tools` array of omp's `set_host_tools`. `essential` keeps them in the model's tool list.
pub fn host_tool_defs(access: ToolAccess) -> Vec<Value> {
    tools_for(access)
        .into_iter()
        .map(|name| {
            let (description, parameters) = if sessions::is_session_tool(name) {
                (sessions::description(name), sessions::parameters(name))
            } else {
                (tool_description(name), tool_parameters(name))
            };
            json!({
                "name": name,
                "label": name,
                "description": description,
                "parameters": parameters,
                "loadMode": "essential",
            })
        })
        .collect()
}

/// Registers the tools for this launch. A later call replaces the set, so a relaunch never doubles.
/// A failure leaves the Session without Refract tools; it still works as a plain agent.
pub async fn register_host_tools(proc: &crate::omp::process::OmpProcess, access: ToolAccess) {
    let request = json!({ "type": "set_host_tools", "tools": host_tool_defs(access) });
    let ok = match proc.request(request, REGISTER_TIMEOUT_MS).await {
        Ok(response) => response.get("success").and_then(Value::as_bool) == Some(true),
        Err(_) => false,
    };
    if !ok {
        log::warn!("agent tools: omp did not accept set_host_tools");
    }
}

/// The approval overlay as `--config` args, or a warning when it cannot be written.
pub async fn overlay_config(
    dir: &std::path::Path,
    access: ToolAccess,
) -> Option<std::path::PathBuf> {
    match overlay::write(dir, access).await {
        Ok(path) => Some(path),
        Err(err) => {
            log::warn!("agent tools: could not write the approval overlay ({err})");
            None
        }
    }
}

#[cfg(test)]
#[path = "mod.test.rs"]
mod tests;
