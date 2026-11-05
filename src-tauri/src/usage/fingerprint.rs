// Fingerprints of file windows, so a resumed ingest can tell the file was rewritten under it.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

/// No window is fingerprinted past this many bytes.
pub const WINDOW_BYTES: i64 = 256;

/// FNV-1a: stable across Rust versions, unlike `DefaultHasher`.
fn fnv1a(bytes: &[u8]) -> i64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h as i64
}

/// Hash of `len` bytes from `start`, or `None` when the file is now too short to hold them.
pub fn window_fingerprint(file: &mut File, start: i64, len: i64) -> std::io::Result<Option<i64>> {
    let mut buf = vec![0u8; len.max(0) as usize];
    file.seek(SeekFrom::Start(start.max(0) as u64))?;
    match file.read_exact(&mut buf) {
        Ok(()) => Ok(Some(fnv1a(&buf))),
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(None),
        Err(e) => Err(e),
    }
}

/// A stored window: `len` 0 means unknown (never recorded, or unreadable).
#[derive(Debug, Default, Clone, Copy)]
pub struct Window {
    pub len: i64,
    pub hash: i64,
}

impl Window {
    fn capture(file: &mut File, start: i64, len: i64) -> Self {
        if len <= 0 {
            return Self::default();
        }
        match window_fingerprint(file, start, len) {
            Ok(Some(hash)) => Self { len, hash },
            _ => Self::default(),
        }
    }

    /// Up to `WINDOW_BYTES` from byte 0, never past `end`.
    pub fn head(file: &mut File, end: i64) -> Self {
        Self::capture(file, 0, end.min(WINDOW_BYTES))
    }

    /// Up to `WINDOW_BYTES` ending at `end`.
    pub fn tail(file: &mut File, end: i64) -> Self {
        let len = end.min(WINDOW_BYTES);
        Self::capture(file, end - len, len)
    }

    /// True when the file no longer holds this window's bytes at `start`. An unknown window matches.
    pub fn changed(&self, file: &mut File, start: i64) -> std::io::Result<bool> {
        if self.len <= 0 {
            return Ok(false);
        }
        Ok(window_fingerprint(file, start, self.len)?.is_none_or(|h| h != self.hash))
    }
}
