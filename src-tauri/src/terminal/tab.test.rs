// Behaviour of one tab through its public surface: its state machine, what an attached receiver is sent, and
// what a detached tab keeps. Real shells are `%COMSPEC%` spawns (no mocks), so those tests are Windows-only.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::*;
use crate::terminal::frame::{TAG_DATA, TAG_EXIT};

#[derive(Clone, Default)]
struct Recorder {
    frames: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl FrameSink for Recorder {
    fn send(&mut self, frame: Vec<u8>) -> bool {
        self.frames.lock().unwrap().push(frame);
        true
    }
}

impl Recorder {
    fn frames(&self) -> Vec<Vec<u8>> {
        self.frames.lock().unwrap().clone()
    }

    /// Payload of every data frame, joined.
    fn data(&self) -> Vec<u8> {
        self.frames()
            .iter()
            .filter(|frame| frame[0] == TAG_DATA)
            .flat_map(|frame| frame[1..].to_vec())
            .collect()
    }

    fn contains(&self, needle: &str) -> bool {
        String::from_utf8_lossy(&self.data()).contains(needle)
    }
}

type Notices = Arc<Mutex<Vec<TabInfo>>>;

fn new_tab(cwd: PathBuf) -> (Arc<Tab>, Notices) {
    let notices: Notices = Arc::default();
    let sink = Arc::clone(&notices);
    let tab = Tab::new(
        TabParams {
            id: "tab-1".into(),
            session_id: "session-1".into(),
            name: "Terminal 1".into(),
            cwd,
            shell: ShellKind::Cmd,
            order: 0,
        },
        Arc::new(move |info: &TabInfo| sink.lock().unwrap().push(info.clone())),
    );
    (tab, notices)
}

fn wait_until(mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

fn states(notices: &Notices) -> Vec<TabState> {
    notices
        .lock()
        .unwrap()
        .iter()
        .map(|info| info.state.clone())
        .collect()
}

#[cfg(windows)]
fn cmd_shell() -> ResolvedShell {
    ResolvedShell {
        kind: ShellKind::Cmd,
        path: std::env::var_os("COMSPEC")
            .expect("COMSPEC is set on Windows")
            .into(),
    }
}

// ConPTY holds the shell until the host answers its cursor query. With nobody attached the tab answers, but
// xterm (not these recorders) answers for an attached receiver; so the banner, printed once the query was
// answered, is awaited before any test attaches.
#[cfg(windows)]
fn running_tab() -> (Arc<Tab>, Notices) {
    let (tab, notices) = new_tab(std::env::temp_dir());
    tab.start_with(Some(cmd_shell()), 80, 24);
    assert_eq!(tab.state(), TabState::Running);
    assert!(wait_until(
        || String::from_utf8_lossy(&tab.snapshot()).contains("Microsoft Windows")
    ));
    (tab, notices)
}

#[test]
fn a_new_tab_is_starting_and_refuses_input() {
    let (tab, _) = new_tab(std::env::temp_dir());

    assert_eq!(tab.state(), TabState::Starting);
    assert_eq!(tab.input("dir\r").unwrap_err().code, "terminal-not-running");
}

#[test]
fn no_shell_on_the_machine_fails_the_tab_and_says_so() {
    let (tab, notices) = new_tab(std::env::temp_dir());

    tab.start_with(None, 80, 24);

    assert!(matches!(tab.state(), TabState::Failed { .. }));
    assert_eq!(states(&notices).len(), 1);
}

#[test]
fn a_missing_working_folder_fails_the_tab_naming_the_problem() {
    let missing = std::env::temp_dir().join("refract-tab-no-such-folder-5d1e");
    let (tab, _) = new_tab(missing);
    let shell = ResolvedShell {
        kind: ShellKind::Cmd,
        path: "does-not-matter.exe".into(),
    };

    tab.start_with(Some(shell), 80, 24);

    match tab.state() {
        TabState::Failed { message } => assert!(message.contains("working folder")),
        other => panic!("expected failed, got {other:?}"),
    }
}

#[test]
fn renaming_trims_notifies_and_rejects_a_bad_name() {
    let (tab, notices) = new_tab(std::env::temp_dir());

    let info = tab.rename("  build  ").unwrap();

    assert_eq!(info.name, "build");
    assert_eq!(notices.lock().unwrap().last().unwrap().name, "build");
    assert_eq!(tab.rename("   ").unwrap_err().code, "invalid-argument");
    assert_eq!(tab.info().name, "build");
}

#[test]
fn state_serialises_as_the_wire_shape() {
    let ended = serde_json::to_value(TabState::Ended { code: 7 }).unwrap();
    let failed = serde_json::to_value(TabState::Failed {
        message: "x".into(),
    })
    .unwrap();

    assert_eq!(ended, serde_json::json!({ "kind": "ended", "code": 7 }));
    assert_eq!(
        failed,
        serde_json::json!({ "kind": "failed", "message": "x" })
    );
    assert_eq!(
        serde_json::to_value(TabState::Starting).unwrap(),
        serde_json::json!({ "kind": "starting" })
    );
}

#[test]
fn sizes_are_clamped_and_remembered_for_a_tab_that_is_not_running() {
    let (tab, _) = new_tab(std::env::temp_dir());

    tab.resize(0, 9999);

    assert_eq!(tab.size(), (1, 200));
}

#[cfg(windows)]
#[test]
fn a_started_shell_streams_output_to_the_attached_receiver_in_order() {
    let (tab, _) = running_tab();
    let recorder = Recorder::default();
    tab.attach(Box::new(recorder.clone()), 100, 30);

    tab.input("echo first-marker-144\r").unwrap();
    assert!(wait_until(|| recorder.contains("first-marker-144")));
    tab.input("echo second-marker-144\r").unwrap();
    assert!(wait_until(|| recorder.contains("second-marker-144")));

    let text = String::from_utf8_lossy(&recorder.data()).into_owned();
    assert!(text.starts_with("\x1b[0m"));
    assert!(text.rfind("first-marker-144") < text.rfind("second-marker-144"));
    assert_eq!(tab.size(), (100, 30));
    tab.terminate();
}

#[cfg(windows)]
#[test]
fn a_detached_tab_keeps_reading_and_a_new_attach_replays_then_goes_live() {
    let (tab, _) = running_tab();
    tab.input("echo while-away-144\r").unwrap();
    assert!(wait_until(
        || String::from_utf8_lossy(&tab.snapshot()).contains("while-away-144")
    ));

    let recorder = Recorder::default();
    tab.attach(Box::new(recorder.clone()), 80, 24);
    assert!(recorder.contains("while-away-144"));
    tab.input("echo live-after-144\r").unwrap();

    assert!(wait_until(|| recorder.contains("live-after-144")));
    tab.terminate();
}

#[cfg(windows)]
#[test]
fn attaching_again_replaces_the_earlier_receiver() {
    let (tab, _) = running_tab();
    let first = Recorder::default();
    let second = Recorder::default();
    tab.attach(Box::new(first.clone()), 80, 24);
    tab.attach(Box::new(second.clone()), 80, 24);

    tab.input("echo only-second-144\r").unwrap();

    assert!(wait_until(|| second.contains("only-second-144")));
    assert!(!first.contains("only-second-144"));
    tab.terminate();
}

#[cfg(windows)]
#[test]
fn an_exiting_shell_ends_the_tab_with_its_code_and_the_last_frame_is_the_exit() {
    let (tab, notices) = running_tab();
    let recorder = Recorder::default();
    tab.attach(Box::new(recorder.clone()), 80, 24);

    tab.input("exit 7\r").unwrap();

    assert!(wait_until(|| tab.state() == TabState::Ended { code: 7 }));
    assert!(wait_until(|| recorder
        .frames()
        .last()
        .is_some_and(|frame| frame[0] == TAG_EXIT)));
    let exit = recorder.frames().pop().unwrap();
    assert_eq!(&exit[1..], &7i32.to_le_bytes());
    assert_eq!(
        states(&notices),
        vec![TabState::Running, TabState::Ended { code: 7 }]
    );
    assert_eq!(tab.input("dir\r").unwrap_err().code, "terminal-not-running");
}

#[cfg(windows)]
#[test]
fn attaching_after_the_shell_ended_replays_the_ring_then_the_exit() {
    let (tab, _) = running_tab();
    tab.input("echo before-exit-144 & exit 3\r").unwrap();
    assert!(wait_until(|| tab.state() == TabState::Ended { code: 3 }));

    let recorder = Recorder::default();
    tab.attach(Box::new(recorder.clone()), 80, 24);

    assert!(recorder.contains("before-exit-144"));
    let last = recorder.frames().pop().unwrap();
    assert_eq!(last[0], TAG_EXIT);
}

#[cfg(windows)]
#[test]
fn terminating_kills_the_shell_and_the_tab_ends() {
    let (tab, _) = running_tab();

    tab.terminate();

    assert!(wait_until(|| matches!(tab.state(), TabState::Ended { .. })));
}

#[cfg(windows)]
#[test]
fn a_running_child_is_seen_and_an_idle_shell_has_none() {
    let (tab, _) = running_tab();
    assert!(wait_until(|| !tab.snapshot().is_empty()));
    assert!(!tab.has_running_child());

    tab.input("ping -n 30 localhost > nul\r").unwrap();

    assert!(wait_until(|| tab.has_running_child()));
    tab.terminate();
}

#[cfg(windows)]
#[test]
fn input_over_the_call_limit_is_refused() {
    let (tab, _) = running_tab();
    let big = "a".repeat(crate::terminal::limits::INPUT_MAX_BYTES + 1);

    assert_eq!(tab.input(&big).unwrap_err().code, "invalid-argument");
    tab.terminate();
}

#[test]
fn a_tab_that_has_not_ended_cannot_be_restarted() {
    let (tab, notices) = new_tab(std::env::temp_dir());

    let err = tab.restart_with(None).unwrap_err();

    assert_eq!(err.code, "terminal-not-ended");
    assert_eq!(tab.state(), TabState::Starting);
    assert!(states(&notices).is_empty());
}

#[test]
fn restarting_a_failed_tab_tries_again_and_reports_each_change() {
    let (tab, notices) = new_tab(std::env::temp_dir());
    tab.start_with(None, 80, 24);

    let info = tab.restart_with(None).unwrap();

    assert!(matches!(info.state, TabState::Failed { .. }));
    let seen = states(&notices);
    assert_eq!(seen.len(), 3);
    assert_eq!(seen[1], TabState::Starting);
}

#[test]
fn a_tab_whose_folder_is_gone_stays_failed_on_restart_and_never_uses_another_folder() {
    let missing = std::env::temp_dir().join("refract-tab-no-such-folder-9c3a");
    let (tab, _) = new_tab(missing.clone());
    let shell = || ResolvedShell {
        kind: ShellKind::Cmd,
        path: "does-not-matter.exe".into(),
    };
    tab.start_with(Some(shell()), 80, 24);

    let info = tab.restart_with(Some(shell())).unwrap();

    match info.state {
        TabState::Failed { message } => {
            assert!(message.contains(&missing.display().to_string()));
        }
        other => panic!("expected failed, got {other:?}"),
    }
    assert_eq!(tab.cwd(), missing);
}

#[cfg(windows)]
#[test]
fn restarting_an_ended_shell_keeps_the_tab_and_empties_its_scrollback() {
    let (tab, notices) = running_tab();
    tab.input("echo before-restart-144 & exit 4\r").unwrap();
    assert!(wait_until(|| tab.state() == TabState::Ended { code: 4 }));
    let before = tab.info();

    let after = tab.restart_with(Some(cmd_shell())).unwrap();

    assert_eq!(after.state, TabState::Running);
    assert_eq!(
        (&after.id, &after.name, &after.cwd, after.order),
        (&before.id, &before.name, &before.cwd, before.order)
    );
    assert!(wait_until(
        || String::from_utf8_lossy(&tab.snapshot()).contains("Microsoft Windows")
    ));
    assert!(!String::from_utf8_lossy(&tab.snapshot()).contains("before-restart-144"));
    assert_eq!(
        states(&notices),
        vec![
            TabState::Running,
            TabState::Ended { code: 4 },
            TabState::Starting,
            TabState::Running
        ]
    );
    assert_eq!(
        tab.restart_with(Some(cmd_shell())).unwrap_err().code,
        "terminal-not-ended"
    );
    tab.terminate();
}

#[cfg(windows)]
#[test]
fn last_lines_reads_the_tail_without_colour_codes() {
    let (tab, _) = running_tab();
    tab.input("echo tail-marker-144\r").unwrap();
    assert!(wait_until(|| tab
        .read_output(OutputMode::LastLines)
        .text
        .contains("tail-marker-144")));

    let out = tab.read_output(OutputMode::LastLines);

    assert_eq!(out.source, crate::terminal::markers::OutputSource::Tail);
    assert!(!out.text.contains('\x1b'));
    tab.terminate();
}

#[cfg(windows)]
#[test]
fn recent_command_without_prompt_markers_falls_back_to_the_tail() {
    let (tab, _) = running_tab();

    let out = tab.read_output(OutputMode::RecentCommand);

    assert_eq!(out.source, crate::terminal::markers::OutputSource::Tail);
    assert!(out.text.contains("Microsoft Windows"));
    tab.terminate();
}

// PowerShell is the shell that prints the markers, so this runs the real thing, profile and all.
#[cfg(windows)]
#[test]
fn recent_command_is_the_last_commands_output_when_powershell_marks_its_prompt() {
    let shell = resolve_shell(&SystemEnv).expect("a shell exists");
    assert_ne!(
        shell.kind,
        ShellKind::Cmd,
        "PowerShell is installed with Windows"
    );
    let (tab, _) = new_tab(std::env::temp_dir());
    tab.start_with(Some(shell), 120, 30);
    assert!(wait_until(
        || String::from_utf8_lossy(&tab.snapshot()).contains("\x1b]133;A")
    ));

    tab.input("Write-Output 'marked-output-144'\r").unwrap();

    assert!(wait_until(|| {
        let out = tab.read_output(OutputMode::RecentCommand);
        out.source == crate::terminal::markers::OutputSource::Marker
            && out.text.contains("marked-output-144")
    }));
    let out = tab.read_output(OutputMode::RecentCommand);
    assert!(!out.text.contains('\x1b'));
    assert!(!out.truncated);
    tab.terminate();
}
