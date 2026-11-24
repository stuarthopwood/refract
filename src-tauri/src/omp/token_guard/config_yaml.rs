// Drops one stale `parent.leaf` key from omp's global `config.yml`. omp can only reset keys it
// knows, and each omp line knows only one of the two rare-tools keys, so the other is cut by hand.
// Line-based on purpose: the file keeps the user's comments and ordering, and there is no YAML crate.

use std::io;
use std::path::Path;

use super::write_atomic_if_changed;

fn is_content(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty() && !trimmed.starts_with('#')
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches([' ', '\t']).len()
}

/// `key:` alone on the line (a trailing comment is fine), so the value is a block, not a scalar.
fn is_block_header(line: &str, key: &str) -> bool {
    let Some(rest) = line.trim_end().strip_prefix(key) else {
        return false;
    };
    let Some(rest) = rest.trim_start().strip_prefix(':') else {
        return false;
    };
    let rest = rest.trim();
    rest.is_empty() || rest.starts_with('#')
}

fn is_entry(line: &str, key: &str) -> bool {
    line.trim_start()
        .strip_prefix(key)
        .is_some_and(|rest| rest.trim_start().starts_with(':'))
}

/// `text` without `parent.leaf`, written either as `leaf:` inside a top-level `parent:` block or as
/// a top-level dotted `parent.leaf:` entry. `None` when the key is not there. A `parent:` block
/// left empty is dropped too, so omp never reads a null `parent`.
pub fn without_key(text: &str, parent: &str, leaf: &str) -> Option<String> {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let dotted = format!("{parent}.{leaf}");
    let mut remove = vec![false; lines.len()];
    let mut found = false;

    for (i, line) in lines.iter().enumerate() {
        if indent_of(line) == 0 && is_entry(line, &dotted) {
            remove[i] = true;
            found = true;
        }
    }

    for (i, line) in lines.iter().enumerate() {
        if indent_of(line) != 0 || !is_block_header(line, parent) {
            continue;
        }
        let block_end = lines[i + 1..]
            .iter()
            .position(|l| is_content(l) && indent_of(l) == 0)
            .map_or(lines.len(), |n| i + 1 + n);
        let child_indent = lines[i + 1..block_end]
            .iter()
            .find(|l| is_content(l))
            .map(|l| indent_of(l));
        let Some(child_indent) = child_indent else {
            continue;
        };
        let mut removed_here = false;
        for (j, line) in lines.iter().enumerate().take(block_end).skip(i + 1) {
            if is_content(line) && indent_of(line) == child_indent && is_entry(line, leaf) {
                remove[j] = true;
                removed_here = true;
            }
        }
        found |= removed_here;
        let anything_left = (i + 1..block_end).any(|j| is_content(lines[j]) && !remove[j]);
        if removed_here && !anything_left {
            remove[i] = true;
        }
    }

    found.then(|| {
        lines
            .iter()
            .zip(&remove)
            .filter(|(_, gone)| !**gone)
            .map(|(line, _)| *line)
            .collect()
    })
}

/// Removes `parent.leaf` from the YAML file at `path`. A missing file or key is not an error.
pub async fn remove_key_from_file(path: &Path, parent: &str, leaf: &str) -> io::Result<()> {
    let text = match tokio::fs::read_to_string(path).await {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    match without_key(&text, parent, leaf) {
        Some(updated) => write_atomic_if_changed(path, updated.as_bytes()).await,
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_the_leaf_and_keeps_its_siblings_and_comments() {
        let text = "tools:\n  artifactSpillThreshold: 30\n  # on demand\n  xdev: false\nother: 1\n";
        assert_eq!(
            without_key(text, "tools", "xdev").as_deref(),
            Some("tools:\n  artifactSpillThreshold: 30\n  # on demand\nother: 1\n")
        );
    }

    #[test]
    fn drops_a_parent_block_the_removal_leaves_empty() {
        let text = "a: 1\ntools:\n  xdev: true\nb: 2\n";
        assert_eq!(
            without_key(text, "tools", "xdev").as_deref(),
            Some("a: 1\nb: 2\n")
        );
    }

    #[test]
    fn drops_a_top_level_dotted_entry() {
        let text = "a: 1\ntools.xdev: false\nb: 2\n";
        assert_eq!(
            without_key(text, "tools", "xdev").as_deref(),
            Some("a: 1\nb: 2\n")
        );
    }

    #[test]
    fn leaves_other_keys_and_deeper_namesakes_alone() {
        assert_eq!(without_key("tools:\n  commands: true\n", "tools", "xdev"), None);
        assert_eq!(without_key("task:\n  xdev: 1\n", "tools", "xdev"), None);
        assert_eq!(
            without_key("tools:\n  nested:\n    xdev: 1\n", "tools", "xdev"),
            None
        );
        assert_eq!(without_key("tools: {xdev: true}\n", "tools", "xdev"), None);
        assert_eq!(without_key("", "tools", "xdev"), None);
    }

    #[test]
    fn keeps_crlf_line_endings() {
        let text = "tools:\r\n  commands: true\r\n  xdev: false\r\n";
        assert_eq!(
            without_key(text, "tools", "xdev").as_deref(),
            Some("tools:\r\n  commands: true\r\n")
        );
    }

    #[tokio::test]
    async fn rewrites_the_file_and_ignores_a_missing_one() {
        let dir = std::env::temp_dir().join(format!("refract-yaml-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config.yml");
        std::fs::write(&file, "tools:\n  commands: true\n  xdev: false\n").unwrap();
        remove_key_from_file(&file, "tools", "xdev").await.unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "tools:\n  commands: true\n"
        );
        remove_key_from_file(&dir.join("absent.yml"), "tools", "xdev")
            .await
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
