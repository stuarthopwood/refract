// Rust port of `src/main/omp/` (`OmpProcess.ts`: spawn, stdio JSONL framing, `rpc_chunk`
// reassembly, request/response correlation and timeout, stop/taskkill; `transcript.ts`: frame ->
// `TranscriptItem`; `transcriptDiff.ts`: the 50 ms-coalesced, O(n) map-based transcript diff,
// research.md decision 9). Not yet implemented -- scaffold placeholder for a later milestone-1
// slice (plan.md Project Structure: `omp/process.rs`, `omp/transcript.rs`, `omp/diff.rs`).

pub mod config;
pub mod diff;
pub mod images;
pub mod login_providers;
pub mod process;
pub mod transcript;
