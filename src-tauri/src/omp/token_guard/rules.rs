// Refract rules file. Passed to `omp` by path so its text is not quoted on the Windows command line.

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

    /// The block's start; it runs to the end of the file.
    const BLOCK_HEADING: &str = "## Pick the right way to delegate";

    #[test]
    fn shipped_rules_stay_within_their_size_bound() {
        assert!((1000..=2900).contains(&RULES.len()));
    }

    #[test]
    fn the_rule_of_thumb_block_names_the_three_way_choice_within_900_chars() {
        let block = &RULES[RULES.find(BLOCK_HEADING).expect("block heading")..];
        assert!(block.chars().count() <= 900, "{}", block.chars().count());
        for term in ["subagent", "background agents", "child Session", "refract_create_session"] {
            assert!(block.contains(term), "{term}");
        }
    }
}
