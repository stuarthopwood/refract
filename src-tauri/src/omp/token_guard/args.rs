// Extra `omp` launch arguments. An unwritable file is left out and reported as a warning; the session still launches.

use std::path::Path;

use super::{overlay, rules, values};

fn warn(warnings: &mut Vec<String>, reason: String) {
    log::warn!("token guard: {reason}");
    warnings.push(reason);
}

/// Regenerates the overlay and rules files in `dir` and returns the arguments for the files that
/// were written, plus a warning for each one that was not.
pub async fn launch_args(dir: &Path, plan_mode: Option<bool>) -> (Vec<String>, Vec<String>) {
    let mut args = Vec::new();
    let mut warnings = Vec::new();
    let mut loaded = values::load(dir).await;
    let written = match plan_mode {
        // A per-Session working mode overrides the global setting through its own overlay file.
        Some(plan) => {
            loaded.insert("plan.defaultOnStartup".to_string(), plan.into());
            overlay::write_plan_variant(dir, &loaded, plan).await
        }
        None => overlay::write(dir, &loaded).await,
    };
    match written {
        Ok(path) => {
            args.push("--config".to_string());
            args.push(path.to_string_lossy().into_owned());
        }
        Err(err) => warn(
            &mut warnings,
            format!("could not write the OMP overlay ({err})"),
        ),
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
