// Issue #891 gate round (Main's own request): root-causing a "folder in use" refusal on a run
// with no planted holder. Split out of the parent `worktree_holders.rs` (#806 "No god files" --
// the diagnostic addition itself pushed that file over its 600-line cap with no baseline entry).

use super::imp;

/// Logs, right before the rename probe runs, exactly which of this Session's own recorded pids
/// (and their live descendants) are STILL alive at this instant, and whether the leftover-
/// summary walk still reads as in-flight for this Session -- `sessions.delete` already calls
/// `cancel_and_wait` before this point in its own flow, so the walk should always read settled
/// here; if it does not, that is itself a bug, not a race this log line introduces. Narrows the
/// cause by elimination: if every recorded pid and descendant already reads dead and the walk
/// reads settled, whatever the probe then reports held is neither this Session's own agent
/// process tree nor its summary walk -- left to the file watcher (already stopped earlier in
/// `sessions_delete`'s own flow by the time this runs) or Defender/the indexer by elimination.
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
        "worktree_holders::check_folder_in_use: about to probe {session_id} -- recorded pids alive: {alive:?}; live descendants: {descendants_alive:?}; leftover-summary walk still in flight: {walk_in_flight}"
    );
}
