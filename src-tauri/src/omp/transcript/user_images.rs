// Extracts `image` parts of a user message into `ImageRef`s; no image bytes enter the transcript (#513).
// An invalid part still yields an `invalid` ref so the bubble shows an "Image no longer available" tile.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::omp::blob_store::parse_blob_reference;
use crate::omp::image_store;
use crate::omp::images::{
    base64_decode, inspect_image_bytes, is_supported_mime_type, validate_image_attachment_shape,
};

const INVALID_IMAGE_ID: &str = "invalid";

/// One image attached to a user message, as the renderer sees it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageRef {
    pub id: String,
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub byte_length: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

fn invalid(mime_type: &str) -> ImageRef {
    ImageRef {
        id: INVALID_IMAGE_ID.to_string(),
        mime_type: mime_type.to_string(),
        byte_length: None,
        width: None,
        height: None,
    }
}

fn image_ref(part: &Value) -> ImageRef {
    let declared = part.get("mimeType").and_then(Value::as_str).unwrap_or("");
    let declared = if is_supported_mime_type(declared) {
        declared
    } else {
        "image/png"
    };
    let Some(data) = part.get("data").and_then(Value::as_str) else {
        return invalid(declared);
    };
    if let Some(hash) = parse_blob_reference(data) {
        return ImageRef {
            id: hash.to_string(),
            mime_type: declared.to_string(),
            byte_length: None,
            width: None,
            height: None,
        };
    }
    if data.starts_with("blob:") || validate_image_attachment_shape(data, declared).is_err() {
        return invalid(declared);
    }
    let Some(bytes) = base64_decode(data) else {
        return invalid(declared);
    };
    let Some((mime, width, height)) = inspect_image_bytes(&bytes) else {
        return invalid(declared);
    };
    let byte_length = bytes.len() as u64;
    ImageRef {
        id: image_store::put(bytes, mime),
        mime_type: mime.to_string(),
        byte_length: Some(byte_length),
        width: Some(width),
        height: Some(height),
    }
}

/// The images of a user message, in attach order; empty when it has none.
pub fn extract_images(parts: &[Value]) -> Vec<ImageRef> {
    parts
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("image"))
        .map(image_ref)
        .collect()
}
