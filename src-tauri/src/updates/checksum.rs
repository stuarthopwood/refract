// Shared SHA-256 streaming/verification for the update installer (lane R11b, issue #794): used
// by both `installer.rs` (after download) and `install_on_quit.rs` (re-verified at quit). Gate
// finding (PR #829 round 1, perf MEDIUM): hashing used to `tokio::fs::read` the whole ~146MB
// installer into memory before hashing it, in both places -- streams through 64 KiB chunks
// inside `spawn_blocking` instead, so peak memory drops to 64 KiB and the hashing's own CPU work
// never blocks a tokio runtime thread.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

const CHUNK_SIZE: usize = 64 * 1024;

/// Streams `path` through SHA-256 in `CHUNK_SIZE` chunks on a blocking thread, returning the
/// lower-case hex digest. Never loads the whole file into memory at once.
pub(super) async fn hex_digest_file(path: &Path) -> Result<String, String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut file = File::open(&path).map_err(|err| err.to_string())?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; CHUNK_SIZE];
        loop {
            let n = file.read(&mut buf).map_err(|err| err.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect())
    })
    .await
    .map_err(|err| format!("hashing task panicked: {err}"))?
}

/// Case-insensitive comparison, treating an empty/missing `expected` value as never-matching
/// (mirrors the mined TS's own `!expected || actual !== expected` check -- `actual` here is
/// always already-lower-case hex from `hex_digest_file`, so only `expected` needs
/// case-insensitive handling).
pub(super) fn checksum_matches(actual_hex: &str, expected: &str) -> bool {
    !expected.is_empty() && actual_hex.eq_ignore_ascii_case(expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_case_insensitively() {
        assert!(checksum_matches("abc123", "ABC123"));
        assert!(checksum_matches("abc123", "abc123"));
    }

    #[test]
    fn rejects_digest_mismatch() {
        assert!(!checksum_matches("abc123", "def456"));
    }

    #[test]
    fn rejects_empty_expected() {
        assert!(!checksum_matches("abc123", ""));
    }

    #[tokio::test]
    async fn hex_digest_file_streams_correctly_for_a_multi_chunk_file() {
        let dir =
            std::env::temp_dir().join(format!("refract-checksum-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir)
            .await
            .expect("create temp dir");
        let file_path = dir.join("sample.bin");
        // Larger than one 64 KiB chunk, so the loop actually iterates more than once.
        let data = vec![0xABu8; 200 * 1024];
        tokio::fs::write(&file_path, &data)
            .await
            .expect("write sample file");

        let expected = Sha256::digest(&data)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();

        let actual = hex_digest_file(&file_path).await.expect("hash file");
        assert_eq!(actual, expected);

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
