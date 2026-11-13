use super::process::OmpProcessOptions;

pub(super) async fn build_args(opts: &OmpProcessOptions) -> (Vec<String>, Vec<String>) {
    let mut args = vec![
        "--mode".to_string(),
        "rpc-ui".to_string(),
        format!("--approval-mode={}", opts.approval_mode.omp_flag()),
    ];
    if opts.no_session {
        args.push("--no-session".to_string());
    }
    let (guard_args, warnings) =
        super::token_guard::args::launch_args(&crate::data_dir(), opts.plan_mode, opts.stacked_prs)
            .await;
    args.extend(guard_args);
    if let Some(path) = &opts.extra_config {
        args.push("--config".to_string());
        args.push(path.to_string_lossy().into_owned());
    }
    (args, warnings)
}

/// Makes the agent trust the OS certificate store, so TLS-inspecting networks work without setup.
pub(super) fn trust_system_ca(command: &mut tokio::process::Command) {
    if std::env::var_os("NODE_USE_SYSTEM_CA").is_none() {
        command.env("NODE_USE_SYSTEM_CA", "1");
    }
}
