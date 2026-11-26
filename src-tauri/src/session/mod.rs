// Rust port of the session agent and manager. Module layout is documented in `agent/mod.rs`.

pub mod advisor;
pub mod agent;
mod ai_credits;
pub(crate) mod checklist_source;
pub(crate) mod github_writes;
mod handoff_note;
pub mod health;
pub mod last_user_message;
pub mod manager;
pub mod model;
pub mod pending_selection;
pub mod prewalk;
pub mod readout;
mod readout_head_watch;
pub mod saved_history;
pub mod saved_history_cache;
pub mod side_chat;
pub mod start_queue;
pub mod subagents;
pub mod subagents_synthesis;
pub mod subagents_synthesis_cache;
pub mod termination;
pub mod thinking_level;
pub mod token_guard;
mod usage_nudge;
pub mod working_mode;

pub use agent::{AgentError, SessionAgent, SessionStatus};
pub use manager::SessionManager;
