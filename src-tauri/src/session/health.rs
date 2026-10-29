// Issue #561: degraded-only health readouts. Every few seconds this samples each live Session's
// agent (OMP) process -- the latest quick-RPC round trip and the process working set -- and
// pushes `session:health` only when a measure enters or leaves its degraded state (plus a slow
// repeat while degraded, so a pane that mounted late still catches up). Healthy is silent: the
// renderer shows nothing and reserves no space.
//
// Thresholds and hysteresis are the ui-architect ruling recorded on #561 and in
// `specs/044-readout-health/spec.md`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::events::EventSink;
use crate::omp::process::RpcSample;
use crate::session::SessionManager;

const TICK: Duration = Duration::from_secs(5);
const REPEAT_WHILE_DEGRADED: Duration = Duration::from_secs(15);
/// A readout that appeared stays at least this long, so a borderline value cannot blink.
const MIN_DISPLAY: Duration = Duration::from_secs(10);

const RPC_ENTER_STREAK: u32 = 2;
const RPC_ENTER_SINGLE: Duration = Duration::from_secs(5);
const RPC_CLEAR_BELOW: Duration = Duration::from_secs(1);

const MEMORY_ENTER_BYTES: u64 = 1_500_000_000;
const MEMORY_CLEAR_BELOW_BYTES: u64 = 1_250_000_000;

/// What is currently degraded for one Session, and since when (for the minimum display).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Shown {
    rpc_slow_ms: Option<u64>,
    memory_bytes: Option<u64>,
}

#[derive(Default)]
struct SessionHealth {
    shown: Shown,
    rpc_since: Option<Instant>,
    memory_since: Option<Instant>,
    last_emit: Option<(Shown, Instant)>,
}

fn rpc_next(
    current: Option<u64>,
    sample: Option<RpcSample>,
    held_for: Duration,
) -> Option<u64> {
    let Some(sample) = sample else {
        return if current.is_some() && held_for < MIN_DISPLAY {
            current
        } else {
            None
        };
    };
    let latest_ms = sample.latest.as_millis() as u64;
    match current {
        None => (sample.slow_streak >= RPC_ENTER_STREAK || sample.latest >= RPC_ENTER_SINGLE)
            .then_some(latest_ms),
        Some(previous) => {
            if sample.latest < RPC_CLEAR_BELOW && held_for >= MIN_DISPLAY {
                None
            } else if sample.latest < RPC_CLEAR_BELOW {
                Some(previous)
            } else {
                Some(latest_ms)
            }
        }
    }
}

fn memory_next(current: Option<u64>, bytes: Option<u64>, held_for: Duration) -> Option<u64> {
    let bytes = bytes?;
    match current {
        None => (bytes >= MEMORY_ENTER_BYTES).then_some(bytes),
        Some(previous) => {
            if bytes < MEMORY_CLEAR_BELOW_BYTES && held_for >= MIN_DISPLAY {
                None
            } else if bytes < MEMORY_CLEAR_BELOW_BYTES {
                Some(previous)
            } else {
                Some(bytes)
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn working_set_bytes(pid: u32) -> Option<u64> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    // Safety: a query-only handle on a pid we spawned, closed on every path below.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut counters = PROCESS_MEMORY_COUNTERS {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        ..Default::default()
    };
    // Safety: `counters` is sized and `cb`-stamped as the API requires and outlives the call.
    let read = unsafe { GetProcessMemoryInfo(handle, &mut counters, counters.cb) };
    // Safety: `handle` came from the successful `OpenProcess` above and is closed exactly once.
    let _ = unsafe { CloseHandle(handle) };
    read.ok()?;
    Some(counters.WorkingSetSize as u64)
}

#[cfg(not(target_os = "windows"))]
fn working_set_bytes(_pid: u32) -> Option<u64> {
    None
}

/// Debug-only hooks (never compiled into a release build, same posture as
/// `REFRACT_FORCE_LOW_MEMORY`) so a live check can force each degraded state.
#[cfg(debug_assertions)]
fn forced(name: &str) -> Option<u64> {
    std::env::var(name).ok()?.parse().ok()
}

fn read_rpc(process: &crate::omp::process::OmpProcess) -> Option<RpcSample> {
    #[cfg(debug_assertions)]
    if let Some(ms) = forced("REFRACT_FORCE_RPC_SLOW_MS") {
        return Some(RpcSample {
            latest: Duration::from_millis(ms),
            slow_streak: RPC_ENTER_STREAK,
        });
    }
    process.rpc_latency()
}

fn read_memory(pid: u32) -> Option<u64> {
    #[cfg(debug_assertions)]
    if let Some(bytes) = forced("REFRACT_FORCE_AGENT_MEMORY_BYTES") {
        return Some(bytes);
    }
    working_set_bytes(pid)
}

pub fn start_monitor(session_manager: Arc<SessionManager>, events: EventSink) {
    tauri::async_runtime::spawn(async move {
        let mut states: HashMap<String, SessionHealth> = HashMap::new();
        loop {
            tokio::time::sleep(TICK).await;
            let agents = session_manager.live_agents();
            states.retain(|id, _| agents.iter().any(|a| a.session_id() == id));
            let now = Instant::now();
            for agent in agents {
                let state = states.entry(agent.session_id().to_string()).or_default();
                let process = agent.process_handle().await;
                let sample = process.as_deref().and_then(read_rpc);
                let bytes = process
                    .as_deref()
                    .and_then(|p| p.pid())
                    .and_then(read_memory);

                let rpc_held = state.rpc_since.map_or(Duration::MAX, |t| now - t);
                let memory_held = state.memory_since.map_or(Duration::MAX, |t| now - t);
                let rpc = rpc_next(state.shown.rpc_slow_ms, sample, rpc_held);
                let memory = memory_next(state.shown.memory_bytes, bytes, memory_held);
                if rpc.is_some() != state.shown.rpc_slow_ms.is_some() {
                    state.rpc_since = rpc.map(|_| now);
                }
                if memory.is_some() != state.shown.memory_bytes.is_some() {
                    state.memory_since = memory.map(|_| now);
                }
                state.shown = Shown {
                    rpc_slow_ms: rpc,
                    memory_bytes: memory,
                };

                if !agent.is_visible() {
                    continue;
                }
                let presence = |s: &Shown| (s.rpc_slow_ms.is_some(), s.memory_bytes.is_some());
                let degraded = rpc.is_some() || memory.is_some();
                let emit = match state.last_emit {
                    None => degraded,
                    Some((last, at)) => {
                        presence(&last) != presence(&state.shown)
                            || (degraded && now - at >= REPEAT_WHILE_DEGRADED)
                    }
                };
                if emit {
                    events.emit_session_health(agent.session_id(), rpc, memory);
                    state.last_emit = Some((state.shown, now));
                }
            }
        }
    });
}
