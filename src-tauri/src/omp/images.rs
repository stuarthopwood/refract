// Image caps and magic-byte/header-only dimension parsing for chat attachments (#771, #744).
// The decoded validator also enforces `MAX_IMAGE_PIXELS` to close the decompression-bomb path.

/// OMP's own cap: a decoded image over this is rejected, never shrunk.
pub const MAX_IMAGE_INPUT_BYTES: u64 = 20 * 1024 * 1024;

/// Decompression-bomb guard (#771): a tiny file can declare an enormous pixel count that the
/// byte cap alone would not catch.
pub const MAX_IMAGE_PIXELS: u64 = 40_000_000;

pub const SUPPORTED_IMAGE_MIME_TYPES: &[&str] =
    &["image/png", "image/jpeg", "image/gif", "image/webp"];

pub fn is_supported_mime_type(value: &str) -> bool {
    SUPPORTED_IMAGE_MIME_TYPES.contains(&value)
}

/// Decoded byte length of a base64 string, computed from its length without decoding.
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

/// Dependency-free STRICT base64 decoder: rejects (`None`) any non-alphabet character (ASCII
/// whitespace aside) or misplaced `=` padding, so a lenient downstream decoder cannot see other bytes.
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
    // Single pass, no whitespace-stripped copy; padding is only valid as the last 1-2 chars of
    // the last group.
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

/// Standard base64 (with `=` padding) for encoding validated file bytes onto the wire.
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

/// Checks only the first few bytes of `bytes` against the declared type's magic-byte signature.
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

/// #514/#432: identifies a buffer's real image type by magic bytes, never by filename extension.
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

/// GIF dimensions: the max of the screen size and every frame's left+width / top+height, the
/// worst-case canvas a decoder could allocate.
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

/// JPEG dimensions from the Start Of Frame marker, skipping 0xFF fill bytes (ITU-T T.81 B.1.1.2).
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

/// WebP dimensions: the RIFF header, then one chunk whose fourCC picks the lossy/lossless/extended layout.
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

/// Parses width/height from a supported format's header bytes. `None` on a short or malformed
/// buffer; callers must refuse (fail-closed) a `None`.
pub fn read_image_dimensions(bytes: &[u8], mime_type: &str) -> Option<(u32, u32)> {
    match mime_type {
        "image/png" => read_png_dimensions(bytes),
        "image/gif" => read_gif_dimensions(bytes),
        "image/jpeg" => read_jpeg_dimensions(bytes),
        "image/webp" => read_webp_dimensions(bytes),
        _ => None,
    }
}

/// Bare classification of an image check; the caller builds its own message. The two over-size
/// reasons stay separate so a pixel-cap failure is not reported as a byte-size one (#771).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageValidationError {
    UnsupportedImageType,
    ByteSizeTooLarge,
    PixelCountTooLarge,
}

/// Cheap half: mime type and declared byte length only, no decode, so callers can reject on the
/// borrowed `&str` before cloning.
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

/// Expensive half: full decode plus magic-byte/header/pixel-cap walk. Call only after
/// `validate_image_attachment_shape` passed; run on a blocking-pool thread (CPU-bound).
pub fn validate_image_attachment_decoded(
    data: &str,
    mime_type: &str,
) -> Result<(), ImageValidationError> {
    // A strict-decode failure is refused like an unsupported type.
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

/// Runs both halves in sequence, for callers that do not need the shape/decoded split.
pub fn validate_image_attachment(data: &str, mime_type: &str) -> Result<(), ImageValidationError> {
    validate_image_attachment_shape(data, mime_type)?;
    validate_image_attachment_decoded(data, mime_type)
}

/// #513: sniffs real bytes (never a declared type), parses the header dimensions and applies the
/// byte and pixel caps. `None` for anything unsupported, malformed or over a cap (fail-closed).
pub fn inspect_image_bytes(bytes: &[u8]) -> Option<(&'static str, u32, u32)> {
    if bytes.len() as u64 > MAX_IMAGE_INPUT_BYTES {
        return None;
    }
    let mime = sniff_image_mime_type(bytes)?;
    let (width, height) = read_image_dimensions(bytes, mime)?;
    if (width as u64) * (height as u64) > MAX_IMAGE_PIXELS {
        return None;
    }
    Some((mime, width, height))
}

#[cfg(test)]
#[path = "images.test.rs"]
mod tests;
