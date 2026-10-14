// Image caps (#771) and image-only send (#744), part of the chat send path (lane R4, issue
// #787). Port of `src/shared/images.ts` (the one module the renderer's own paste-time check and
// this build's independent re-check both derive from, constitution Principle V): magic-byte
// sniffing, header-only dimension parsing (no decode, no image library) and the two caps OMP
// attachments must never exceed.
//
// Extension beyond the straight port (#771, "the Rust validator enforces the cap too, not only
// the renderer"): `src/main/omp/images.ts`'s own `validateImageAttachment` (the Electron
// equivalent of this module's `validate_image_attachment`) never calls `readImageDimensions` at
// all -- only `attachments.ts`'s file-path reader does. That is a real gap in the Electron build
// itself, not something #787 is asked to leave alone (port the FIXED behaviour, not the bug):
// `validate_image_attachment` below also enforces `MAX_IMAGE_PIXELS` against the fully decoded
// buffer, closing the same decompression-bomb class of risk for the base64/clipboard-paste path
// (`chat.send`'s `images` array) that `attachments.ts` already closed for the file-path read.

/// OMP's own cap (research.md Decision 3): a decoded image over this is rejected, never shrunk.
pub const MAX_IMAGE_INPUT_BYTES: u64 = 20 * 1024 * 1024;

/// Decompression-bomb guard (#771): a tiny file can still declare an enormous pixel count, which
/// would allocate a canvas/bitmap far larger than the byte-size cap alone would catch. 40 MP is
/// comfortably larger than any real screenshot/photo while still bounding worst-case memory.
pub const MAX_IMAGE_PIXELS: u64 = 40_000_000;

pub const SUPPORTED_IMAGE_MIME_TYPES: &[&str] =
    &["image/png", "image/jpeg", "image/gif", "image/webp"];

pub fn is_supported_mime_type(value: &str) -> bool {
    SUPPORTED_IMAGE_MIME_TYPES.contains(&value)
}

/// Decoded byte length of a base64 string, computed from the string's own length -- never a live
/// decode: 3 bytes per 4 base64 characters, minus 1 or 2 for trailing `=` padding.
pub fn decoded_base64_byte_length(data: &str) -> u64 {
    let len = data.len() as u64;
    if len == 0 {
        return 0;
    }
    let padding = if data.ends_with("==") {
        2
    } else if data.ends_with('=') {
        1
    } else {
        0
    };
    (len * 3 / 4).saturating_sub(padding)
}

