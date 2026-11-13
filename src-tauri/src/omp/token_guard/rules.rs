// Refract rules file. Passed to `omp` by path so its text is not quoted on the Windows command line.

use std::io;
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "refract-rules.md";
const RULES: &str = include_str!("../../../resources/refract-rules.md");
const STACK_RULES: &str = include_str!("../../../resources/refract-stack-rules.md");

fn content(stacked: bool) -> String {
    if stacked {
        format!("{RULES}{STACK_RULES}")
    } else {
        RULES.to_string()
    }
}

/// One file either way, so there is still a single `--append-system-prompt` flag; the block follows the `stackedPullRequests` setting (#1867).
pub async fn write(dir: &Path, stacked: bool) -> io::Result<PathBuf> {
    let file = dir.join(FILE_NAME);
    super::write_atomic_if_changed(&file, content(stacked).as_bytes()).await?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shipped_rules_are_about_one_and_a_half_k_chars() {
        assert!((1000..=2000).contains(&RULES.len()));
    }

    #[test]
    fn stack_block_is_present_only_when_stacked() {
        assert!(content(true).contains("gh stack submit --auto"));
        assert!(!content(false).contains("gh stack"));
        assert!(STACK_RULES.len() < 1500);
    }

    #[tokio::test]
    async fn the_file_is_rewritten_when_the_toggle_flips() {
        let dir = std::env::temp_dir().join(format!("refract-rules-stack-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = write(&dir, true).await.unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("gh stack"));
        write(&dir, false).await.unwrap();
        assert!(!std::fs::read_to_string(&path).unwrap().contains("gh stack"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
