// Extra `omp` launch arguments. An unwritable file is left out and reported as a warning; the session still launches.

use std::path::Path;

use super::{legacy, migrate, overlay, rules};

fn warn(warnings: &mut Vec<String>, reason: String) {
    log::warn!("token guard: {reason}");
    warnings.push(reason);
}

/// Regenerates the rules file in `dir` (and a one-key plan overlay when the Session overrides the working mode) and returns the arguments for the files that
/// were written, plus a warning for each one that was not. Until the migration to the global omp config has succeeded, the legacy overlay still applies.
pub async fn launch_args(dir: &Path, plan_mode: Option<bool>) -> (Vec<String>, Vec<String>) {
    let mut args = Vec::new();
    let mut warnings = Vec::new();
    let written = if migrate::ensure(dir).await {
        match plan_mode {
            Some(plan) => Some(overlay::write_plan_variant(dir, plan).await),
            None => None,
        }
    } else {
        overlay::note_legacy_launch();
        let mut legacy = legacy::effective(dir).await;
        Some(match plan_mode {
            Some(plan) => {
                legacy.insert("plan.defaultOnStartup".to_string(), plan.into());
                overlay::write_legacy_plan_variant(dir, &legacy, plan).await
            }
            None => overlay::write_legacy(dir, &legacy).await,
        })
    };
    match written {
        Some(Ok(path)) => {
            args.push("--config".to_string());
            args.push(path.to_string_lossy().into_owned());
        }
        Some(Err(err)) => warn(
            &mut warnings,
            format!("could not write the agent overlay ({err})"),
        ),
        None => {}
    }
    match rules::write(dir).await {
        Ok(path) => {
            args.push("--append-system-prompt".to_string());
            args.push(path.to_string_lossy().into_owned());
        }
        Err(err) => warn(
            &mut warnings,
            format!("could not write the rules file ({err})"),
        ),
    }
    (args, warnings)
}