/// A plain, dependency-free, STRICT base64 decoder (no `base64` crate in this build's
/// `Cargo.toml`). Gate-fix (Medium, security): a PRIOR version stopped silently at the first
/// character outside the alphabet, truncating rather than rejecting -- the bytes this function
/// checked (and the dimensions/pixel-count derived from them) could then differ from whatever
/// OMP's own, possibly more lenient, base64 decoder makes of the SAME string once it is
/// forwarded on unchanged, letting a crafted payload hide an over-cap image after a single
/// invalid byte. This decoder instead REJECTS the whole string (`None`) on: any character
/// outside the base64 alphabet (other than ASCII whitespace, which is always ignored), or `=`
/// padding appearing anywhere but the final one-or-two characters of the last four-character
/// group -- so what this module checks is always exactly the bytes a well-formed, non-lenient
/// decoder would also produce from the same string.
pub fn base64_decode(data: &str) -> Option<Vec<u8>> {
    fn value(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    // Gate-fix (perf): a single pass over `data`'s own bytes, no intermediate whitespace-
    // stripped copy -- `group`/`pad_in_group` track the current (at most 4-wide) group as we
    // go; padding is only ever valid as the last 1-2 characters of the LAST group (tracked via
    // `seen_any_padding`: once a padded group closes, no further non-whitespace byte of any
    // kind may follow).
    let mut out = Vec::with_capacity(data.len() / 4 * 3 + 3);
    let mut group = [0u8; 4];
    let mut group_len = 0usize; // real (non-padding) characters filled so far
    let mut pad_in_group = 0usize; // padding characters filled so far
    let mut seen_any_padding = false;

    for byte in data.bytes() {
        if byte.is_ascii_whitespace() {
            continue;
        }
        if seen_any_padding {
            return None; // padding must be the very last thing in the string
        }
        if byte == b'=' {
            pad_in_group += 1;
            if group_len + pad_in_group > 4 {
                return None;
            }
            if group_len + pad_in_group == 4 {
                match group_len {
                    2 => out.push((group[0] << 2) | (group[1] >> 4)),
                    3 => {
                        out.push((group[0] << 2) | (group[1] >> 4));
                        out.push((group[1] << 4) | (group[2] >> 2));
                    }
                    _ => return None, // 0 or 1 real chars before padding closes a group: invalid
                }
                seen_any_padding = true;
                group_len = 0;
                pad_in_group = 0;
            }
            continue;
        }
        if pad_in_group > 0 {
            return None; // a real character can never follow padding within the same group
        }
        let v = value(byte)?;
        group[group_len] = v;
        group_len += 1;
        if group_len == 4 {
            out.push((group[0] << 2) | (group[1] >> 4));
            out.push((group[1] << 4) | (group[2] >> 2));
            out.push((group[2] << 6) | group[3]);
            group_len = 0;
        }
    }
    // A trailing incomplete, unpadded group (anything but a clean end) is invalid.
    if group_len != 0 || pad_in_group != 0 {
        return None;
    }
    Some(out)
}

/// Standard base64 (with `=` padding), used by `ipc::attachments`'s own `readImageFile` to
/// encode the validated file bytes for the wire -- the one direction `base64_decode` above never
/// needs, so kept separate rather than folded into one bidirectional helper.
pub fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    let mut chunks = data.chunks_exact(3);
    for chunk in &mut chunks {
        let n = ((chunk[0] as u32) << 16) | ((chunk[1] as u32) << 8) | chunk[2] as u32;
        out.push(CHARS[((n >> 18) & 0x3f) as usize] as char);
        out.push(CHARS[((n >> 12) & 0x3f) as usize] as char);
        out.push(CHARS[((n >> 6) & 0x3f) as usize] as char);
        out.push(CHARS[(n & 0x3f) as usize] as char);
    }
    let rem = chunks.remainder();
    match rem.len() {
        1 => {
            let n = (rem[0] as u32) << 16;
            out.push(CHARS[((n >> 18) & 0x3f) as usize] as char);
            out.push(CHARS[((n >> 12) & 0x3f) as usize] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let n = ((rem[0] as u32) << 16) | ((rem[1] as u32) << 8);
            out.push(CHARS[((n >> 18) & 0x3f) as usize] as char);
            out.push(CHARS[((n >> 12) & 0x3f) as usize] as char);
            out.push(CHARS[((n >> 6) & 0x3f) as usize] as char);
            out.push('=');
        }
        _ => {}
    }
    out
}

/// Port of `shared/images.ts`'s own `matchesImageSignature`: checks only the first few bytes of
/// `bytes` against the declared type's real magic-byte signature, never the whole payload.
pub fn matches_image_signature(bytes: &[u8], mime_type: &str) -> bool {
    match mime_type {
        "image/png" => {
            bytes.len() >= 16
                && bytes[0..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
                && bytes[12..16] == [0x49, 0x48, 0x44, 0x52] // "IHDR", always the first chunk
        }
        "image/jpeg" => {
            bytes.len() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff
        }
        "image/gif" => {
            bytes.len() >= 6
                && bytes[0..4] == *b"GIF8"
                && (bytes[4] == 0x37 || bytes[4] == 0x39) // '7' or '9'
                && bytes[5] == 0x61 // 'a'
        }
        "image/webp" => bytes.len() >= 12 && bytes[0..4] == *b"RIFF" && bytes[8..12] == *b"WEBP",
        _ => false,
    }
}

/// #514/#432: identifies a buffer's real image type purely by content, never by filename
/// extension -- tries each supported type's magic-byte signature in turn.
pub fn sniff_image_mime_type(bytes: &[u8]) -> Option<&'static str> {
    SUPPORTED_IMAGE_MIME_TYPES
        .iter()
        .copied()
        .find(|mime| matches_image_signature(bytes, mime))
}

fn be_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    bytes
        .get(offset..offset + 2)
        .map(|s| u16::from_be_bytes([s[0], s[1]]))
}

fn le_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    bytes
        .get(offset..offset + 2)
        .map(|s| u16::from_le_bytes([s[0], s[1]]))
}

fn be_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    bytes
        .get(offset..offset + 4)
        .map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn le_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    bytes
        .get(offset..offset + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn read_png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    // 8-byte signature, then one 4-byte chunk length + 4-byte "IHDR" tag, then width/height as
    // two big-endian uint32s (PNG spec 11.2.2).
    if bytes.len() < 24 {
        return None;
    }
    Some((be_u32(bytes, 16)?, be_u32(bytes, 20)?))
}

