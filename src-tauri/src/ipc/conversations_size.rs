// Disk size of one Conversation: its `.jsonl` plus the same-stem artifact folder OMP keeps beside it.
// Blocking; callers run it on `spawn_blocking`. Links are never followed, so a planted link cannot
// inflate the total or point the walk outside the Sessions folder.

use std::path::{Path, PathBuf};

const JSONL_SUFFIX: &str = ".jsonl";

/// The artifact folder beside `file`: the same path with `.jsonl` dropped.
pub(crate) fn artifact_dir(file: &Path) -> PathBuf {
    let text = file.to_string_lossy();
    match text.strip_suffix(JSONL_SUFFIX) {
        Some(stem) => PathBuf::from(stem),
        None => file.to_path_buf(),
    }
}

/// Bytes of `file` plus its artifact folder; anything unreadable or missing counts as zero.
pub(crate) fn conversation_size_bytes(file: &Path) -> u64 {
    let own = std::fs::symlink_metadata(file)
        .ok()
        .filter(|meta| meta.is_file())
        .map_or(0, |meta| meta.len());
    own + tree_size_bytes(&artifact_dir(file))
}

fn tree_size_bytes(root: &Path) -> u64 {
    // A link at the root itself is skipped for the same reason as links below it.
    let root_is_dir = std::fs::symlink_metadata(root).is_ok_and(|meta| meta.is_dir());
    if !root_is_dir {
        return 0;
    }
    let mut total = 0u64;
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                total += entry.metadata().map_or(0, |meta| meta.len());
            }
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let dir = crate::test_scratch::path(format!("conv-size-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn artifact_dir_drops_the_jsonl_suffix() {
        assert_eq!(
            artifact_dir(Path::new("C:/s/2026-11-11T00-00-00-000Z_abc.jsonl")),
            PathBuf::from("C:/s/2026-11-11T00-00-00-000Z_abc")
        );
    }

    #[test]
    fn size_counts_the_jsonl_and_every_nested_artifact_file() {
        let dir = scratch("sum");
        let file = dir.join("2026-11-11T00-00-00-000Z_abc.jsonl");
        std::fs::write(&file, [0u8; 10]).unwrap();
        let nested = artifact_dir(&file).join("deep");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(artifact_dir(&file).join("a.bin"), [0u8; 5]).unwrap();
        std::fs::write(nested.join("b.bin"), [0u8; 7]).unwrap();

        assert_eq!(conversation_size_bytes(&file), 22);
    }

    #[test]
    fn size_without_an_artifact_folder_is_the_jsonl_alone() {
        let dir = scratch("alone");
        let file = dir.join("2026-11-11T00-00-00-000Z_abc.jsonl");
        std::fs::write(&file, [0u8; 10]).unwrap();

        assert_eq!(conversation_size_bytes(&file), 10);
    }

    #[test]
    fn size_of_a_missing_conversation_is_zero() {
        let dir = scratch("missing");

        assert_eq!(
            conversation_size_bytes(&dir.join("2026-11-11T00-00-00-000Z_abc.jsonl")),
            0
        );
    }

    /// Skips outside CI when the OS refuses link creation, fails in CI.
    #[test]
    fn size_does_not_follow_a_junction_out_of_the_artifact_folder() {
        let dir = scratch("link");
        let file = dir.join("2026-11-11T00-00-00-000Z_abc.jsonl");
        std::fs::write(&file, [0u8; 10]).unwrap();
        let outside = scratch("link-outside");
        std::fs::write(outside.join("big.bin"), [0u8; 1000]).unwrap();
        let artifact = artifact_dir(&file);
        std::fs::create_dir_all(&artifact).unwrap();
        let junction = artifact.join("out");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .output()
            .is_ok_and(|out| out.status.success());
        if !made {
            if std::env::var("CI").is_ok() {
                panic!("junction creation failed in CI: {junction:?} -> {outside:?}");
            }
            eprintln!("skipping junction test: mklink refused (sandbox restriction, not CI)");
            return;
        }

        assert_eq!(conversation_size_bytes(&file), 10);
    }
}
