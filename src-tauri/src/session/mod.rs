// Rust port of `src/main/omp/SessionAgent.ts` (`session/agent/`: one per opened Session) and
// `src/main/SessionManager.ts` (`session/manager.rs`: registry + settings stores, live agents,
// event fan-out). See `agent/mod.rs`'s own header for this slice's scope and simplifications,
// and for how `agent/` is itself split by concern.
//
// `model.rs`, `readout.rs`, `side_chat.rs`, `start_queue.rs`, `subagents.rs`, and
// `termination.rs` are empty, pre-declared per-lane files (issue #784, "Pre-declare per-lane
// Rust files"): each owns a no-op `on_frame` extension point `agent::frame`'s own `handle_frame`
// calls, so a lane adds behaviour inside its own file only.

pub mod agent;
pub mod manager;
pub mod model;
pub mod readout;
pub mod side_chat;
pub mod start_queue;
pub mod subagents;
pub mod termination;

pub use agent::{AgentError, SessionAgent, SessionStatus};
pub use manager::SessionManager;
