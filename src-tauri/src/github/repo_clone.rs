// Spec 054 (issue #867, FR-022, FR-023, FR-030, FR-032): one `gh repo clone` child process,
// modelled on `cli.rs`'s `GhLoginFlow`: spawn through `resolve_gh` with an argument array (no
// shell), stream stderr into coarse progress stages, keep a private stderr tail only to classify a
// failed exit into a fixed sentence, and an idempotent `cancel()` whose exit event fires once.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, watch};

use super::gh::{resolve_gh, GhError, GhErrorCode};
use super::repo_ref::RepoRef;

/// Windows-only: `CREATE_NO_WINDOW` (same flag `gh.rs`'s own `gh_raw` applies).
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const STDERR_TAIL_BYTES: usize = 2 * 1024;
const MAX_LINE_CHARS: usize = 4096;
const KILL_WAIT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloneStage {
    Starting,
    Receiving,
    Resolving,
    Updating,
}

impl CloneStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Receiving => "receiving",
            Self::Resolving => "resolving",
            Self::Updating => "updating",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloneFailure {
    NotFoundOrNoAccess,
    SignedOut,
    Network,
    Destination,
    Unknown,
}

impl CloneFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotFoundOrNoAccess => "not-found-or-no-access",
            Self::SignedOut => "signed-out",
            Self::Network => "network",
            Self::Destination => "destination",
            Self::Unknown => "unknown",
        }
    }

    /// One fixed sentence per failure; raw stderr never reaches the renderer.
    pub fn message(self) -> &'static str {
        match self {
            Self::NotFoundOrNoAccess => {
                "That GitHub repository wasn't found, or you don't have access to it."
            }
            Self::SignedOut => "You're signed out of GitHub. Sign in and try again.",
            Self::Network => "Couldn't reach GitHub. Check your connection and try again.",
            Self::Destination => "Couldn't write to that folder.",
            Self::Unknown => "The clone failed.",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct CloneProgress {
    pub stage: CloneStage,
    pub percent: Option<u8>,
}

#[derive(Debug, Clone, Copy)]
pub struct CloneExit {
    pub code: Option<i32>,
    /// `cancel()` was called before the process exited.
    pub requested: bool,
    pub failure: CloneFailure,
}

#[derive(Debug)]
pub enum CloneEvent {
    Progress(CloneProgress),
    Exit(CloneExit),
}

fn parse_percent(line: &str) -> Option<u8> {
    let end = line.find('%')?;
    let digits: String = line[..end]
        .chars()
        .rev()
        .take_while(char::is_ascii_digit)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    digits.parse::<u8>().ok().filter(|p| *p <= 100)
}

/// Maps one git stderr line to a coarse stage; `None` for anything that is not progress.
fn parse_progress_line(line: &str) -> Option<CloneProgress> {
    let (stage, percent) = if line.contains("Receiving objects") {
        (CloneStage::Receiving, parse_percent(line))
    } else if line.contains("Resolving deltas") {
        (CloneStage::Resolving, parse_percent(line))
    } else if line.contains("Updating files") || line.contains("Checking out files") {
        (CloneStage::Updating, parse_percent(line))
    } else if line.starts_with("Cloning into") || line.starts_with("remote:") {
        (CloneStage::Starting, None)
    } else {
        return None;
    };
    Some(CloneProgress { stage, percent })
}

/// Buckets a failed exit by the private stderr tail; order matters (most specific first).
fn classify_failure(tail: &str) -> CloneFailure {
    let text = tail.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| text.contains(n));
    if has(&[
        "already exists and is not an empty",
        "could not create work tree",
        "unable to create",
        "failed to create",
        "filename too long",
        "no space left",
        "invalid path",
    ]) {
        CloneFailure::Destination
    } else if has(&[
        "gh auth login",
        "not logged in",
        "authentication failed",
        "bad credentials",
        "http 401",
        "to authenticate",
    ]) {
        CloneFailure::SignedOut
    } else if has(&[
        "could not resolve host",
        "could not resolve",
        "unable to access",
        "timed out",
        "connection",
        "network",
        "ssl",
        "tls",
    ]) {
        CloneFailure::Network
    } else if has(&[
        "not found",
        "could not read from remote",
        "permission denied",
        "access denied",
        "does not exist",
        "http 404",
        "http 403",
    ]) {
        CloneFailure::NotFoundOrNoAccess
    } else {
        CloneFailure::Unknown
    }
}

struct Shared {
    stderr_tail: StdMutex<String>,
    requested: AtomicBool,
    exited: AtomicBool,
    exit_tx: watch::Sender<bool>,
    events_tx: mpsc::UnboundedSender<CloneEvent>,
}

