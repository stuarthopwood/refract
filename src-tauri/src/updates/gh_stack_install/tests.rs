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

impl GhRunner for &FakeGh {
    fn run(&self, args: &[&str]) -> impl Future<Output = Result<ProcessOutput, String>> + Send {
        (**self).run(args)
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

#[test]
fn listing_with_a_newer_tag_plans_to_keep_it() {
    assert_eq!(plan_from_listing(&listing("v0.4.0"), TAG), Plan::KeepNewer);
    assert_eq!(plan_from_listing(&listing("v0.10.0"), TAG), Plan::KeepNewer);
}

#[test]
fn listing_with_a_commit_ref_plans_a_replace() {
    assert_eq!(plan_from_listing(&listing("a1b2c3d"), TAG), Plan::Replace);
}

#[tokio::test]
async fn ensure_pinned_never_downgrades_a_newer_version() {
    let gh = FakeGh::new(|_| ok(&listing("v0.4.0")));
    ensure_pinned(&gh, TAG).await.unwrap();
    assert_eq!(gh.calls(), ["extension list"]);
}

#[tokio::test]
async fn a_failed_remove_stops_before_the_install() {
    let gh = FakeGh::new(|args| match args[1] {
        "list" => ok(&listing("v0.1.0")),
        _ => exit(1, "cannot remove"),
    });
    let detail = ensure_pinned(&gh, TAG).await.unwrap_err();
    assert!(detail.contains("cannot remove"), "{detail}");
    assert_eq!(gh.calls(), ["extension list", "extension remove stack"]);
}

#[tokio::test]
async fn a_failed_install_after_a_replace_says_gh_stack_is_now_missing() {
    let gh = FakeGh::new(|args| match args[1] {
        "list" => ok(&listing("v0.1.0")),
        "remove" => ok(""),
        _ => exit(1, "rate limit"),
    });
    let detail = ensure_pinned(&gh, TAG).await.unwrap_err();
    assert!(detail.contains("now missing"), "{detail}");
    assert!(detail.contains("rate limit"), "{detail}");
}

#[tokio::test]
async fn without_gh_the_step_fails_with_the_manual_hint() {
    let steps = Mutex::new(Vec::new());
    let result = install_with(
        || Err::<FakeGh, ()>(()),
        TAG,
        &|p: DependencyInstallProgress| steps.lock().unwrap().push((p.dependency, p.phase)),
    )
    .await;
    let detail = result.unwrap_err();
    assert!(detail.contains("not installed"), "{detail}");
    assert!(detail.contains("--pin v0.3.0"), "{detail}");
    assert_eq!(
        steps.into_inner().unwrap(),
        [(Dependency::GhStack, InstallPhase::Failed)]
    );
}

#[tokio::test]
async fn the_pinned_constant_is_what_the_install_path_requests() {
    let gh = FakeGh::new(|args| ok(if args[1] == "list" { "" } else { "installed" }));
    install_with(|| Ok::<_, ()>(&gh), GH_STACK_PINNED_TAG, &|_| {})
        .await
        .unwrap();
    assert_eq!(
        gh.calls().last().unwrap(),
        &format!("extension install github/gh-stack --pin {GH_STACK_PINNED_TAG}")
    );
}

#[tokio::test]
async fn a_gh_stack_failure_does_not_fail_the_gh_install() {
    let result = finish_github_cli_install(Ok(()), || ready(Err("no network".to_string()))).await;
    assert_eq!(result, Ok(()));
}

#[tokio::test]
async fn a_failed_gh_install_skips_the_gh_stack_step() {
    let ran = Mutex::new(false);
    let result = finish_github_cli_install(Err("gh failed".to_string()), || {
        *ran.lock().unwrap() = true;
        ready(Ok(()))
    })
    .await;
    assert_eq!(result, Err("gh failed".to_string()));
    assert!(!*ran.lock().unwrap());
}
