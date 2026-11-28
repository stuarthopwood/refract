// The only place a terminal shell is spawned (ADR 0016). A shell is a ConPTY child created through
// `portable-pty`; this module hands back the pieces (input/resize/kill handle, a blocking output reader,
// an exit waiter) so the owner can run each on its own thread. No terminal bytes are logged here.

use std::fmt;
use std::io::{Read, Write};
use std::path::Path;

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};

use super::shell::{shell_args, ResolvedShell, ADDED_ENV};

/// Why a shell did not start or a pty call failed. The message is safe to show: it comes from the OS or
/// from this module, never from terminal content.
#[derive(Debug)]
pub struct PtyError(pub String);

impl fmt::Display for PtyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PtyError {}

fn fail(context: &str, err: impl fmt::Display) -> PtyError {
    PtyError(format!("{context}: {err}"))
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// The live end of one shell: write input, resize, kill.
pub struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
}

/// Waits for the shell to exit. Owned by its own thread because `wait` blocks.
pub struct ExitWaiter {
    child: Box<dyn Child + Send + Sync>,
}

/// Everything `spawn` produces. The reader blocks in `read`; hand it to a dedicated thread.
pub struct Spawned {
    pub pty: Pty,
    pub reader: Box<dyn Read + Send>,
    pub waiter: ExitWaiter,
}

/// Starts `shell` in `cwd` at `cols` x `rows`. The shell inherits the app's environment plus `TERM` and
/// `COLORTERM` (`ADDED_ENV`).
pub fn spawn(shell: &ResolvedShell, cwd: &Path, cols: u16, rows: u16) -> Result<Spawned, PtyError> {
    if !cwd.is_dir() {
        return Err(PtyError(format!(
            "The working folder does not exist: {}",
            cwd.display()
        )));
    }
    let pair = native_pty_system()
        .openpty(pty_size(cols, rows))
        .map_err(|err| fail("The terminal could not be opened", err))?;
    let mut command = CommandBuilder::new(&shell.path);
    command.args(shell_args(shell.kind));
    command.cwd(cwd);
    for (name, value) in ADDED_ENV {
        command.env(name, value);
    }
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|err| fail("The shell could not be started", err))?;
    // The child holds its own end; keeping ours open would stop the reader from ever seeing the end.
    drop(pair.slave);
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| fail("The terminal output could not be read", err))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|err| fail("The terminal input could not be opened", err))?;
    Ok(Spawned {
        pty: Pty {
            master: pair.master,
            writer,
            killer: child.clone_killer(),
            pid: child.process_id(),
        },
        reader,
        waiter: ExitWaiter { child },
    })
}

impl Pty {
    /// Root pid of the shell while it runs.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Sends `data` to the shell's input.
    pub fn write_input(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.writer.write_all(data)?;
        self.writer.flush()
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), PtyError> {
        self.master
            .resize(pty_size(cols, rows))
            .map_err(|err| fail("The terminal could not be resized", err))
    }

    /// The size the pty currently reports, as `(cols, rows)`.
    pub fn size(&self) -> Result<(u16, u16), PtyError> {
        let size = self
            .master
            .get_size()
            .map_err(|err| fail("The terminal size could not be read", err))?;
        Ok((size.cols, size.rows))
    }

    /// Ends the shell process. Descendants are the caller's to reap (`child_tree`). Infallible by design:
    /// portable-pty's Windows killer reports a stale OS error when `TerminateProcess` succeeds, so its result
    /// says nothing; the owner learns the outcome from `ExitWaiter::wait`.
    pub fn kill(&mut self) {
        let _ = self.killer.kill();
    }
}

impl ExitWaiter {
    /// Blocks until the shell exits; the code is the process exit status as the signed value the wire carries.
    pub fn wait(&mut self) -> i32 {
        match self.child.wait() {
            Ok(status) => status.exit_code() as i32,
            Err(_) => -1,
        }
    }

    /// The exit code if the shell has already ended.
    pub fn try_wait(&mut self) -> Option<i32> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(status.exit_code() as i32),
            Ok(None) => None,
            Err(_) => Some(-1),
        }
    }
}

#[cfg(test)]
#[path = "pty.test.rs"]
mod tests;
