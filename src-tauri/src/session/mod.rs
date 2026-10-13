// Rust port of `src/main/omp/SessionAgent.ts` (`session/agent.rs`: one per opened Session) and
// `src/main/SessionManager.ts` (`session/manager.rs`: registry + settings stores, live agents,
// event fan-out). See `agent.rs`'s own header for this slice's scope and simplifications.

pub mod agent;
pub mod manager;

pub use agent::{AgentError, SessionAgent, SessionStatus};
pub use manager::SessionManager;
