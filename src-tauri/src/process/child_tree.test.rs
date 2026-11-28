use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::*;

fn wait_until(mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

#[test]
fn console_hosts_are_recognised_by_image_name_in_any_case() {
    assert!(is_console_host("conhost.exe"));
    assert!(is_console_host("OpenConsole.exe"));
    assert!(!is_console_host("ping.exe"));
}

#[cfg(target_os = "windows")]
#[test]
fn a_running_child_is_seen_and_the_whole_tree_is_killed() {
    // `cmd /c ping` keeps `ping.exe` alive as cmd's child for about 30 seconds.
    let mut root = Command::new("cmd")
        .args(["/c", "ping", "-n", "30", "localhost"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .spawn()
        .expect("spawn cmd");
    let pid = root.id();

    assert!(
        wait_until(|| has_child_process(pid)),
        "the ping child should be reported"
    );

    kill_tree(pid);

    assert!(
        wait_until(|| root.try_wait().expect("poll root").is_some()),
        "the root should be gone"
    );
    assert!(
        wait_until(|| !has_child_process(pid)),
        "no child should remain once the tree is killed"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn a_process_without_children_reports_none() {
    let mut root = Command::new("cmd")
        .args(["/c", "pause"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .expect("spawn cmd");

    assert!(!has_child_process(root.id()));

    kill_tree(root.id());
    let _ = root.wait();
}

#[test]
fn an_unknown_pid_has_no_children_and_kills_nothing() {
    assert!(!has_child_process(u32::MAX - 1));
    kill_tree(u32::MAX - 1);
}
