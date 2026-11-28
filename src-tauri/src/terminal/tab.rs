// One terminal tab: its identity, its state machine (`starting` -> `running` -> `ended`, or `starting` ->
// `failed`), the shell it owns and the stream that carries that shell's output. Three threads serve a
// running tab: the reader (blocking pty reads), the flusher (sends held output when its window elapses)
// and the waiter (learns the exit code). No terminal bytes are logged here.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::guard::{clamp_size, validate_input_size, validate_name, RateLimiter};
use super::limits::{ASK_FALLBACK_LINES, OUTPUT_CAP_BYTES};
use super::markers::{compose_output, OutputMode, TerminalOutput};
use super::pty::{spawn, Pty, Spawned};
use super::shell::{resolve_shell, ResolvedShell, ShellKind, SystemEnv};
use super::stream::{run_reader, FrameSink, Stream, CURSOR_REPLY};
use crate::ipc::IpcError;
use crate::process::child_tree;

/// How long the waiter lets the reader finish after the shell exits before it reports the exit anyway.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

/// Not saved; data-model.md "Terminal tab".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TabState {
    Starting,
    Running,
    Ended { code: i32 },
    Failed { message: String },
}

/// The wire shape of a tab (`TabInfo` in contracts/terminal-ipc.md).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabInfo {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub cwd: String,
    pub shell: ShellKind,
    pub order: u32,
    pub state: TabState,
}

/// Called, outside every lock, each time a tab's state or name changes.
pub type StateNotifier = Arc<dyn Fn(&TabInfo) + Send + Sync>;

/// What a new tab starts from; the saved record has the same fields.
pub struct TabParams {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub cwd: PathBuf,
    pub shell: ShellKind,
    pub order: u32,
}

struct Meta {
    name: String,
    shell: ShellKind,
    order: u32,
    state: TabState,
    size: (u16, u16),
}

