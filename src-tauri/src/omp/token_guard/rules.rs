// The Refract-owned rules file (FR-010): shipped inside the app (`include_str!`), written to the
// data dir on every launch, and passed to `omp` by path with `--append-system-prompt` (which
// accepts text or a file; a path avoids quoting about 1.5k characters on a Windows command line).

use std::io;
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "refract-rules.md";
const RULES: &str = include_str!("../../../resources/refract-rules.md");

pub async fn write(dir: &Path) -> io::Result<PathBuf> {
    let file = dir.join(FILE_NAME);
    super::write_atomic_if_changed(&file, RULES.as_bytes()).await?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shipped_rules_are_about_one_and_a_half_k_chars() {
        assert!((1000..=2000).contains(&RULES.len()));
    }
}
