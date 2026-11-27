// Installs the pinned `github/gh-stack` extension with the resolved gh (portable or on PATH).
// No second binary is bundled; `gh extension install --pin` fetches the release itself.

use std::future::Future;
use std::path::PathBuf;
use std::time::Duration;

use super::dependency_install::{progress, Dependency, DependencyInstallProgress, InstallPhase};
use super::dependency_install_http::{
    exit_detail, fail_detail, run_process_capture, ProcessOutput,
};

const GH_STACK_REPO: &str = "github/gh-stack";
/// The only place the extension version is chosen; bump it here.
const GH_STACK_PINNED_TAG: &str = "v0.3.0";
/// What `gh extension remove` takes: the extension name without the `gh-` prefix.
const GH_STACK_EXTENSION_NAME: &str = "stack";
const GH_STACK_TIMEOUT: Duration = Duration::from_secs(2 * 60);

/// Runs `gh <args>`; abstracted so tests never launch a real gh.
trait GhRunner {
    fn run(&self, args: &[&str]) -> impl Future<Output = Result<ProcessOutput, String>> + Send;
}

struct ResolvedGh(PathBuf);

impl GhRunner for ResolvedGh {
    fn run(&self, args: &[&str]) -> impl Future<Output = Result<ProcessOutput, String>> + Send {
        run_process_capture(&self.0, args, GH_STACK_TIMEOUT)
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Plan {
    AlreadyPinned,
    Install,
    /// gh-stack is present at another version; `install` would refuse, so remove it first.
    Replace,
}

/// Reads `gh extension list` output: tab-separated `name`, `repo`, `version` per line.
fn plan_from_listing(listing: &str, tag: &str) -> Plan {
    for line in listing.lines() {
        let mut fields = line.split('\t').map(str::trim).skip(1);
        if fields
            .next()
            .is_some_and(|repo| repo.eq_ignore_ascii_case(GH_STACK_REPO))
        {
            return if fields.next() == Some(tag) {
                Plan::AlreadyPinned
            } else {
                Plan::Replace
            };
        }
    }
    Plan::Install
}

fn manual_hint() -> String {
    format!(
        "If this keeps failing, run `gh extension install {GH_STACK_REPO} --pin {GH_STACK_PINNED_TAG}` yourself and choose Re-check."
    )
}

async fn run_checked(gh: &impl GhRunner, args: &[&str], what: &str) -> Result<(), String> {
    let output = gh
        .run(args)
        .await
        .map_err(|err| fail_detail(&err, &manual_hint()))?;
    if output.code != 0 {
        let message = if output.stderr.is_empty() {
            &output.stdout
        } else {
            &output.stderr
        };
        return Err(fail_detail(
            &exit_detail(what, output.code, message),
            &manual_hint(),
        ));
    }
    Ok(())
}

/// Skips when already at `tag`; otherwise installs it (replacing another version first).
async fn ensure_pinned(gh: &impl GhRunner, tag: &str) -> Result<(), String> {
    // A failed listing is not fatal: attempt the install and let it report the real problem.
    let plan = match gh.run(&["extension", "list"]).await {
        Ok(listing) if listing.code == 0 => plan_from_listing(&listing.stdout, tag),
        _ => Plan::Install,
    };
    if plan == Plan::AlreadyPinned {
        return Ok(());
    }
    if plan == Plan::Replace {
        run_checked(
            gh,
            &["extension", "remove", GH_STACK_EXTENSION_NAME],
            "gh extension remove",
        )
        .await?;
    }
    run_checked(
        gh,
        &["extension", "install", GH_STACK_REPO, "--pin", tag],
        "gh extension install",
    )
    .await
}

async fn report_step(
    gh: &impl GhRunner,
    tag: &str,
    on_progress: &impl Fn(DependencyInstallProgress),
) -> Result<(), String> {
    on_progress(progress(
        Dependency::GhStack,
        InstallPhase::Running,
        None,
        None,
    ));
    match ensure_pinned(gh, tag).await {
        Ok(()) => {
            on_progress(progress(
                Dependency::GhStack,
                InstallPhase::Done,
                None,
                None,
            ));
            Ok(())
        }
        Err(detail) => {
            on_progress(progress(
                Dependency::GhStack,
                InstallPhase::Failed,
                Some(detail.clone()),
                None,
            ));
            Err(detail)
        }
    }
}

/// Installs the pinned gh-stack extension into the resolved gh; idempotent. Reports its own
/// `gh-stack` step on `on_progress`, including `failed`.
pub async fn install_gh_stack(
    on_progress: impl Fn(DependencyInstallProgress),
) -> Result<(), String> {
    match crate::github::gh::resolve_gh() {
        Ok(path) => report_step(&ResolvedGh(path), GH_STACK_PINNED_TAG, &on_progress).await,
        Err(()) => {
            let detail = fail_detail(
                "The GitHub CLI (gh) is not installed or not on PATH.",
                &manual_hint(),
            );
            on_progress(progress(
                Dependency::GhStack,
                InstallPhase::Failed,
                Some(detail.clone()),
                None,
            ));
            Err(detail)
        }
    }
}

#[cfg(test)]
mod tests;
