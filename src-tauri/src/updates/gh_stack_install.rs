// Installs the pinned `github/gh-stack` extension with the resolved gh (portable or on PATH). This is
// the one install path: the checklist, the post-gh-install step and Settings all end up here.
// No second binary is bundled; `gh extension install --pin` fetches the release itself.

use std::future::Future;
use std::path::PathBuf;
use std::time::Duration;

use super::dependency_install::{progress, Dependency, DependencyInstallProgress, InstallPhase};
use super::dependency_install_http::{
    exit_detail, fail_detail, run_process_capture, ProcessOutput,
};
use crate::github::gh_stack_state::parse_version;

const GH_STACK_REPO: &str = "github/gh-stack";
/// The only place the extension version is chosen; bump it here. `Outdated` in `gh_stack_state`
/// means "older than this tag".
pub(crate) const GH_STACK_PINNED_TAG: &str = "v0.3.0";
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
        // A prompt on a hidden child would wait forever for stdin nobody can answer.
        run_process_capture(
            &self.0,
            args,
            &[("GH_PROMPT_DISABLED", "1")],
            GH_STACK_TIMEOUT,
        )
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Plan {
    AlreadyPinned,
    Install,
    /// gh-stack is present at an older version; `install` would refuse, so remove it first.
    Replace,
    /// Newer than the pin: installing the pin would be a silent downgrade.
    KeepNewer,
}

/// Reads `gh extension list` output: tab-separated `name`, `repo`, `version` per line.
fn plan_from_listing(listing: &str, tag: &str) -> Plan {
    for line in listing.lines() {
        let mut fields = line.split('\t').map(str::trim).skip(1);
        if fields
            .next()
            .is_some_and(|repo| repo.eq_ignore_ascii_case(GH_STACK_REPO))
        {
            let listed = fields.next().unwrap_or_default();
            if listed == tag {
                return Plan::AlreadyPinned;
            }
            // An unreadable version (a commit ref) is not provably newer, so it is replaced.
            return match (parse_version(listed), parse_version(tag)) {
                (Some(listed), Some(pinned)) if listed > pinned => Plan::KeepNewer,
                _ => Plan::Replace,
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

/// Skips when at or above `tag`; otherwise installs it (replacing an older version first).
/// `gh extension install --force` is not an option: with an installed extension it upgrades to
/// the latest release and ignores `--pin`.
async fn ensure_pinned(gh: &impl GhRunner, tag: &str) -> Result<(), String> {
    // A failed listing is not fatal: attempt the install and let it report the real problem.
    let plan = match gh.run(&["extension", "list"]).await {
        Ok(listing) if listing.code == 0 => plan_from_listing(&listing.stdout, tag),
        _ => Plan::Install,
    };
    match plan {
        Plan::AlreadyPinned => return Ok(()),
        Plan::KeepNewer => {
            log::info!("gh-stack is newer than the pinned {tag}; leaving it alone");
            return Ok(());
        }
        Plan::Install | Plan::Replace => {}
    }
    let replacing = plan == Plan::Replace;
    if replacing {
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
    .map_err(|detail| {
        if replacing {
            format!(
                "The old gh-stack was removed, but installing {tag} failed, so gh-stack is now missing. {detail}"
            )
        } else {
            detail
        }
    })
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
    install_with(
        || crate::github::gh::resolve_gh().map(ResolvedGh),
        GH_STACK_PINNED_TAG,
        &on_progress,
    )
    .await
}

async fn install_with<G: GhRunner>(
    resolve: impl FnOnce() -> Result<G, ()>,
    tag: &str,
    on_progress: &impl Fn(DependencyInstallProgress),
) -> Result<(), String> {
    match resolve() {
        Ok(gh) => report_step(&gh, tag, on_progress).await,
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

/// The result of the gh install, once its gh-stack step has also run. gh itself is installed when
/// `gh_result` is Ok, so a gh-stack failure (already reported as its own step) must not fail it.
pub(super) async fn finish_github_cli_install<F: Future<Output = Result<(), String>>>(
    gh_result: Result<(), String>,
    install_stack: impl FnOnce() -> F,
) -> Result<(), String> {
    if gh_result.is_ok() {
        if let Err(detail) = install_stack().await {
            log::warn!("gh-stack install failed after the GitHub CLI install: {detail}");
        }
    }
    gh_result
}

#[cfg(test)]
mod tests;
