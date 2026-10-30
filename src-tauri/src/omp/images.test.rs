// Unit tests for `omp::images`: base64, the size caps, and the image header parsers.

use super::*;

#[test]
fn base64_round_trips_arbitrary_bytes() {
    for len in [0usize, 1, 2, 3, 4, 5, 100, 257] {
        let original: Vec<u8> = (0..len).map(|i| (i % 256) as u8).collect();
        let encoded = base64_encode(&original);
        let decoded = base64_decode(&encoded).expect("round-trip decode must succeed");
        assert_eq!(decoded, original, "round trip failed for length {len}");
    }
}

#[test]
fn base64_decode_rejects_invalid_characters() {
    assert!(base64_decode("not-valid-base64!!").is_none());
    assert!(base64_decode("AB@D").is_none());
}

#[test]
fn base64_decode_rejects_misplaced_padding() {
    // Padding only valid as the final 1-2 characters of the final 4-char group.
    assert!(base64_decode("A=AA").is_none());
    assert!(base64_decode("AA=A").is_none());
    assert!(base64_decode("====").is_none());
}

#[test]
fn base64_decode_rejects_wrong_length() {
    assert!(base64_decode("AAA").is_none()); // not a multiple of 4
}

#[test]
fn base64_decode_ignores_whitespace() {
    let encoded = base64_encode(b"hello world");
    let with_whitespace: String = encoded.chars().map(|c| format!("{c}\n")).collect();
    assert_eq!(base64_decode(&with_whitespace).unwrap(), b"hello world");
}

#[test]
fn decoded_base64_byte_length_matches_real_decode() {
    for len in [0usize, 1, 2, 3, 4, 10, 1000] {
        let bytes = vec![0u8; len];
        let encoded = base64_encode(&bytes);
        assert_eq!(
            decoded_base64_byte_length(&encoded),
            len as u64,
            "length mismatch for {len}"
        );
    }
}

// Smallest buffers each parser accepts; non-dimension fields are placeholders.

fn fake_png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]; // signature
    bytes.extend_from_slice(&[0, 0, 0, 13]); // chunk length (unchecked)
    bytes.extend_from_slice(b"IHDR");
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes
}

fn fake_gif(frame_width: u16, frame_height: u16) -> Vec<u8> {
    let mut bytes = b"GIF89a".to_vec();
    bytes.extend_from_slice(&1u16.to_le_bytes()); // screen width
    bytes.extend_from_slice(&1u16.to_le_bytes()); // screen height
    bytes.push(0x00); // packed: no global colour table
    bytes.push(0x00); // background colour index
    bytes.push(0x00); // pixel aspect ratio
    bytes.push(0x2c); // image separator
    bytes.extend_from_slice(&0u16.to_le_bytes()); // frame left
    bytes.extend_from_slice(&0u16.to_le_bytes()); // frame top
    bytes.extend_from_slice(&frame_width.to_le_bytes());
    bytes.extend_from_slice(&frame_height.to_le_bytes());
    bytes.push(0x00); // frame packed: no local colour table
    bytes
}

fn fake_jpeg(width: u16, height: u16) -> Vec<u8> {
    let mut bytes = vec![0xff, 0xd8, 0xff, 0xc0]; // SOI + SOF0 marker
    bytes.extend_from_slice(&8u16.to_be_bytes()); // segment length (unchecked)
    bytes.push(8); // precision
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes
}

fn fake_webp_vp8x(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = b"RIFF".to_vec();
    bytes.extend_from_slice(&[0, 0, 0, 0]); // file size (unchecked)
    bytes.extend_from_slice(b"WEBP");
    bytes.extend_from_slice(b"VP8X");
    bytes.extend_from_slice(&[0, 0, 0, 0]); // chunk size (unchecked)
    bytes.push(0x00); // flags
    bytes.extend_from_slice(&[0, 0, 0]); // reserved
    let w = (width - 1).to_le_bytes();
    let h = (height - 1).to_le_bytes();
    bytes.extend_from_slice(&w[0..3]);
    bytes.extend_from_slice(&h[0..3]);
    bytes
}

