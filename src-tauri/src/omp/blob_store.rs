// The hash is the only input to the path, so a message can never steer the read outside the blob folder.

use std::fs::File;
use std::io::Read;
use std::path::PathBuf;

use super::images::{inspect_image_bytes, MAX_IMAGE_INPUT_BYTES};

const BLOB_PREFIX: &str = "blob:sha256:";
const EXTENSIONS: &[&str] = &["", ".png", ".jpg", ".jpeg", ".gif", ".webp"];

/// The hash inside a `blob:sha256:<hash>` reference, only when it is exactly 64 lowercase hex.
pub fn parse_blob_reference(data: &str) -> Option<&str> {
    let hash = data.strip_prefix(BLOB_PREFIX)?;
    is_blob_hash(hash).then_some(hash)
}

/// `^[0-9a-f]{64}$`.
pub fn is_blob_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn blobs_dir() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".omp").join("agent").join("blobs"))
}

/// The bytes of the blob for `hash`, or `None` when it is malformed, missing, or over the cap.
pub fn read_blob(hash: &str) -> Option<Vec<u8>> {
    if !is_blob_hash(hash) {
        return None;
    }
    let dir = blobs_dir()?;
    for extension in EXTENSIONS {
        let path = dir.join(format!("{hash}{extension}"));
        // `symlink_metadata`: a link planted in the folder is never followed.
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > MAX_IMAGE_INPUT_BYTES {
            return None;
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        File::open(&path)
            .ok()?
            .take(MAX_IMAGE_INPUT_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        // Reject if the file grew past the cap between the stat and the read.
        if bytes.len() as u64 > MAX_IMAGE_INPUT_BYTES || inspect_image_bytes(&bytes).is_none() {
            return None;
        }
        return Some(bytes);
    }
    None
}
