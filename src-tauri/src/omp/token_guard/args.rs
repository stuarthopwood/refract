// The extra `omp` launch arguments (FR-001, FR-010, FR-017): `--config <overlay>` and
// `--append-system-prompt <rules file>`. A file that cannot be written is left out (the Session
// still launches) and a warning is returned with the arguments for the caller to surface.

use std::path::Path;

use super::{overlay, rules, values};

fn warn(warnings: &mut Vec<String>, reason: String) {
    log::warn!("token guard: {reason}");
    warnings.push(reason);
}

/// Regenerates the overlay and rules files in `dir` and returns the arguments for the files that
/// were written, plus a warning for each one that was not.
pub async fn launch_args(dir: &Path) -> (Vec<String>, Vec<String>) {
    let mut args = Vec::new();
    let mut warnings = Vec::new();
    match overlay::write(dir, &values::load(dir).await).await {
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
