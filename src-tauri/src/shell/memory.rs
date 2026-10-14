// Memory warning surfaced in the readout pills, part of readout/subagents/live branch/memory
// warning (lane R5, issue #788). Pre-declared so lane R5 is the only lane that ever edits this
// file (issue #784, "Pre-declare per-lane Rust files").
//
// Port of `src/main/memory.ts`: samples free physical memory every 5s and pushes
// `memory:warning` only when the low/not-low state changes, plus once a minute while it stays
// low (so the status bar can re-surface the warning without main spamming on every sample).
// Never stops an agent automatically; that stays the user's own call (Stop agent).
//
// `is_memory_low`/`free_memory_bytes`/`LOW_MEMORY_BYTES` are the one canonical Win32 memory
// check in this crate: `session::start_queue`'s own start-queue memory defer (issue #512
// requirement 5) calls `is_memory_low()` here instead of keeping its own private duplicate --
// mirrors `startQueue.ts`'s own `import { isMemoryLow } from '../memory'` relationship to
// `memory.ts`, which this lane landed after `start_queue.rs` first shipped its own copy
// (issue #786, lane R3) for lack of anywhere canonical yet to import from.

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::events::EventSink;
use crate::session::SessionManager;

const SAMPLE_INTERVAL_MS: u64 = 5_000;
pub(crate) const LOW_MEMORY_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const REPEAT_WHILE_LOW_MS: u64 = 60_000;

/// Issue #788 (lane R5): kept here, not in `session/manager.rs` (a shared, not lane-R5-owned
/// file), since this is this module's own `memory:warning` payload need, not core
/// `SessionManager` surface. Mirrors `SessionManager.ts`'s own `liveAgentCount()`: agents whose
/// status isn't `stopped`.
impl SessionManager {
    pub(crate) async fn live_agent_count(&self) -> usize {
        let mut count = 0;
        for agent in self.live_agents() {
            if agent.status().await != crate::session::SessionStatus::Stopped {
                count += 1;
            }
        }
        count
    }
}

/// Issue #512 requirement 5's start-queue memory defer (`session::start_queue`) and this
/// module's own sampler both call this: a cheap synchronous check, `None` (Windows API failure)
/// always reading as "not low" rather than wrongly deferring/warning on an unreadable reading.
pub(crate) fn is_memory_low() -> bool {
    free_memory_bytes().is_some_and(|free| free < LOW_MEMORY_BYTES)
}

#[cfg(target_os = "windows")]
pub(crate) fn free_memory_bytes() -> Option<u64> {
    // Issue #788 acceptance ("open memory pressure, a test hook"): debug-only (never compiled
    // into a release build), same posture as `lib.rs`'s own `REFRACT_DATA_DIR` override -- lets
    // a live/scratch check force the low-memory branch without actually starving the machine.
    #[cfg(debug_assertions)]
    if std::env::var("REFRACT_FORCE_LOW_MEMORY").as_deref() == Ok("1") {
        return Some(0);
    }
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    // Safety: `status` is sized and `dwLength`-stamped exactly as the API requires, a local on
    // this function's own stack that outlives the call.
    unsafe { GlobalMemoryStatusEx(&mut status).ok()? };
    Some(status.ullAvailPhys)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn free_memory_bytes() -> Option<u64> {
    None
}

/// Spawns the sampler loop on the Tauri async runtime (`lib.rs`'s own `setup`, fire-and-forget
/// the same way the update startup check is -- never awaited before the window is shown). Safe
/// to start before `EventSink`'s own `AppHandle` is set (`events.rs`'s own doc comment: every
/// `send` silently no-ops until `setup` fills it in), so this can start as soon as the
/// `SessionManager`/`EventSink` pair exists.
pub fn start_monitor(session_manager: Arc<SessionManager>, events: EventSink) {
    tauri::async_runtime::spawn(async move {
        let mut last_low: Option<bool> = None;
        let mut last_emit_at: Option<Instant> = None;
        loop {
            tokio::time::sleep(Duration::from_millis(SAMPLE_INTERVAL_MS)).await;
            let Some(free_bytes) = free_memory_bytes() else {
                // A Windows API failure (should not happen in practice): skip this sample
                // entirely rather than report a misleading reading either way.
                continue;
            };
            let low = free_bytes < LOW_MEMORY_BYTES;
            let now = Instant::now();
            let changed = Some(low) != last_low;
            let due_repeat = low
                && last_emit_at
                    .map(|at| now.duration_since(at).as_millis() as u64 >= REPEAT_WHILE_LOW_MS)
                    .unwrap_or(true);
            if !changed && !due_repeat {
                continue;
            }
            last_low = Some(low);
            last_emit_at = Some(now);
            let live_agents = session_manager.live_agent_count().await;
            events.emit_memory_warning(low, free_bytes, live_agents);
        }
    });
}