#[test]
fn matches_image_signature_true_for_every_supported_format() {
    assert!(matches_image_signature(&fake_png(10, 8), "image/png"));
    assert!(matches_image_signature(&fake_gif(4, 3), "image/gif"));
    assert!(matches_image_signature(&fake_jpeg(4, 3), "image/jpeg"));
    assert!(matches_image_signature(&fake_webp_vp8x(4, 3), "image/webp"));
}

#[test]
fn matches_image_signature_false_for_wrong_or_truncated_bytes() {
    assert!(!matches_image_signature(b"not an image", "image/png"));
    assert!(!matches_image_signature(&fake_png(10, 8), "image/gif"));
    assert!(!matches_image_signature(
        &fake_png(10, 8)[..10],
        "image/png"
    )); // too short for IHDR tag
}

#[test]
fn sniff_image_mime_type_identifies_by_content_only() {
    assert_eq!(sniff_image_mime_type(&fake_png(1, 1)), Some("image/png"));
    assert_eq!(sniff_image_mime_type(&fake_gif(1, 1)), Some("image/gif"));
    assert_eq!(sniff_image_mime_type(&fake_jpeg(1, 1)), Some("image/jpeg"));
    assert_eq!(
        sniff_image_mime_type(&fake_webp_vp8x(1, 1)),
        Some("image/webp")
    );
    assert_eq!(sniff_image_mime_type(b"plain text, not an image"), None);
}

#[test]
fn read_png_dimensions_reads_real_header() {
    assert_eq!(
        read_image_dimensions(&fake_png(1920, 1080), "image/png"),
        Some((1920, 1080))
    );
}

#[test]
fn read_png_dimensions_none_when_truncated() {
    let short = &fake_png(100, 100)[..20]; // shorter than the 24-byte minimum
    assert_eq!(read_image_dimensions(short, "image/png"), None);
}

#[test]
fn read_gif_dimensions_reads_real_header() {
    assert_eq!(
        read_image_dimensions(&fake_gif(4, 3), "image/gif"),
        Some((4, 3))
    );
}

#[test]
fn read_gif_dimensions_falls_back_to_the_larger_of_screen_and_frame_size() {
    // The frame can exceed the declared screen size; the larger value must win (#771).
    assert_eq!(
        read_image_dimensions(&fake_gif(500, 400), "image/gif"),
        Some((500, 400))
    );
}

#[test]
fn read_gif_dimensions_none_when_no_image_descriptor_found() {
    // Just the signature and the logical screen descriptor, no 0x2c image separator at all.
    let mut bytes = b"GIF89a".to_vec();
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.push(0x00);
    bytes.push(0x00);
    bytes.push(0x00);
    bytes.push(0x3b); // trailer, no frame ever seen
    assert_eq!(read_image_dimensions(&bytes, "image/gif"), None);
}

#[test]
fn read_gif_dimensions_none_when_image_descriptor_is_truncated() {
    let mut bytes = fake_gif(4, 3);
    bytes.truncate(bytes.len() - 3); // cut into the image descriptor's own fixed fields
    assert_eq!(read_image_dimensions(&bytes, "image/gif"), None);
}

#[test]
fn read_jpeg_dimensions_reads_real_sof0_segment() {
    assert_eq!(
        read_image_dimensions(&fake_jpeg(640, 480), "image/jpeg"),
        Some((640, 480))
    );
}

#[test]
fn read_jpeg_dimensions_skips_fill_bytes_before_a_marker() {
    // ITU-T T.81 B.1.1.2 permits any number of 0xFF fill bytes between markers.
    let mut bytes = vec![0xff, 0xd8, 0xff, 0xff, 0xff, 0xc0];
    bytes.extend_from_slice(&8u16.to_be_bytes());
    bytes.push(8);
    bytes.extend_from_slice(&3u16.to_be_bytes());
    bytes.extend_from_slice(&4u16.to_be_bytes());
    assert_eq!(read_image_dimensions(&bytes, "image/jpeg"), Some((4, 3)));
}

