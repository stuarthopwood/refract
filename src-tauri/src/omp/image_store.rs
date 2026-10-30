// Process-wide store for inline (base64) image bytes. The id is a content hash, so a message
// seen twice maps to one entry; eviction is oldest-first, bounded by bytes and count (#513).

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

const MAX_TOTAL_BYTES: usize = 96 * 1024 * 1024;
const MAX_ENTRIES: usize = 64;

struct Entry {
    id: String,
    mime_type: String,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct Store {
    entries: VecDeque<Entry>,
    total_bytes: usize,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(Store::default()))
}

/// The id of an inline image: FNV-1a 64 over the bytes plus the length. Not cryptographic.
pub fn inline_image_id(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("i-{hash:016x}-{:x}", bytes.len())
}

/// True for the id shape `inline_image_id` produces; `images.get` checks this before any lookup.
pub fn is_inline_image_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("i-") else {
        return false;
    };
    let Some((hash, len)) = rest.split_once('-') else {
        return false;
    };
    hash.len() == 16
        && hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        && !len.is_empty()
        && len.len() <= 8
        && len
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Stores the bytes (validated by the caller) and returns their id. A duplicate put is a no-op.
pub fn put(bytes: Vec<u8>, mime_type: &str) -> String {
    let id = inline_image_id(&bytes);
    let mut guard = store().lock().expect("image store mutex poisoned");
    if guard.entries.iter().any(|entry| entry.id == id) {
        return id;
    }
    guard.total_bytes += bytes.len();
    guard.entries.push_back(Entry {
        id: id.clone(),
        mime_type: mime_type.to_string(),
        bytes,
    });
    while guard.entries.len() > 1
        && (guard.entries.len() > MAX_ENTRIES || guard.total_bytes > MAX_TOTAL_BYTES)
    {
        if let Some(evicted) = guard.entries.pop_front() {
            guard.total_bytes -= evicted.bytes.len();
        }
    }
    id
}

/// The stored bytes and MIME type for `id`, or `None` when unknown or evicted.
pub fn get(id: &str) -> Option<(Vec<u8>, String)> {
    let guard = store().lock().expect("image store mutex poisoned");
    guard
        .entries
        .iter()
        .find(|entry| entry.id == id)
        .map(|entry| (entry.bytes.clone(), entry.mime_type.clone()))
}
