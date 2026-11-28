// SC-005 end to end: a marker printed through a real tab must not appear in the data dir or in anything
// logged. The source scan that backs this up is in `privacy.test.rs`.

use std::path::{Path, PathBuf};

const MARKER: &str = "PRIVACY-MARKER-144";

/// Every file under `dir` that holds `needle` as UTF-8 or UTF-16LE, and how many files were read.
fn files_holding(dir: &Path, needle: &str) -> (Vec<PathBuf>, usize) {
    let utf16: Vec<u8> = needle.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let (mut hits, mut read) = (Vec::new(), 0);
    let mut pending = vec![dir.to_path_buf()];
    while let Some(next) = pending.pop() {
        for entry in std::fs::read_dir(&next).expect("data dir is readable") {
            let path = entry.expect("directory entry").path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            read += 1;
            let holds = |hay: &[u8], pat: &[u8]| hay.windows(pat.len()).any(|w| w == pat);
            if holds(&bytes, needle.as_bytes()) || holds(&bytes, &utf16) {
                hits.push(path);
            }
        }
    }
    (hits, read)
}

#[test]
fn the_data_dir_scan_finds_a_marker_in_either_encoding_and_in_subfolders() {
    let dir = crate::test_scratch::path(format!(
        "refract-terminal-privacy-scan-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(dir.join("nested")).unwrap();
    std::fs::write(dir.join("plain.txt"), format!("a {MARKER} b")).unwrap();
    let wide: Vec<u8> = MARKER.encode_utf16().flat_map(u16::to_le_bytes).collect();
    std::fs::write(dir.join("nested").join("wide.bin"), wide).unwrap();
    std::fs::write(dir.join("clean.txt"), "nothing here").unwrap();

    let (hits, read) = files_holding(&dir, MARKER);

    assert_eq!(read, 3);
    assert_eq!(hits.len(), 2);
}

#[cfg(windows)]
mod live {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use serde_json::json;

    use super::{files_holding, MARKER};
    use crate::ipc::Dispatcher;
    use crate::terminal::handlers::tests::{add_session, make_state};
    use crate::terminal::{handlers, manager, persist};

    struct CaptureLogger(Mutex<Vec<String>>);

    impl log::Log for CaptureLogger {
        fn enabled(&self, _: &log::Metadata) -> bool {
            true
        }

        fn log(&self, record: &log::Record) {
            self.0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(record.args().to_string());
        }

        fn flush(&self) {}
    }

    static CAPTURED: CaptureLogger = CaptureLogger(Mutex::new(Vec::new()));

    fn wait_until(mut condition: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            if condition() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[tokio::test]
    async fn output_printed_through_a_tab_reaches_neither_the_data_dir_nor_the_log() {
        log::set_logger(&CAPTURED).expect("no other test installs a logger");
        log::set_max_level(log::LevelFilter::Trace);
        let (state, dir) = make_state("privacy").await;
        let worktree = dir.join("worktree");
        std::fs::create_dir_all(&worktree).unwrap();
        add_session(&state, "session-privacy", &worktree).await;
        let mut dispatcher = Dispatcher::new();
        handlers::register(&mut dispatcher);

        let created = dispatcher
            .dispatch(
                "terminal.create",
                state.clone(),
                vec![json!("session-privacy"), json!(100), json!(30)],
            )
            .await;
        assert_eq!(created["ok"], true, "{created}");
        let tab_id = created["value"]["id"].as_str().unwrap().to_string();
        let tab = manager().find(&tab_id).expect("the tab is registered");
        let snapshot = || String::from_utf8_lossy(&tab.snapshot()).into_owned();
        // The shell integration's first prompt marker means the shell is ready for input.
        assert!(
            wait_until(|| snapshot().contains("\x1b]133;A")),
            "the shell never showed a prompt"
        );

        // The command text is split so only the printed output holds the whole marker.
        let typed = dispatcher
            .dispatch(
                "terminal.input",
                state.clone(),
                vec![
                    json!(tab_id),
                    json!("Write-Output ('PRIVACY-' + 'MARKER-144')\r"),
                ],
            )
            .await;
        assert_eq!(typed["ok"], true, "{typed}");
        assert!(
            wait_until(|| snapshot().contains(MARKER)),
            "the marker never reached the tab"
        );

        // Rename writes the saved tab list, the one file a tab touches in the data dir.
        dispatcher
            .dispatch(
                "terminal.rename",
                state.clone(),
                vec![json!(tab_id), json!("privacy check")],
            )
            .await;
        assert!(
            persist::file_path(&dir).exists(),
            "the tab list was not saved, so the scan proves nothing"
        );
        let (hits, read) = files_holding(&dir, MARKER);
        assert!(read >= 2, "only {read} files scanned");
        assert!(hits.is_empty(), "marker found in {hits:?}");

        let closed = dispatcher
            .dispatch("terminal.close", state, vec![json!(tab_id), json!(true)])
            .await;
        assert_eq!(closed["ok"], true, "{closed}");
        let (hits, _) = files_holding(&dir, MARKER);
        assert!(hits.is_empty(), "marker found in {hits:?}");

        let logged = CAPTURED
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        assert!(
            logged.iter().all(|line| !line.contains(MARKER)),
            "marker found in the log: {logged:?}"
        );
    }
}