/// Port of `shared/images.ts`'s own GIF branch: walks every Image Descriptor in the buffer
/// (never stopping at the first) and reports `max(screen, every frame's own left+width and
/// top+height)` -- the worst-case canvas size a non-strict decoder could actually allocate
/// across every frame, not only the Logical Screen Descriptor's own nominal size.
fn read_gif_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 13 {
        return None;
    }
    let screen_width = le_u16(bytes, 6)? as u32;
    let screen_height = le_u16(bytes, 8)? as u32;
    let packed = bytes[10];
    let mut offset = 13usize;
    if packed & 0x80 != 0 {
        offset += (1usize << (((packed & 0x07) as u32) + 1)) * 3;
    }
    let mut max_width = screen_width;
    let mut max_height = screen_height;
    let mut found_any_frame = false;
    while offset < bytes.len() {
        let block_type = bytes[offset];
        if block_type == 0x21 {
            // Extension: introducer(1) + label(1), then sub-blocks each [size:1][data:size],
            // terminated by a size-0 block.
            offset += 2;
            while offset < bytes.len() {
                let sub_block_size = bytes[offset] as usize;
                offset += 1 + sub_block_size;
                if sub_block_size == 0 {
                    break;
                }
            }
            continue;
        }
        if block_type == 0x2c {
            if offset + 10 > bytes.len() {
                return None;
            }
            let frame_left = le_u16(bytes, offset + 1)? as u32;
            let frame_top = le_u16(bytes, offset + 3)? as u32;
            let frame_width = le_u16(bytes, offset + 5)? as u32;
            let frame_height = le_u16(bytes, offset + 7)? as u32;
            let frame_packed = bytes[offset + 9];
            max_width = max_width.max(frame_left + frame_width);
            max_height = max_height.max(frame_top + frame_height);
            found_any_frame = true;
            offset += 10;
            if frame_packed & 0x80 != 0 {
                offset += (1usize << (((frame_packed & 0x07) as u32) + 1)) * 3;
            }
            // LZW minimum code size (1 byte), then image-data sub-blocks, same terminated-by-zero
            // shape as an Extension's sub-blocks above.
            offset += 1;
            while offset < bytes.len() {
                let sub_block_size = bytes[offset] as usize;
                offset += 1 + sub_block_size;
                if sub_block_size == 0 {
                    break;
                }
            }
            continue;
        }
        // Trailer (0x3B) or any other unexpected byte: stop walking.
        return if found_any_frame {
            Some((max_width, max_height))
        } else {
            None
        };
    }
    if found_any_frame {
        Some((max_width, max_height))
    } else {
        None
    }
}

/// Port of `shared/images.ts`'s own JPEG branch: scans marker segments looking for a Start Of
/// Frame marker (0xFFC0-0xFFCF, excluding the DHT/JPG/DAC reserved codes), skipping any number of
/// 0xFF fill bytes real encoders legitimately emit between markers (ITU-T T.81 B.1.1.2).
fn read_jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut offset = 2usize;
    while offset + 2 <= bytes.len() {
        if bytes[offset] != 0xff {
            return None; // not a marker where one was expected
        }
        let mut marker_offset = offset + 1;
        while marker_offset < bytes.len() && bytes[marker_offset] == 0xff {
            marker_offset += 1;
        }
        if marker_offset >= bytes.len() {
            return None;
        }
        let marker = bytes[marker_offset];
        if marker == 0xd8 || marker == 0x01 || (0xd0..=0xd9).contains(&marker) {
            offset = marker_offset + 1; // markers with no length field (SOI/RST*/EOI/TEM)
            continue;
        }
        if marker_offset + 3 > bytes.len() {
            return None;
        }
        let segment_length = be_u16(bytes, marker_offset + 1)? as usize;
        let is_sof =
            (0xc0..=0xcf).contains(&marker) && marker != 0xc4 && marker != 0xc8 && marker != 0xcc;
        if is_sof {
            if marker_offset + 8 > bytes.len() {
                return None;
            }
            let height = be_u16(bytes, marker_offset + 4)? as u32;
            let width = be_u16(bytes, marker_offset + 6)? as u32;
            return Some((width, height));
        }
        if marker == 0xda {
            return None; // Start Of Scan: no SOF seen before entropy-coded data
        }
        offset = marker_offset + 1 + segment_length;
    }
    None
}

