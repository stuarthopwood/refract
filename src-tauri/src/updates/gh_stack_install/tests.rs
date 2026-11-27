use std::future::ready;
use std::sync::Mutex;

use super::*;

const TAG: &str = "v0.3.0";

type Response = Result<ProcessOutput, String>;
type Responder = Box<dyn Fn(&[&str]) -> Response + Send + Sync>;

/// Records every call and answers from a script, so no real gh ever runs.
struct FakeGh {
    calls: Mutex<Vec<Vec<String>>>,
    respond: Responder,
}

impl FakeGh {
    fn new(respond: impl Fn(&[&str]) -> Response + Send + Sync + 'static) -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            respond: Box::new(respond),
        }
    }

    fn calls(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|args| args.join(" "))
            .collect()
    }
}

impl GhRunner for FakeGh {
    fn run(&self, args: &[&str]) -> impl Future<Output = Result<ProcessOutput, String>> + Send {
        self.calls
            .lock()
            .unwrap()
            .push(args.iter().map(|a| a.to_string()).collect());
        ready((self.respond)(args))
    }
}

fn ok(stdout: &str) -> Result<ProcessOutput, String> {
    Ok(ProcessOutput {
        code: 0,
        stdout: stdout.to_string(),
        stderr: String::new(),
    })
}

fn exit(code: i32, stderr: &str) -> Result<ProcessOutput, String> {
    Ok(ProcessOutput {
        code,
        stdout: String::new(),
        stderr: stderr.to_string(),
    })
}

fn listing(version: &str) -> String {
    format!("gh stack\tgithub/gh-stack\t{version}\ngh dash\tdlvhdr/gh-dash\tv4.0.0")
}

#[test]
fn listing_with_the_pinned_tag_plans_a_skip() {
    assert_eq!(plan_from_listing(&listing(TAG), TAG), Plan::AlreadyPinned);
}

#[test]
fn listing_with_another_tag_plans_a_replace() {
    assert_eq!(plan_from_listing(&listing("v0.1.0"), TAG), Plan::Replace);
}

#[test]
fn listing_without_gh_stack_plans_an_install() {
    let other = "gh dash\tdlvhdr/gh-dash\tv4.0.0";
    assert_eq!(plan_from_listing(other, TAG), Plan::Install);
    assert_eq!(plan_from_listing("", TAG), Plan::Install);
}

#[tokio::test]
async fn ensure_pinned_skips_the_install_when_already_at_the_tag() {
    let gh = FakeGh::new(|_| ok(&listing(TAG)));
    ensure_pinned(&gh, TAG).await.unwrap();
    assert_eq!(gh.calls(), ["extension list"]);
}

#[tokio::test]
async fn ensure_pinned_installs_with_the_pin_when_absent() {
    let gh = FakeGh::new(|args| ok(if args[1] == "list" { "" } else { "installed" }));
    ensure_pinned(&gh, TAG).await.unwrap();
    assert_eq!(
        gh.calls(),
        [
            "extension list",
            "extension install github/gh-stack --pin v0.3.0"
        ]
    );
}

#[tokio::test]
async fn ensure_pinned_replaces_a_different_version() {
    let gh = FakeGh::new(|args| {
        ok(if args[1] == "list" {
            "gh stack\tgithub/gh-stack\tv0.1.0"
        } else {
            ""
        })
    });
    ensure_pinned(&gh, TAG).await.unwrap();
    assert_eq!(
        gh.calls(),
        [
            "extension list",
            "extension remove stack",
            "extension install github/gh-stack --pin v0.3.0"
        ]
    );
}

#[tokio::test]
async fn ensure_pinned_still_installs_when_the_listing_fails() {
    let gh = FakeGh::new(|args| {
        if args[1] == "list" {
            exit(1, "boom")
        } else {
            ok("")
        }
    });
    ensure_pinned(&gh, TAG).await.unwrap();
    assert_eq!(gh.calls().len(), 2);
}

#[tokio::test]
async fn ensure_pinned_reports_a_failed_install_with_the_manual_hint() {
    let gh = FakeGh::new(|args| {
        if args[1] == "list" {
            ok("")
        } else {
            exit(1, "HTTP 403: rate limit")
        }
    });
    let detail = ensure_pinned(&gh, TAG).await.unwrap_err();
    assert!(detail.contains("rate limit"), "{detail}");
    assert!(detail.contains("--pin v0.3.0"), "{detail}");
}

#[tokio::test]
async fn ensure_pinned_reports_a_process_that_cannot_launch() {
    let gh = FakeGh::new(|args| {
        if args[1] == "list" {
            ok("")
        } else {
            Err("failed to launch gh".to_string())
        }
    });
    let detail = ensure_pinned(&gh, TAG).await.unwrap_err();
    assert!(detail.contains("failed to launch gh"), "{detail}");
}

type Step = (Dependency, InstallPhase, Option<String>);

fn collect_steps(gh: &FakeGh) -> (Result<(), String>, Vec<Step>) {
    let steps = Mutex::new(Vec::new());
    let result = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(report_step(gh, TAG, &|p: DependencyInstallProgress| {
            steps
                .lock()
                .unwrap()
                .push((p.dependency, p.phase, p.detail));
        }));
    (result, steps.into_inner().unwrap())
}

#[test]
fn report_step_emits_running_then_done_for_a_skip() {
    let gh = FakeGh::new(|_| ok(&listing(TAG)));
    let (result, steps) = collect_steps(&gh);
    assert!(result.is_ok());
    assert_eq!(
        steps,
        [
            (Dependency::GhStack, InstallPhase::Running, None),
            (Dependency::GhStack, InstallPhase::Done, None),
        ]
    );
}

#[test]
fn report_step_emits_failed_with_detail_and_returns_the_error() {
    let gh = FakeGh::new(|args| {
        if args[1] == "list" {
            ok("")
        } else {
            exit(1, "no network")
        }
    });
    let (result, steps) = collect_steps(&gh);
    let detail = result.unwrap_err();
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[1].0, Dependency::GhStack);
    assert_eq!(steps[1].1, InstallPhase::Failed);
    assert_eq!(steps[1].2.as_deref(), Some(detail.as_str()));
}
