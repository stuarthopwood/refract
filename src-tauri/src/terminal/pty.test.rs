// Real ConPTY spawns of `%COMSPEC%` (no mocks): these prove the output path, resize and exit status.
#![cfg(windows)]

use std::sync::mpsc;
use std::time::{Duration, Instant};

use super::*;
use crate::terminal::shell::{ResolvedShell, ShellKind};

const WAIT: Duration = Duration::from_secs(20);

fn cmd_shell() -> ResolvedShell {
    let path = std::env::var_os("COMSPEC").expect("COMSPEC is set on Windows");
    ResolvedShell {
        kind: ShellKind::Cmd,
        path: path.into(),
    }
}

/// ConPTY asks the host terminal where the cursor is (`ESC[6n`) and holds the shell's startup until it is
/// told; xterm.js answers in the app, so the test plays that part.
const CURSOR_POSITION_REPLY: &[u8] = b"\x1b[1;1R";

fn spawn_cmd() -> Spawned {
    let mut spawned =
        spawn(&cmd_shell(), &std::env::temp_dir(), 80, 24).expect("cmd.exe starts under ConPTY");
    spawned.pty.write_input(CURSOR_POSITION_REPLY).unwrap();
    spawned
}

/// Streams reader bytes to a channel from a thread; the thread ends when the pty is dropped.
fn stream(mut reader: Box<dyn Read + Send>) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    rx
}

fn read_until(rx: &mpsc::Receiver<Vec<u8>>, needle: &str) -> String {
    let deadline = Instant::now() + WAIT;
    let mut seen = String::new();
    while Instant::now() < deadline {
        if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
            seen.push_str(&String::from_utf8_lossy(&chunk));
            if seen.contains(needle) {
                return seen;
            }
        }
    }
    panic!("never saw {needle:?}; got {seen:?}");
}

fn wait_for_exit(mut waiter: ExitWaiter) -> i32 {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(waiter.wait());
    });
    rx.recv_timeout(WAIT).expect("the shell exits")
}

#[test]
fn echoed_command_output_reaches_the_reader() {
    let Spawned {
        mut pty,
        reader,
        waiter,
    } = spawn_cmd();
    let rx = stream(reader);
    // The caret keeps the typed line from containing the marker, so only a run command prints it whole.
    pty.write_input(b"echo MARK^ER_4417\r\n").unwrap();
    read_until(&rx, "MARKER_4417");
    pty.kill();
    wait_for_exit(waiter);
}

#[test]
fn resize_is_accepted_and_reported_back() {
    let Spawned {
        mut pty,
        reader,
        waiter,
    } = spawn_cmd();
    let _rx = stream(reader);
    assert_eq!(pty.size().unwrap(), (80, 24));
    pty.resize(120, 40).unwrap();
    assert_eq!(pty.size().unwrap(), (120, 40));
    pty.kill();
    wait_for_exit(waiter);
}

#[test]
fn the_exit_status_is_reported() {
    let Spawned {
        mut pty,
        reader,
        waiter,
    } = spawn_cmd();
    let _rx = stream(reader);
    pty.write_input(b"exit 7\r\n").unwrap();
    assert_eq!(wait_for_exit(waiter), 7);
}

#[test]
fn kill_ends_the_shell_and_reports_a_pid_while_running() {
    let Spawned {
        mut pty,
        reader,
        mut waiter,
    } = spawn_cmd();
    let _rx = stream(reader);
    assert!(pty.pid().is_some_and(|pid| pid > 0));
    assert_eq!(waiter.try_wait(), None, "still running");
    pty.kill();
    wait_for_exit(waiter);
}

#[test]
fn the_added_environment_reaches_the_shell() {
    let Spawned {
        mut pty,
        reader,
        waiter,
    } = spawn_cmd();
    let rx = stream(reader);
    // `^` splits the typed text from the expansion, so only the expanded value contains `=xterm-256color`.
    pty.write_input(b"echo T^ERM=%TERM%\r\n").unwrap();
    read_until(&rx, "TERM=xterm-256color");
    pty.kill();
    wait_for_exit(waiter);
}

#[test]
fn a_missing_working_folder_is_refused_before_any_spawn() {
    let missing = std::env::temp_dir().join("refract-terminal-no-such-folder-9f2c");
    let err = spawn(&cmd_shell(), &missing, 80, 24)
        .err()
        .expect("refused");
    assert!(err.to_string().contains("working folder"));
}

#[test]
fn a_missing_shell_executable_fails_to_start() {
    let shell = ResolvedShell {
        kind: ShellKind::Cmd,
        path: std::env::temp_dir().join("refract-terminal-no-such-shell-9f2c.exe"),
    };
    assert!(spawn(&shell, &std::env::temp_dir(), 80, 24).is_err());
}
