// Returns PR body/comment images as `data:` URLs so the renderer's CSP stays unchanged. https
// only, host allow-list, hops re-validated, never SVG, magic-byte check, size cap, no credentials.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use reqwest::header::{CONTENT_TYPE, LOCATION, USER_AGENT};
use reqwest::Url;

use super::profile::{
    collect_bounded, describe_request_error, matches_image_signature, HTTP_CLIENT,
};

const IMAGE_HOSTS: &[&str] = &[
    "avatars.githubusercontent.com",
    "user-images.githubusercontent.com",
    "private-user-images.githubusercontent.com",
    "raw.githubusercontent.com",
    "camo.githubusercontent.com",
    "objects.githubusercontent.com",
];
const ATTACHMENTS_HOST: &str = "github.com";
const ATTACHMENTS_PATH_PREFIX: &str = "/user-attachments/";
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_IMAGE_REDIRECTS: u32 = 5;

#[derive(Debug)]
pub struct ImageFetchError {
    pub message: String,
}

impl ImageFetchError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ImageFetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ImageFetchError {}

struct ImageResponse {
    status: u16,
    content_type: Option<String>,
    location: Option<String>,
    body: Vec<u8>,
}

/// Applied to the initial URL and to every redirect target before it is ever requested.
fn parse_image_url(value: &str) -> Result<Url, ImageFetchError> {
    let url = Url::parse(value)
        .map_err(|_| ImageFetchError::new(format!("image URL \"{value}\" is not a valid URL")))?;
    let host = url.host_str().unwrap_or("");
    let host_allowed = IMAGE_HOSTS.contains(&host)
        || (host == ATTACHMENTS_HOST && url.path().starts_with(ATTACHMENTS_PATH_PREFIX));
    if url.scheme() != "https"
        || !host_allowed
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ImageFetchError::new(format!(
            "image host \"{host}\" is not on the allow-list"
        )));
    }
    Ok(url)
}

fn resolve_image_mime_type(content_type: Option<&str>) -> Option<&'static str> {
    let base = content_type?.split(';').next()?.trim().to_lowercase();
    match base.as_str() {
        "image/png" => Some("image/png"),
        "image/jpeg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        _ => None,
    }
}

async fn request_image_once(url: &Url) -> Result<ImageResponse, ImageFetchError> {
    let response = HTTP_CLIENT
        .get(url.clone())
        .header(USER_AGENT, "Refract")
        .send()
        .await
        .map_err(|err| ImageFetchError::new(describe_request_error(&err, "image")))?;

    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let location = response
        .headers()
        .get(LOCATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let body = if (300..400).contains(&status) {
        Vec::new()
    } else {
        collect_bounded(response, MAX_IMAGE_BYTES)
            .await
            .map_err(ImageFetchError::new)?
    };

    Ok(ImageResponse {
        status,
        content_type,
        location,
        body,
    })
}

/// Fetches `image_url` and returns a validated `data:<mime>;base64,...` string. Callers keep the
/// alt-text link on any `Err`.
pub async fn fetch_pr_image(image_url: &str) -> Result<String, ImageFetchError> {
    let mut current = parse_image_url(image_url)?;
    let mut response = request_image_once(&current).await?;

    let mut redirects = 0u32;
    while (300..400).contains(&response.status) {
        let Some(location) = response.location.as_deref() else {
            break;
        };
        if redirects >= MAX_IMAGE_REDIRECTS {
            return Err(ImageFetchError::new(
                "image request redirected too many times",
            ));
        }
        redirects += 1;
        let next = current.join(location).map_err(|_| {
            ImageFetchError::new(format!(
                "image redirect target \"{location}\" is not a valid URL"
            ))
        })?;
        current = parse_image_url(next.as_str())?;
        response = request_image_once(&current).await?;
    }

    if response.status != 200 {
        return Err(ImageFetchError::new(format!(
            "image request failed with status {}",
            response.status
        )));
    }

    let mime_type = resolve_image_mime_type(response.content_type.as_deref())
        .ok_or_else(|| ImageFetchError::new("image response had an unsupported Content-Type"))?;
    if !matches_image_signature(&response.body, mime_type) {
        return Err(ImageFetchError::new(format!(
            "image response bytes did not match its declared {mime_type} signature"
        )));
    }

    Ok(format!(
        "data:{mime_type};base64,{}",
        BASE64.encode(&response.body)
    ))
}
