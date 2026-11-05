// Streams the ~146 MB installer in 64 KiB chunks on a blocking thread, so it is never fully in memory.

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

/// Case-insensitive match; an empty `expected` never matches.
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
            crate::test_scratch::path(format!("refract-checksum-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir)
            .await
            .expect("create temp dir");
        let file_path = dir.join("sample.bin");
        // Larger than one chunk so the read loop runs more than once.
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
