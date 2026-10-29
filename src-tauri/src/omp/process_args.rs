// `omp` launch argument builder, extracted from `process.rs` (issue #1212: keeps that baselined
// file shrinking) so it can also append the token guard arguments for every launch.

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
    let (guard_args, warnings) = super::token_guard::args::launch_args(&crate::data_dir()).await;
    args.extend(guard_args);
    (args, warnings)
}

/// Makes the agent trust the live OS certificate store (issue #1287), so TLS-inspecting networks
/// work without setup. Bun ignores the OS store unless `NODE_USE_SYSTEM_CA` is set; a rotated
/// inspection CA is picked up by restarting the agent. The child only: the user's environment is
/// untouched, and a value the user already set (and any `NODE_EXTRA_CA_CERTS`) wins.
pub(super) fn trust_system_ca(command: &mut tokio::process::Command) {
    if std::env::var_os("NODE_USE_SYSTEM_CA").is_none() {
        command.env("NODE_USE_SYSTEM_CA", "1");
    }
}