impl Shared {
    fn handle_line(&self, line: &str) {
        if let Some(progress) = parse_progress_line(line) {
            let _ = self.events_tx.send(CloneEvent::Progress(progress));
            if progress.stage != CloneStage::Starting {
                return;
            }
        }
        let mut tail = self.stderr_tail.lock().expect("stderr tail lock");
        tail.push_str(line);
        tail.push('\n');
        if tail.len() > STDERR_TAIL_BYTES {
            let mut cut = tail.len() - STDERR_TAIL_BYTES;
            while !tail.is_char_boundary(cut) {
                cut += 1;
            }
            tail.drain(..cut);
        }
    }

    fn on_exit(&self, code: Option<i32>) {
        if self.exited.swap(true, Ordering::SeqCst) {
            return;
        }
        let failure = if code == Some(0) {
            CloneFailure::Unknown
        } else {
            classify_failure(&self.stderr_tail.lock().expect("stderr tail lock"))
        };
        let _ = self.events_tx.send(CloneEvent::Exit(CloneExit {
            code,
            requested: self.requested.load(Ordering::SeqCst),
            failure,
        }));
        let _ = self.exit_tx.send(true);
    }
}

pub struct CloneJob {
    shared: Arc<Shared>,
    pid: Option<u32>,
    exit_rx: watch::Receiver<bool>,
}

impl CloneJob {
    /// Spawns `gh repo clone <owner/name> <destination> -- --progress` and returns the job plus
    /// its event channel; resolves once spawned, not once cloned.
    pub async fn start(
        repo: &RepoRef,
        destination: &std::path::Path,
    ) -> Result<(Arc<CloneJob>, mpsc::UnboundedReceiver<CloneEvent>), GhError> {
        let gh_path = resolve_gh().map_err(|_| {
            GhError::new(
                GhErrorCode::GhUnavailable,
                "The GitHub CLI (gh) is not installed or not on PATH.",
            )
        })?;
        let destination = destination.to_str().ok_or_else(|| {
            GhError::new(
                GhErrorCode::GhFailed,
                "The destination path is not valid text.",
            )
        })?;
        let name_with_owner = repo.name_with_owner();
        let mut command = tokio::process::Command::new(&gh_path);
        command
            .args(["repo", "clone", name_with_owner.as_str(), destination])
            .args(["--", "--progress"])
            .current_dir(std::env::temp_dir())
            .env("GIT_TERMINAL_PROMPT", "0")
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|err| {
            let code = if err.kind() == std::io::ErrorKind::NotFound {
                GhErrorCode::GhUnavailable
            } else {
                GhErrorCode::GhFailed
            };
            GhError::new(code, format!("gh repo clone failed to spawn: {err}"))
        })?;

        let pid = child.id();
        let stderr = child.stderr.take();
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let (exit_tx, exit_rx) = watch::channel(false);
        let shared = Arc::new(Shared {
            stderr_tail: StdMutex::new(String::new()),
            requested: AtomicBool::new(false),
            exited: AtomicBool::new(false),
            exit_tx,
            events_tx,
        });
        let _ = shared.events_tx.send(CloneEvent::Progress(CloneProgress {
            stage: CloneStage::Starting,
            percent: None,
        }));

        let reader = stderr.map(|mut stderr| {
            let shared = shared.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let mut pending = String::new();
                loop {
                    let n = match stderr.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    for c in String::from_utf8_lossy(&buf[..n]).chars() {
                        if c == '\r' || c == '\n' {
                            if !pending.is_empty() {
                                shared.handle_line(&pending);
                                pending.clear();
                            }
                        } else if pending.chars().count() < MAX_LINE_CHARS {
                            pending.push(c);
                        }
                    }
                }
                if !pending.is_empty() {
                    shared.handle_line(&pending);
                }
            })
        });
        {
            let shared = shared.clone();
            tokio::spawn(async move {
                let status = child.wait().await;
                if let Some(reader) = reader {
                    let _ = reader.await;
                }
                shared.on_exit(status.ok().and_then(|s| s.code()));
            });
        }
        Ok((
            Arc::new(CloneJob {
                shared,
                pid,
                exit_rx,
            }),
            events_rx,
        ))
    }

    /// Idempotent: `taskkill /T /F` on the child tree (a clone has no graceful stop), then waits
    /// (bounded) for the real exit event so the caller can clean up afterwards.
    pub async fn cancel(&self) {
        self.shared.requested.store(true, Ordering::SeqCst);
        let Some(pid) = self.pid else { return };
        if !self.shared.exited.load(Ordering::SeqCst) {
            let taskkill = crate::process::executables::taskkill_path();
            let _ = tokio::process::Command::new(&taskkill)
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .await;
        }
        let mut rx = self.exit_rx.clone();
        let _ = tokio::time::timeout(KILL_WAIT, rx.wait_for(|exited| *exited)).await;
    }
}