/// Port of `shared/images.ts`'s own WebP branch: 12-byte "RIFF"+size+"WEBP" container header,
/// then one chunk whose fourCC picks the lossy/lossless/extended dimension layout (WebP
/// container spec, "Simple File Format"/"Extended File Format").
fn read_webp_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 21 {
        return None;
    }
    let four_cc = &bytes[12..16];
    let data_offset = 20usize;
    if four_cc == b"VP8 " {
        if bytes.len() < data_offset + 10 {
            return None;
        }
        let width = (le_u16(bytes, data_offset + 6)? & 0x3fff) as u32;
        let height = (le_u16(bytes, data_offset + 8)? & 0x3fff) as u32;
        return Some((width, height));
    }
    if four_cc == b"VP8L" {
        if bytes.len() < data_offset + 5 {
            return None;
        }
        let bits = le_u32(bytes, data_offset + 1)?;
        return Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1));
    }
    if four_cc == b"VP8X" {
        if bytes.len() < data_offset + 10 {
            return None;
        }
        let width = (bytes[data_offset + 4] as u32
            | (bytes[data_offset + 5] as u32) << 8
            | (bytes[data_offset + 6] as u32) << 16)
            + 1;
        let height = (bytes[data_offset + 7] as u32
            | (bytes[data_offset + 8] as u32) << 8
            | (bytes[data_offset + 9] as u32) << 16)
            + 1;
        return Some((width, height));
    }
    None
}

/// Port of `shared/images.ts`'s own `readImageDimensions`: parses width/height straight out of a
/// supported format's own header bytes -- no decode, no image library. Returns `None` on a
/// buffer too short or too malformed to contain a header; every caller REFUSES (fail-closed) a
/// `None` result rather than treating it as "could not verify, allow it".
pub fn read_image_dimensions(bytes: &[u8], mime_type: &str) -> Option<(u32, u32)> {
    match mime_type {
        "image/png" => read_png_dimensions(bytes),
        "image/gif" => read_gif_dimensions(bytes),
        "image/jpeg" => read_jpeg_dimensions(bytes),
        "image/webp" => read_webp_dimensions(bytes),
        _ => None,
    }
}

/// Port of `shared/images.ts`'s own `ImageValidationResult` (bare classification; the caller
/// builds whatever message it wants, matching `chat.ts`'s own call-site messages). Split into
/// two over-size reasons (gate-fix, #771): a single `ImageTooLarge` variant used to collapse the
/// byte-size cap and the pixel-count cap into one message ("Image exceeds the 20 MiB limit"),
/// which is wrong and confusing for a tiny file that fails only the pixel check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageValidationError {
    UnsupportedImageType,
    ByteSizeTooLarge,
    PixelCountTooLarge,
}

/// Port of `omp/images.ts`'s own `validateImageAttachment` cheap half (FR-018, constitution
/// Principle V): mime-type and declared-byte-length only, no decode -- gate-fix (perf): callers
/// run this on the BORROWED `&str` before ever cloning into an owned `String` for
/// `validate_image_attachment_decoded`'s spawn_blocking call, so a mime-type or over-declared
/// size rejection never pays for an allocation it doesn't need.
pub fn validate_image_attachment_shape(
    data: &str,
    mime_type: &str,
) -> Result<(), ImageValidationError> {
    if !is_supported_mime_type(mime_type) {
        return Err(ImageValidationError::UnsupportedImageType);
    }
    if decoded_base64_byte_length(data) > MAX_IMAGE_INPUT_BYTES {
        return Err(ImageValidationError::ByteSizeTooLarge);
    }
    Ok(())
}

/// The expensive half: full decode plus the magic-byte/header/pixel-cap walk. MUST only be
/// called once `validate_image_attachment_shape` has already passed (bounds the decode to
/// `MAX_IMAGE_INPUT_BYTES`); run this on a blocking-pool thread since it is CPU, not I/O, work.
/// See this file's own header for the #771 pixel-cap extension beyond the Electron build.
pub fn validate_image_attachment_decoded(
    data: &str,
    mime_type: &str,
) -> Result<(), ImageValidationError> {
    // A strict-decode failure (gate-fix: invalid characters or misplaced padding) is refused the
    // same way an unsupported type is -- malformed base64 is never a valid image either way.
    let Some(bytes) = base64_decode(data) else {
        return Err(ImageValidationError::UnsupportedImageType);
    };
    if !matches_image_signature(&bytes, mime_type) {
        return Err(ImageValidationError::UnsupportedImageType);
    }
    let Some((width, height)) = read_image_dimensions(&bytes, mime_type) else {
        return Err(ImageValidationError::UnsupportedImageType);
    };
    if (width as u64) * (height as u64) > MAX_IMAGE_PIXELS {
        return Err(ImageValidationError::PixelCountTooLarge);
    }
    Ok(())
}

/// Convenience wrapper running both halves in sequence; kept for callers (and this file's own
/// tests) that do not need the shape/decoded split itself. `ipc::chat`'s `parse_images_argument`
/// calls the two halves separately instead (see their own doc comments for why).
pub fn validate_image_attachment(data: &str, mime_type: &str) -> Result<(), ImageValidationError> {
    validate_image_attachment_shape(data, mime_type)?;
    validate_image_attachment_decoded(data, mime_type)
}

#[cfg(test)]
#[path = "images.test.rs"]
mod tests;
