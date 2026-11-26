use std::path::Path;

use super::process::{OmpProcessOptions, ProcessError};

/// The `--config` pair that carries plan mode's tool policy. A plan launch without it would let the
/// agent write files, so a failed write fails the launch instead of degrading to a warning.
async fn plan_overlay_args(dir: &Path) -> Result<[String; 2], ProcessError> {
    let path = super::plan_overlay::write(dir).await.map_err(|err| {
        ProcessError::new(format!(
            "OmpProcess: plan mode needs its tool policy file and it could not be written ({err}); not launching without it"
        ))
    })?;
    Ok(["--config".to_string(), path.to_string_lossy().into_owned()])
}

pub(super) async fn build_args(
    opts: &OmpProcessOptions,
) -> Result<(Vec<String>, Vec<String>), ProcessError> {
    let mut args = vec![
        "--mode".to_string(),
        "rpc-ui".to_string(),
        format!("--approval-mode={}", opts.approval_mode.omp_flag()),
    ];
    if opts.pass_cwd_flag {
        args.push(format!("--cwd={}", opts.cwd.display()));
    }
    if opts.no_session {
        args.push("--no-session".to_string());
    }
    let (guard_args, warnings) =
        super::token_guard::args::launch_args(&crate::data_dir(), opts.stacked_prs).await;
    args.extend(guard_args);
    if opts.plan_mode {
        args.extend(plan_overlay_args(&crate::data_dir()).await?);
    }
    if let Some(path) = &opts.extra_config {
        args.push("--config".to_string());
        args.push(path.to_string_lossy().into_owned());
    }
    Ok((args, warnings))
}

/// Makes the agent trust the OS certificate store, so TLS-inspecting networks work without setup.
pub(super) fn trust_system_ca(command: &mut tokio::process::Command) {
    if std::env::var_os("NODE_USE_SYSTEM_CA").is_none() {
        command.env("NODE_USE_SYSTEM_CA", "1");
    }
}

#[cfg(test)]
#[path = "process_args.test.rs"]
mod tests;
