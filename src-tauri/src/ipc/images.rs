// Returns a Message image as a `data:` URL. The id is shape-checked and never used as a path (Principle V).

use serde_json::{json, Value};

use super::{invalid_argument, not_found, AppState, Dispatcher, HandlerFuture};
use crate::omp::blob_store::{is_blob_hash, read_blob};
use crate::omp::image_store::{self, is_inline_image_id};
use crate::omp::images::{base64_encode, inspect_image_bytes};

pub fn register(d: &mut Dispatcher) {
    d.register("images.get", images_get);
}

fn load(image_id: &str) -> Option<Vec<u8>> {
    if is_blob_hash(image_id) {
        return read_blob(image_id);
    }
    if is_inline_image_id(image_id) {
        return image_store::get(image_id).map(|(bytes, _)| bytes);
    }
    None
}

pub fn images_get(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let Some(image_id) = args.first().and_then(Value::as_str).map(str::to_owned) else {
            return Err(invalid_argument("images.get expects an image id"));
        };
        let value = tokio::task::spawn_blocking(move || {
            let bytes = load(&image_id)?;
            let (mime, width, height) = inspect_image_bytes(&bytes)?;
            Some(json!({
                "dataUrl": format!("data:{mime};base64,{}", base64_encode(&bytes)),
                "mimeType": mime,
                "byteLength": bytes.len(),
                "width": width,
                "height": height,
            }))
        })
        .await
        .ok()
        .flatten();
        value.ok_or_else(|| not_found("Image no longer available."))
    })
}
