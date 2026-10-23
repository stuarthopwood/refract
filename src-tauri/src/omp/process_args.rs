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
