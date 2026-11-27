// Shared fixtures for the updater tests: a scripted `gh` (release list/view/download) and a
// scratch-backed update store. Nothing here touches the network or a real installer.
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex as AsyncMutex;

use crate::github::gh_fake::{self, FakeGhGuard};

use super::state::{SharedUpdateState, UpdateState, UpdateStateStore};

pub(super) const INSTALLER_NAME: &str = "Refract-setup.exe";

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A release as `gh release list` / `gh release view` describe it.
pub(super) struct Release {
    tag: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<String>,
}

impl Release {
    /// A complete stable release: installer plus its checksum.
    pub(super) fn stable(tag: &str) -> Self {
        Self {
            tag: tag.to_string(),
            draft: false,
            prerelease: false,
            assets: vec![
                INSTALLER_NAME.to_string(),
                format!("{INSTALLER_NAME}.sha256"),
            ],
        }
    }

    pub(super) fn draft(mut self) -> Self {
        self.draft = true;
        self
    }

    pub(super) fn prerelease(mut self) -> Self {
        self.prerelease = true;
        self
    }

    pub(super) fn assets(mut self, names: &[&str]) -> Self {
        self.assets = names.iter().map(|name| name.to_string()).collect();
        self
    }
}

/// What `gh release download` does.
pub(super) enum Download {
    /// Writes each requested asset it has a payload for into `--dir`.
    Files,
    Fail(String),
    TimeOut,
}

pub(super) struct FakeGh {
    releases: Vec<Release>,
    payloads: HashMap<String, Vec<u8>>,
    auth_failure: Option<String>,
    list_failure: Option<String>,
    download: Download,
}

pub(super) type CallLog = Rc<RefCell<Vec<Vec<String>>>>;

impl FakeGh {
    pub(super) fn new(releases: Vec<Release>) -> Self {
        Self {
            releases,
            payloads: HashMap::new(),
            auth_failure: None,
            list_failure: None,
            download: Download::Files,
        }
    }

    /// Serves `installer` and a checksum file reading `checksum_hex` on download.
    pub(super) fn serving(mut self, installer: &[u8], checksum_hex: &str) -> Self {
        self.payloads
            .insert(INSTALLER_NAME.to_string(), installer.to_vec());
        self.payloads.insert(
            format!("{INSTALLER_NAME}.sha256"),
            format!("{checksum_hex}  {INSTALLER_NAME}\n").into_bytes(),
        );
        self
    }

    pub(super) fn auth_fails_with(mut self, stderr: &str) -> Self {
        self.auth_failure = Some(stderr.to_string());
        self
    }

    pub(super) fn list_fails_with(mut self, stderr: &str) -> Self {
        self.list_failure = Some(stderr.to_string());
        self
    }

    pub(super) fn download(mut self, download: Download) -> Self {
        self.download = download;
        self
    }

    /// Routes `gh` to this script until the guard drops; the log holds every call's arguments.
    pub(super) fn install(self) -> (FakeGhGuard, CallLog) {
        let calls: CallLog = Rc::new(RefCell::new(Vec::new()));
        let log = calls.clone();
        let guard = gh_fake::install(move |args| {
            log.borrow_mut().push(args.to_vec());
            self.respond(args)
        });
        (guard, calls)
    }

    fn respond(&self, args: &[String]) -> crate::github::gh::GhRawResult {
        let words: Vec<&str> = args.iter().map(String::as_str).collect();
        match words.as_slice() {
            ["auth", "status", ..] => match &self.auth_failure {
                Some(stderr) => gh_fake::failure(stderr.clone()),
                None => gh_fake::success(""),
            },
            ["release", "list", ..] => match &self.list_failure {
                Some(stderr) => gh_fake::failure(stderr.clone()),
                None => gh_fake::success(self.list_json()),
            },
            ["release", "view", tag, ..] => self.view_json(tag),
            ["release", "download", ..] => self.run_download(&words),
            other => gh_fake::failure(format!("unscripted gh call: {other:?}")),
        }
    }

    fn list_json(&self) -> String {
        let entries: Vec<_> = self
            .releases
            .iter()
            .map(|r| json!({ "tagName": r.tag, "isDraft": r.draft, "isPrerelease": r.prerelease }))
            .collect();
        json!(entries).to_string()
    }

    fn view_json(&self, tag: &str) -> crate::github::gh::GhRawResult {
        match self.releases.iter().find(|r| r.tag == tag) {
            Some(release) => {
                let assets: Vec<_> = release
                    .assets
                    .iter()
                    .map(|n| json!({ "name": n }))
                    .collect();
                gh_fake::success(json!({ "assets": assets }).to_string())
            }
            None => gh_fake::failure("release not found"),
        }
    }

    fn run_download(&self, words: &[&str]) -> crate::github::gh::GhRawResult {
        match &self.download {
            Download::Fail(stderr) => gh_fake::failure(stderr.clone()),
            Download::TimeOut => gh_fake::timeout(),
            Download::Files => {
                let dir = words
                    .windows(2)
                    .find(|pair| pair[0] == "--dir")
                    .map(|pair| PathBuf::from(pair[1]))
                    .expect("download passes --dir");
                for pair in words.windows(2).filter(|pair| pair[0] == "--pattern") {
                    if let Some(bytes) = self.payloads.get(pair[1]) {
                        std::fs::write(dir.join(pair[1]), bytes).expect("write fake asset");
                    }
                }
                gh_fake::success("")
            }
        }
    }
}

pub(super) fn calls_starting_with(calls: &CallLog, prefix: &[&str]) -> usize {
    calls
        .borrow()
        .iter()
        .filter(|call| {
            call.iter()
                .map(String::as_str)
                .take(prefix.len())
                .eq(prefix.iter().copied())
        })
        .count()
}

/// A scratch data dir (removed when the test's thread ends) and a store opened on it.
pub(super) async fn open_store(
    setup: impl FnOnce(&mut UpdateState),
) -> (SharedUpdateState, PathBuf) {
    let dir = crate::test_scratch::path(format!("refract-updates-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir)
        .await
        .expect("create data dir");
    let mut store = UpdateStateStore::open(&dir).await;
    store.update(setup).await;
    (Arc::new(AsyncMutex::new(store)), dir)
}

pub(super) fn updates_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("updates")
}
