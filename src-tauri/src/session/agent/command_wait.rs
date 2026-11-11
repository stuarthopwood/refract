// Waiting for OMP's first command list after a start, so a queued slash command is checked
// against the real list rather than an empty one (#1812).

use std::future::Future;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::Notify;

use super::{SessionAgent, SessionStatus};

/// How long a queued slash command waits for the agent to report its commands.
pub const COMMANDS_WAIT: Duration = Duration::from_secs(10);

/// Re-reads until `read` returns a non-empty list or `timeout` passes, then reads one last time.
/// The wait is woken by `reported`, so an update that lands between a read and the sleep is not missed.
pub(super) async fn wait_until_reported<F, Fut>(
    reported: &Notify,
    timeout: Duration,
    mut read: F,
) -> Vec<Value>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Vec<Value>>,
{
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        // Created before the read: `notify_waiters` reaches a `Notified` that has not been polled yet.
        let notified = reported.notified();
        let commands = read().await;
        if !commands.is_empty() {
            return commands;
        }
        if tokio::time::timeout_at(deadline, notified).await.is_err() {
            return read().await;
        }
    }
}

impl SessionAgent {
    /// The agent's command list once it has reported one. Empty on timeout, or at once when the
    /// agent is not started, because nothing is coming.
    pub async fn wait_for_commands(&self, timeout: Duration) -> Vec<Value> {
        if self.status().await == SessionStatus::Stopped {
            return self.available_commands().await;
        }
        wait_until_reported(&self.commands_reported, timeout, || {
            self.available_commands()
        })
        .await
    }
}

#[cfg(test)]
#[path = "command_wait.test.rs"]
mod tests;
