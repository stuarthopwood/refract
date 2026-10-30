// Real OS watches, no fake: only `ReadDirectoryChangesW` proves the debounce behaviour.
use super::*;
use std::path::PathBuf;
use std::sync::mpsc::channel;

fn temp_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "refract-watch-test-{label}-{}",
        uuid::Uuid::new_v4()
    ))
}

#[test]
fn relative_directory_for_a_top_level_file_is_the_empty_string() {
    let root = PathBuf::from("C:\\wt");
    let changed = root.join("file.txt");
    assert_eq!(relative_directory_for(&root, &changed), Some(String::new()));
}

#[test]
fn relative_directory_for_a_nested_file_is_its_parent() {
    let root = PathBuf::from("C:\\wt");
    let changed = root.join("sub").join("deep").join("file.txt");
    assert_eq!(
        relative_directory_for(&root, &changed),
        Some("sub/deep".to_string())
    );
}

#[test]
fn a_dot_git_path_is_filtered_out() {
    let root = PathBuf::from("C:\\wt");
    let changed = root.join(".git").join("HEAD");
    assert_eq!(relative_directory_for(&root, &changed), None);
}

#[test]
fn a_path_outside_root_is_filtered_out() {
    let root = PathBuf::from("C:\\wt");
    let changed = PathBuf::from("C:\\elsewhere\\file.txt");
    assert_eq!(relative_directory_for(&root, &changed), None);
}

#[test]
fn a_missing_root_never_produces_a_handle() {
    let root = temp_root("missing");
    let handle = watch_directory(&root, |_| {}, || {});
    assert!(handle.is_none());
}

#[test]
fn a_file_created_inside_the_root_is_reported_for_the_empty_relative_path() {
    let root = temp_root("create");
    std::fs::create_dir_all(&root).unwrap();
    let (tx, rx) = channel::<String>();
    let handle = watch_directory(
        &root,
        move |rel| {
            let _ = tx.send(rel);
        },
        || {},
    );
    assert!(handle.is_some());
    std::thread::sleep(Duration::from_millis(300));
    std::fs::write(root.join("new.txt"), b"hi").unwrap();
    let received = rx.recv_timeout(Duration::from_secs(5));
    assert_eq!(received, Ok(String::new()));
    handle.unwrap().stop();
}

#[test]
fn a_change_under_a_subdirectory_is_reported_for_that_subdirectory() {
    let root = temp_root("subdir-change");
    std::fs::create_dir_all(root.join("sub")).unwrap();
    let (tx, rx) = channel::<String>();
    let handle = watch_directory(
        &root,
        move |rel| {
            let _ = tx.send(rel);
        },
        || {},
    );
    assert!(handle.is_some());
    std::thread::sleep(Duration::from_millis(300));
    std::fs::write(root.join("sub").join("new.txt"), b"hi").unwrap();
    let received = rx.recv_timeout(Duration::from_secs(5));
    assert_eq!(received, Ok("sub".to_string()));
    handle.unwrap().stop();
}

#[test]
fn a_dot_git_change_never_triggers_a_callback() {
    let root = temp_root("gitignore");
    std::fs::create_dir_all(root.join(".git")).unwrap();
    let (tx, rx) = channel::<String>();
    let handle = watch_directory(
        &root,
        move |rel| {
            let _ = tx.send(rel);
        },
        || {},
    );
    assert!(handle.is_some());
    std::thread::sleep(Duration::from_millis(300));
    std::fs::write(root.join(".git").join("HEAD"), b"ref: refs/heads/main").unwrap();
    // A later real change makes a wrongly queued `.git` callback fail first, not just slow the test.
    std::fs::write(root.join("real.txt"), b"hi").unwrap();
    let received = rx.recv_timeout(Duration::from_secs(5));
    assert_eq!(received, Ok(String::new()));
    handle.unwrap().stop();
}

#[test]
fn stop_prevents_further_callbacks() {
    let root = temp_root("stop");
    std::fs::create_dir_all(&root).unwrap();
    let (tx, rx) = channel::<String>();
    let handle = watch_directory(
        &root,
        move |rel| {
            let _ = tx.send(rel);
        },
        || {},
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    handle.stop();
    std::thread::sleep(Duration::from_millis(300));
    std::fs::write(root.join("after-stop.txt"), b"hi").unwrap();
    // Either a timeout or a disconnect proves no callback fired.
    let received = rx.recv_timeout(Duration::from_secs(1));
    assert!(received.is_err());
}

#[test]
fn a_cloned_handle_compares_equal_by_identity_a_fresh_one_does_not() {
    let root = temp_root("identity");
    std::fs::create_dir_all(&root).unwrap();
    let handle = watch_directory(&root, |_| {}, || {}).unwrap();
    let cloned = handle.clone();
    assert!(handle.same_as(&cloned));

    let root2 = temp_root("identity-2");
    std::fs::create_dir_all(&root2).unwrap();
    let other = watch_directory(&root2, |_| {}, || {}).unwrap();
    assert!(!handle.same_as(&other));
    handle.stop();
    other.stop();
}

#[test]
fn removing_the_watched_root_fires_on_fatal_once() {
    let root = temp_root("root-removed");
    std::fs::create_dir_all(&root).unwrap();
    let fatal_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let fatal_count_cb = fatal_count.clone();
    let handle = watch_directory(
        &root,
        |_| {},
        move || {
            fatal_count_cb.fetch_add(1, Ordering::SeqCst);
        },
    );
    assert!(handle.is_some());
    std::thread::sleep(Duration::from_millis(300));
    // Windows can refuse removing a directory while a watch handle holds it open.
    if std::fs::remove_dir_all(&root).is_err() {
        if std::env::var("CI").is_ok() {
            panic!("remove_dir_all failed in CI; the fatal-detection path was never exercised");
        }
        eprintln!(
            "skipping fatal-detection assertions: remove_dir_all failed (EPERM-equivalent, not CI)"
        );
        return;
    }
    // Poll with a generous bound: under load the liveness tick can be delayed (#1333).
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while fatal_count.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(
        fatal_count.load(Ordering::SeqCst),
        1,
        "must fire once after the root is removed"
    );
    // Wait past several liveness ticks so "fired once" is distinguishable from "fires repeatedly".
    std::thread::sleep(Duration::from_secs(3));
    assert_eq!(
        fatal_count.load(Ordering::SeqCst),
        1,
        "must never fire a second time"
    );
}

#[test]
fn a_burst_of_writes_in_the_same_directory_produces_one_callback() {
    let root = temp_root("burst");
    std::fs::create_dir_all(&root).unwrap();
    let call_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let call_count_cb = call_count.clone();
    // A 2s window, wider than production's 200ms, absorbs OS event jitter across 20 creates.
    let handle = watch_directory_with_debounce(
        &root,
        move |_rel| {
            call_count_cb.fetch_add(1, Ordering::SeqCst);
        },
        || {},
        Duration::from_secs(2),
        true,
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    for i in 0..20 {
        std::fs::write(root.join(format!("burst-{i}.txt")), b"x").unwrap();
    }
    std::thread::sleep(Duration::from_millis(2500));
    let count = call_count.load(Ordering::SeqCst);
    assert_eq!(
        count, 1,
        "a burst within one debounce window must produce exactly one callback, got {count}"
    );
    handle.stop();
}