#[test]
fn read_jpeg_dimensions_none_when_scan_starts_before_any_sof() {
    // 0xDA (Start Of Scan) reached with no SOF marker seen first.
    let bytes = vec![0xff, 0xd8, 0xff, 0xda];
    assert_eq!(read_image_dimensions(&bytes, "image/jpeg"), None);
}

#[test]
fn read_jpeg_dimensions_none_when_truncated_mid_segment() {
    let bytes = vec![0xff, 0xd8, 0xff, 0xc0, 0x00]; // length field cut short
    assert_eq!(read_image_dimensions(&bytes, "image/jpeg"), None);
}

#[test]
fn read_webp_dimensions_reads_real_vp8x_header() {
    assert_eq!(
        read_image_dimensions(&fake_webp_vp8x(1024, 768), "image/webp"),
        Some((1024, 768))
    );
}

#[test]
fn read_webp_dimensions_none_when_truncated() {
    let short = &fake_webp_vp8x(100, 100)[..15]; // shorter than the 21-byte minimum
    assert_eq!(read_image_dimensions(short, "image/webp"), None);
}

#[test]
fn read_image_dimensions_none_for_unsupported_mime_type() {
    assert_eq!(read_image_dimensions(&fake_png(1, 1), "image/bmp"), None);
}

#[test]
fn validate_image_attachment_rejects_unsupported_mime_type() {
    let data = base64_encode(&fake_png(1, 1));
    assert_eq!(
        validate_image_attachment(&data, "image/bmp"),
        Err(ImageValidationError::UnsupportedImageType)
    );
}

#[test]
fn validate_image_attachment_byte_cap_boundary_n_minus_1_n_n_plus_1() {
    let under = base64_encode(&vec![0u8; (MAX_IMAGE_INPUT_BYTES - 1) as usize]);
    let exact = base64_encode(&vec![0u8; MAX_IMAGE_INPUT_BYTES as usize]);
    let over = base64_encode(&vec![0u8; (MAX_IMAGE_INPUT_BYTES + 1) as usize]);

    // Only N+1 may trip the byte cap; N-1 and N fail later on signature.
    assert_ne!(
        validate_image_attachment(&under, "image/png"),
        Err(ImageValidationError::ByteSizeTooLarge)
    );
    assert_ne!(
        validate_image_attachment(&exact, "image/png"),
        Err(ImageValidationError::ByteSizeTooLarge)
    );
    assert_eq!(
        validate_image_attachment(&over, "image/png"),
        Err(ImageValidationError::ByteSizeTooLarge)
    );
}

#[test]
fn validate_image_attachment_pixel_cap_boundary_n_minus_1_n_n_plus_1() {
    let under = base64_encode(&fake_png(1, (MAX_IMAGE_PIXELS - 1) as u32));
    let exact = base64_encode(&fake_png(1, MAX_IMAGE_PIXELS as u32));
    let over = base64_encode(&fake_png(1, (MAX_IMAGE_PIXELS + 1) as u32));

    assert_eq!(validate_image_attachment(&under, "image/png"), Ok(()));
    assert_eq!(validate_image_attachment(&exact, "image/png"), Ok(()));
    assert_eq!(
        validate_image_attachment(&over, "image/png"),
        Err(ImageValidationError::PixelCountTooLarge)
    );
}

#[test]
fn validate_image_attachment_accepts_a_valid_small_image() {
    let data = base64_encode(&fake_gif(10, 8));
    assert_eq!(validate_image_attachment(&data, "image/gif"), Ok(()));
}

#[test]
fn validate_image_attachment_rejects_malformed_base64() {
    assert_eq!(
        validate_image_attachment("not valid base64 at all!!", "image/png"),
        Err(ImageValidationError::UnsupportedImageType)
    );
}

#[test]
fn validate_image_attachment_rejects_a_renamed_non_image_file() {
    // The magic-byte check, not the declared type, is the real gate.
    let data = base64_encode(b"this is not an image, just text pretending to be one");
    assert_eq!(
        validate_image_attachment(&data, "image/png"),
        Err(ImageValidationError::UnsupportedImageType)
    );
}
