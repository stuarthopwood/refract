// Diagnostics split out of `worktree_holders.rs` to keep it under the file-size cap.

use super::imp;

/// Logs which of this Session's recorded pids/descendants are still alive before the rename
/// probe, and whether the summary walk reads in-flight, to narrow down "folder in use" causes.
pub(super) async fn log_holder_diagnostics(session_id: &str, own_pids: &[u32]) {
    let pids = own_pids.to_vec();
    let (alive, descendants_alive) = tokio::task::spawn_blocking(move || {
        let alive: Vec<u32> = pids
            .iter()
            .copied()
            .filter(|&pid| imp::is_pid_alive(pid))
            .collect();
        let descendants = imp::descendant_pids(&pids);
        let descendants_alive: Vec<u32> = descendants
            .into_iter()
            .filter(|&pid| imp::is_pid_alive(pid))
            .collect();
        (alive, descendants_alive)
    })
    .await
    .unwrap_or_default();
    let walk_in_flight = crate::fs::leftover_summary::is_walk_in_flight(session_id);
    log::debug!(
        "worktree_holders::check_folder_in_use: about to probe -- recorded pids alive: {}; live descendants: {}; leftover-summary walk still in flight: {walk_in_flight}",
        alive.len(),
        descendants_alive.len()
    );
}
