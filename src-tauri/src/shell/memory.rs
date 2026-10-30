// Low-memory warning for the status bar. Never stops an agent automatically.
// `is_memory_low` is the one canonical memory check, shared with the start-queue defer.

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::events::EventSink;
use crate::session::SessionManager;

const SAMPLE_INTERVAL_MS: u64 = 5_000;
pub(crate) const LOW_MEMORY_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const REPEAT_WHILE_LOW_MS: u64 = 60_000;

/// Counts agents whose status is not `stopped`, for the `memory:warning` payload.
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

/// `None` (API failure) reads as not low, so an unreadable sample never defers or warns.
pub(crate) fn is_memory_low() -> bool {
    free_memory_bytes().is_some_and(|free| free < LOW_MEMORY_BYTES)
}

#[cfg(target_os = "windows")]
pub(crate) fn free_memory_bytes() -> Option<u64> {
    // Debug-only test hook: forces the low-memory branch without starving the machine.
    #[cfg(debug_assertions)]
    if std::env::var("REFRACT_FORCE_LOW_MEMORY").as_deref() == Ok("1") {
        return Some(0);
    }
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    // Safety: `status` is sized and stamped as the API requires and outlives the call.
    unsafe { GlobalMemoryStatusEx(&mut status).ok()? };
    Some(status.ullAvailPhys)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn free_memory_bytes() -> Option<u64> {
    None
}

/// Spawns the sampler on the Tauri runtime. Safe before `EventSink`'s AppHandle is set:
/// sends no-op until `setup` fills it in (events.rs).
pub fn start_monitor(session_manager: Arc<SessionManager>, events: EventSink) {
    crate::session::health::start_monitor(session_manager.clone(), events.clone());
    tauri::async_runtime::spawn(async move {
        let mut last_low: Option<bool> = None;
        let mut last_emit_at: Option<Instant> = None;
        loop {
            tokio::time::sleep(Duration::from_millis(SAMPLE_INTERVAL_MS)).await;
            let Some(free_bytes) = free_memory_bytes() else {
                // API failure: skip the sample rather than report a misleading reading.
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
