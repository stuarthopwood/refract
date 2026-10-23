// The extra `omp` launch arguments (FR-001, FR-010, FR-017): `--config <overlay>` and
// `--append-system-prompt <rules file>`. A file that cannot be written is left out (the Session
// still launches) and one warning is queued for `session::agent::launch` to emit as a toast.

use std::path::Path;
use std::sync::Mutex;

use super::{overlay, rules, values};

static WARNINGS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Drains the warnings queued by launches since the last call.
pub fn take_warnings() -> Vec<String> {
    std::mem::take(&mut *WARNINGS.lock().unwrap())
}

fn warn(reason: String) {
    log::warn!("token guard: {reason}");
    WARNINGS.lock().unwrap().push(reason);
}

/// Regenerates the overlay and rules files in `dir` and returns the arguments for the files that
/// were written.
pub async fn launch_args(dir: &Path) -> Vec<String> {
    let mut args = Vec::new();
    match overlay::write(dir, &values::load(dir).await).await {
        Ok(path) => {
            args.push("--config".to_string());
            args.push(path.to_string_lossy().into_owned());
        }
        Err(err) => warn(format!("could not write the OMP overlay ({err})")),
    }
    match rules::write(dir).await {
        Ok(path) => {
            args.push("--append-system-prompt".to_string());
            args.push(path.to_string_lossy().into_owned());
        }
        Err(err) => warn(format!("could not write the rules file ({err})")),
    }
    args
}