pub struct Tab {
    id: String,
    session_id: String,
    cwd: PathBuf,
    meta: Mutex<Meta>,
    stream: Mutex<Arc<Stream>>,
    pty: Mutex<Option<Pty>>,
    limiter: Mutex<RateLimiter>,
    /// Set once the tab was closed by the developer or its Session: the shell's last exit is then not news.
    closed: AtomicBool,
    notify: StateNotifier,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn not_running() -> IpcError {
    IpcError::new("terminal-not-running", "The terminal is not running")
}

fn not_ended() -> IpcError {
    IpcError::new(
        "terminal-not-ended",
        "Only a terminal whose shell has ended can be restarted",
    )
}

impl Tab {
    pub fn new(params: TabParams, notify: StateNotifier) -> Arc<Self> {
        Arc::new(Self {
            id: params.id,
            session_id: params.session_id,
            cwd: params.cwd,
            meta: Mutex::new(Meta {
                name: params.name,
                shell: params.shell,
                order: params.order,
                state: TabState::Starting,
                size: (80, 24),
            }),
            stream: Mutex::new(Arc::new(Stream::new())),
            pty: Mutex::new(None),
            limiter: Mutex::new(RateLimiter::new(Instant::now())),
            closed: AtomicBool::new(false),
            notify,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    pub fn info(&self) -> TabInfo {
        let meta = lock(&self.meta);
        self.info_of(&meta)
    }

    fn info_of(&self, meta: &Meta) -> TabInfo {
        TabInfo {
            id: self.id.clone(),
            session_id: self.session_id.clone(),
            name: meta.name.clone(),
            cwd: self.cwd.to_string_lossy().into_owned(),
            shell: meta.shell,
            order: meta.order,
            state: meta.state.clone(),
        }
    }

    pub fn state(&self) -> TabState {
        lock(&self.meta).state.clone()
    }

    pub fn is_running(&self) -> bool {
        self.state() == TabState::Running
    }

    pub fn set_order(&self, order: u32) {
        lock(&self.meta).order = order;
    }

    /// Renames the tab; the name is trimmed and must be 1..=40 characters.
    pub fn rename(&self, raw: &str) -> Result<TabInfo, IpcError> {
        let name = validate_name(raw)?;
        let info = {
            let mut meta = lock(&self.meta);
            meta.name = name;
            self.info_of(&meta)
        };
        (self.notify)(&info);
        Ok(info)
    }

    fn set_state(&self, state: TabState) {
        let info = {
            let mut meta = lock(&self.meta);
            meta.state = state;
            self.info_of(&meta)
        };
        // The renderer has already dropped a closed tab, so its shell's exit is not announced.
        if !self.closed.load(Ordering::Acquire) {
            (self.notify)(&info);
        }
    }

    /// Starts the shell this machine resolves (`pwsh`, Windows PowerShell, then `cmd`).
    pub fn start(self: &Arc<Self>, cols: u16, rows: u16) {
        self.start_with(resolve_shell(&SystemEnv), cols, rows);
    }

    /// Starts `shell`; `None` means no shell exists on this machine. A failure leaves the tab `failed`
    /// with a message that never contains terminal content.
    pub fn start_with(self: &Arc<Self>, shell: Option<ResolvedShell>, cols: u16, rows: u16) {
        let Some(shell) = shell else {
            self.set_state(TabState::Failed {
                message: "No shell was found on this computer".into(),
            });
            return;
        };
        let (cols, rows) = clamp_size(i64::from(cols), i64::from(rows));
        let Spawned {
            pty,
            reader,
            mut waiter,
        } = match spawn(&shell, &self.cwd, cols, rows) {
            Ok(spawned) => spawned,
            Err(err) => {
                self.set_state(TabState::Failed { message: err.0 });
                return;
            }
        };
        let stream = Arc::new(Stream::new());
        *lock(&self.stream) = Arc::clone(&stream);
        *lock(&self.pty) = Some(pty);
        {
            let mut meta = lock(&self.meta);
            meta.shell = shell.kind;
            meta.size = (cols, rows);
        }
        self.set_state(TabState::Running);

        let flusher = Arc::clone(&stream);
        std::thread::Builder::new()
            .name("terminal-flusher".into())
            .spawn(move || flusher.run_flusher())
            .ok();

        let reader_stream = Arc::clone(&stream);
        let answerer = Arc::clone(self);
        std::thread::Builder::new()
            .name("terminal-reader".into())
            .spawn(move || {
                run_reader(&reader_stream, reader, || {
                    answerer.write_raw(CURSOR_REPLY);
                });
            })
            .ok();

        let tab = Arc::clone(self);
        std::thread::Builder::new()
            .name("terminal-waiter".into())
            .spawn(move || {
                let code = waiter.wait();
                // The shell is gone: let its last output drain, then close the console so the reader ends.
                stream.start_draining();
                let pty = lock(&tab.pty).take();
                drop(pty);
                stream.wait_finished(DRAIN_GRACE);
                stream.set_exit(code);
                tab.set_state(TabState::Ended { code });
            })
            .ok();
    }

    /// Starts a new shell in an `ended` or `failed` tab: same id, name, working folder, order and size, but
    /// an empty scrollback. Any other state is `terminal-not-ended`.
    pub fn restart(self: &Arc<Self>) -> Result<TabInfo, IpcError> {
        self.restart_with(resolve_shell(&SystemEnv))
    }

    /// `restart` with the shell to start made explicit; `None` means no shell exists on this machine.
    pub fn restart_with(
        self: &Arc<Self>,
        shell: Option<ResolvedShell>,
    ) -> Result<TabInfo, IpcError> {
        let (info, (cols, rows)) = {
            let mut meta = lock(&self.meta);
            if !matches!(meta.state, TabState::Ended { .. } | TabState::Failed { .. }) {
                return Err(not_ended());
            }
            meta.state = TabState::Starting;
            (self.info_of(&meta), meta.size)
        };
        (self.notify)(&info);
        self.start_with(shell, cols, rows);
        Ok(self.info())
    }

    /// The terminal's text for the agent (FR-020): the most recent command's output when prompt markers
    /// name one and `mode` asks for it, otherwise the last 200 lines. ANSI stripped, capped to 32 KiB keeping
    /// the end.
    pub fn read_output(&self, mode: OutputMode) -> TerminalOutput {
        let stream = self.stream();
        let recent = match mode {
            OutputMode::RecentCommand => stream.recent_command(),
            OutputMode::LastLines => None,
        };
        compose_output(
            recent,
            || stream.tail_lines(ASK_FALLBACK_LINES),
            OUTPUT_CAP_BYTES,
        )
    }

    fn stream(&self) -> Arc<Stream> {
        Arc::clone(&lock(&self.stream))
    }

    /// Everything the scrollback holds, oldest first.
    pub fn snapshot(&self) -> Vec<u8> {
        self.stream().ring_snapshot()
    }

    /// Makes `sink` the receiver: the shell is resized to the receiver's size, the ring is replayed, then
    /// output streams live. Any earlier receiver is dropped.
    pub fn attach(&self, sink: Box<dyn FrameSink>, cols: i64, rows: i64) -> TabState {
        self.resize(cols, rows);
        self.stream().attach(sink);
        self.state()
    }

    pub fn detach(&self) {
        self.stream().detach();
    }

    pub fn ack(&self, bytes: usize) {
        self.stream().ack(bytes);
    }

    /// Resizes the shell. Out-of-range sizes are clamped; a tab that is not running only remembers the size.
    pub fn resize(&self, cols: i64, rows: i64) {
        let (cols, rows) = clamp_size(cols, rows);
        if let Some(pty) = lock(&self.pty).as_ref() {
            if pty.resize(cols, rows).is_err() {
                return;
            }
        }
        lock(&self.meta).size = (cols, rows);
    }

    pub fn size(&self) -> (u16, u16) {
        lock(&self.meta).size
    }

    /// Types `data` into the shell. Refused while the tab is not running, when the call is over 64 KiB, or
    /// when the tab is being fed faster than 1 MiB per second.
    pub fn input(&self, data: &str) -> Result<(), IpcError> {
        if !self.is_running() {
            return Err(not_running());
        }
        validate_input_size(data)?;
        lock(&self.limiter).try_consume(data.len(), Instant::now())?;
        match lock(&self.pty).as_mut() {
            Some(pty) => pty.write_input(data.as_bytes()).map_err(|_| not_running()),
            None => Err(not_running()),
        }
    }

    // Replies the app itself must give the shell (no receiver attached to give them).
    fn write_raw(&self, bytes: &[u8]) {
        if let Some(pty) = lock(&self.pty).as_mut() {
            let _ = pty.write_input(bytes);
        }
    }

    pub(crate) fn pid(&self) -> Option<u32> {
        lock(&self.pty).as_ref().and_then(Pty::pid)
    }

    /// True while the shell has a child other than the console host (FR-013).
    pub fn has_running_child(&self) -> bool {
        self.pid().is_some_and(child_tree::has_child_process)
    }

    /// Ends the shell and everything it started. The waiter then reports `ended`.
    pub fn terminate(&self) {
        if let Some(pid) = self.pid() {
            child_tree::kill_tree(pid);
        }
        if let Some(pty) = lock(&self.pty).as_mut() {
            pty.kill();
        }
    }

    /// Closes the tab for good: no further state notice is sent, the receiver is dropped, and the shell tree ends.
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.detach();
        self.terminate();
    }
}

#[cfg(test)]
#[path = "tab.test.rs"]
mod tests;
