// Per-account profile/avatar fetch. The token is read for one bounded HTTPS request, then
// dropped; never logged, written to disk, or sent over IPC. Redirects are re-validated per hop.

use std::sync::LazyLock;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, LOCATION, USER_AGENT};
use reqwest::Url;
use serde_json::Value;

use super::cli::auth_token;
use super::gh::GhError;

const API_HOST: &str = "api.github.com";
// Only github.com tokens are ever read: the REST call is hard-coded to `API_HOST`.
const SUPPORTED_AUTH_HOST: &str = "github.com";
const AVATAR_HOST: &str = "avatars.githubusercontent.com";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
// Profile JSON is a few hundred bytes; the cap stops a malicious response being buffered.
const MAX_PROFILE_RESPONSE_BYTES: usize = 64 * 1024;
// A 96px PNG/JPEG avatar is a few KB; this leaves headroom while keeping the cache file small.
const MAX_AVATAR_BYTES: usize = 64 * 1024;
const AVATAR_SIZE_PX: &str = "96";
pub const MAX_DISPLAY_NAME_CHARS: usize = 100;

/// Drops control and invisible format/bidi characters (so a name cannot forge a line, escape sequence or
/// reordered text), then caps the length.
pub fn truncate_display_name(name: &str) -> String {
    name.chars()
        .filter(|c| !c.is_control() && !is_invisible_format(*c))
        .take(MAX_DISPLAY_NAME_CHARS)
        .collect()
}

/// The one list of invisible format/bidi characters (also used for approval card lines).
pub(crate) fn is_invisible_format(c: char) -> bool {
    matches!(
        c as u32,
        0x00AD
            | 0x034F
            | 0x061C
            | 0x115F..=0x1160
            | 0x180E
            | 0x200B..=0x200F
            | 0x202A..=0x202E
            | 0x2060..=0x2064
            | 0x2066..=0x206F
            | 0x3164
            | 0xFE00..=0xFE0F
            | 0xFEFF
            | 0xFFA0
            | 0xFFF9..=0xFFFB
            | 0xE0000..=0xE007F
    )
}
const MAX_AVATAR_REDIRECTS: u32 = 5;

/// Built once; redirects are never auto-followed (`fetch_avatar` re-validates each hop).
pub(super) static HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .expect("refract-tauri: failed to build GitHub profile/avatar HTTP client")
});

#[derive(Debug, Clone)]
pub struct GitHubProfile {
    pub display_name: Option<String>,
    pub login: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug)]
pub struct ProfileFetchError {
    pub message: String,
}

impl ProfileFetchError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ProfileFetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ProfileFetchError {}

impl From<GhError> for ProfileFetchError {
    fn from(err: GhError) -> Self {
        Self {
            message: err.message,
        }
    }
}

#[derive(Debug)]
pub struct AvatarFetchError {
    pub message: String,
}

impl AvatarFetchError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AvatarFetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AvatarFetchError {}

/// Describes a transport failure without including response body content.
pub(super) fn describe_request_error(err: &reqwest::Error, context: &str) -> String {
    if err.is_timeout() {
        format!("{context} request timed out")
    } else {
        format!("{context} request failed: {err}")
    }
}

/// Reads `response`'s body up to `max_bytes`, erroring once exceeded. Uses `chunk()` because
/// `.bytes()`/`.text()` buffer the whole body before any cap applies.
pub(super) async fn collect_bounded(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("response read failed: {err}"))?
    {
        body.extend_from_slice(&chunk);
        if body.len() > max_bytes {
            return Err(format!("response exceeded {max_bytes} bytes"));
        }
    }
    Ok(body)
}

/// Reads `host`/`login`'s profile; the token is read without switching the active account, held
/// for one request, then dropped. Callers keep the cached entry on any `Err`.
pub async fn fetch_profile(host: &str, login: &str) -> Result<GitHubProfile, ProfileFetchError> {
    // Checked before `auth_token`: the request goes to `API_HOST`, so other hosts' tokens are never read.
    if host != SUPPORTED_AUTH_HOST {
        return Err(ProfileFetchError::new(format!(
            "profile fetch is only supported for {SUPPORTED_AUTH_HOST}, not {host}"
        )));
    }
    let token = auth_token(host, login).await?;

    // `set_sensitive(true)` keeps the token out of reqwest's own header debug/trace logging.
    let mut auth_header = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| ProfileFetchError::new("GitHub token contained an invalid header value"))?;
    auth_header.set_sensitive(true);

    let response = HTTP_CLIENT
        .get(format!("https://{API_HOST}/user"))
        // Held only in this one request's headers object; never logged, never written to disk.
        .header(AUTHORIZATION, auth_header)
        .header(ACCEPT, "application/vnd.github+json")
        .header(USER_AGENT, "Refract")
        .send()
        .await
        .map_err(|err| ProfileFetchError::new(describe_request_error(&err, "GitHub profile")))?;

    let status = response.status().as_u16();
    let body = collect_bounded(response, MAX_PROFILE_RESPONSE_BYTES)
        .await
        .map_err(ProfileFetchError::new)?;

    if status != 200 {
        return Err(ProfileFetchError::new(format!(
            "GitHub profile request failed with status {status}"
        )));
    }

    let parsed: Value = serde_json::from_slice(&body).map_err(|_| {
        ProfileFetchError::new(format!(
            "GitHub profile response for {login} was not valid JSON"
        ))
    })?;
    let record = parsed.as_object().ok_or_else(|| {
        ProfileFetchError::new(format!(
            "GitHub profile response for {login} was not a JSON object"
        ))
    })?;

    let display_name = record
        .get("name")
        .and_then(Value::as_str)
        .map(truncate_display_name)
        .filter(|name| !name.trim().is_empty());
    let avatar_url = record
        .get("avatar_url")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let responded_login = record
        .get("login")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| login.to_owned());

    Ok(GitHubProfile {
        display_name,
        login: responded_login,
        avatar_url,
    })
}

struct AvatarResponse {
    status: u16,
    content_type: Option<String>,
    location: Option<String>,
    body: Vec<u8>,
}

/// Parses `value` and asserts an `https:` URL on `AVATAR_HOST`; applied to every redirect target.
fn parse_avatar_url(value: &str) -> Result<Url, AvatarFetchError> {
    let url = Url::parse(value)
        .map_err(|_| AvatarFetchError::new(format!("avatar URL \"{value}\" is not a valid URL")))?;
    if url.scheme() != "https"
        || url.host_str() != Some(AVATAR_HOST)
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AvatarFetchError::new(format!(
            "avatar host \"{}\" is not {AVATAR_HOST}",
            url.host_str().unwrap_or("")
        )));
    }
    Ok(url)
}

fn resolve_avatar_mime_type(content_type: Option<&str>) -> Option<&'static str> {
    let base = content_type?.split(';').next()?.trim().to_lowercase();
    match base.as_str() {
        "image/png" => Some("image/png"),
        "image/jpeg" => Some("image/jpeg"),
        _ => None,
    }
}

/// Checks only the first bytes of `body` against `mime_type`'s magic number. Also used by
/// `images.rs` (ADR 0004).
pub(super) fn matches_image_signature(body: &[u8], mime_type: &str) -> bool {
    match mime_type {
        "image/png" => {
            body.len() >= 16
                && body.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
                && &body[12..16] == b"IHDR"
        }
        "image/jpeg" => body.len() >= 3 && body[0] == 0xff && body[1] == 0xd8 && body[2] == 0xff,
        "image/gif" => body.starts_with(b"GIF87a") || body.starts_with(b"GIF89a"),
        "image/webp" => body.len() >= 12 && &body[0..4] == b"RIFF" && &body[8..12] == b"WEBP",
        _ => false,
    }
}

async fn request_avatar_once(url: &Url) -> Result<AvatarResponse, AvatarFetchError> {
    let response = HTTP_CLIENT
        .get(url.clone())
        .header(USER_AGENT, "Refract")
        .send()
        .await
        .map_err(|err| AvatarFetchError::new(describe_request_error(&err, "avatar")))?;

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
    let body = collect_bounded(response, MAX_AVATAR_BYTES)
        .await
        .map_err(AvatarFetchError::new)?;

    Ok(AvatarResponse {
        status,
        content_type,
        location,
        body,
    })
}

/// Fetches `avatar_url` as a validated PNG/JPEG `data:` URL; every hop must be on `AVATAR_HOST`.
/// Callers fall back to initials on `Err`.
pub async fn fetch_avatar(avatar_url: &str) -> Result<String, AvatarFetchError> {
    let mut current = parse_avatar_url(avatar_url)?;
    let kept: Vec<(String, String)> = current
        .query_pairs()
        .filter(|(key, _)| key != "s")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    current
        .query_pairs_mut()
        .clear()
        .extend_pairs(kept)
        .append_pair("s", AVATAR_SIZE_PX);
    let mut response = request_avatar_once(&current).await?;

    let mut redirects = 0u32;
    while (300..400).contains(&response.status) {
        let Some(location) = response.location.as_deref() else {
            break;
        };
        if redirects >= MAX_AVATAR_REDIRECTS {
            return Err(AvatarFetchError::new(
                "avatar request redirected too many times",
            ));
        }
        redirects += 1;
        let next = current.join(location).map_err(|_| {
            AvatarFetchError::new(format!(
                "avatar redirect target \"{location}\" is not a valid URL"
            ))
        })?;
        current = parse_avatar_url(next.as_str())?;
        response = request_avatar_once(&current).await?;
    }

    if response.status != 200 {
        return Err(AvatarFetchError::new(format!(
            "avatar request failed with status {}",
            response.status
        )));
    }

    let mime_type = resolve_avatar_mime_type(response.content_type.as_deref())
        .ok_or_else(|| AvatarFetchError::new("avatar response had an unsupported Content-Type"))?;
    if !matches_image_signature(&response.body, mime_type) {
        return Err(AvatarFetchError::new(format!(
            "avatar response bytes did not match its declared {mime_type} signature"
        )));
    }

    Ok(format!(
        "data:{mime_type};base64,{}",
        BASE64.encode(&response.body)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_on_avatar_host() {
        assert!(parse_avatar_url("https://avatars.githubusercontent.com/u/123").is_ok());
    }

    #[test]
    fn rejects_wrong_scheme() {
        assert!(parse_avatar_url("http://avatars.githubusercontent.com/u/123").is_err());
    }

    #[test]
    fn rejects_wrong_host() {
        assert!(parse_avatar_url("https://evil.example.com/u/123").is_err());
    }

    #[test]
    fn rejects_host_confusion_suffix() {
        assert!(
            parse_avatar_url("https://avatars.githubusercontent.com.evil.example.com/u/123")
                .is_err()
        );
    }

    #[test]
    fn rejects_malformed_url() {
        assert!(parse_avatar_url("not a url").is_err());
    }

    #[test]
    fn rejects_explicit_port() {
        assert!(parse_avatar_url("https://avatars.githubusercontent.com:8080/u/123").is_err());
    }

    #[test]
    fn rejects_userinfo() {
        assert!(parse_avatar_url("https://user:pass@avatars.githubusercontent.com/u/123").is_err());
    }

    #[test]
    fn resolves_plain_png() {
        assert_eq!(
            resolve_avatar_mime_type(Some("image/png")),
            Some("image/png")
        );
    }

    #[test]
    fn resolves_content_type_with_parameter() {
        assert_eq!(
            resolve_avatar_mime_type(Some("image/png; charset=binary")),
            Some("image/png")
        );
    }

    #[test]
    fn resolves_case_insensitively() {
        assert_eq!(
            resolve_avatar_mime_type(Some("IMAGE/JPEG")),
            Some("image/jpeg")
        );
    }

    #[test]
    fn rejects_unsupported_content_type() {
        assert_eq!(resolve_avatar_mime_type(Some("image/gif")), None);
    }

    #[test]
    fn rejects_missing_content_type() {
        assert_eq!(resolve_avatar_mime_type(None), None);
    }

    fn png_bytes() -> Vec<u8> {
        let mut bytes = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        bytes.extend_from_slice(b"IHDR");
        bytes
    }

    #[test]
    fn matches_real_png_signature() {
        assert!(matches_image_signature(&png_bytes(), "image/png"));
    }

    #[test]
    fn rejects_png_bytes_claimed_as_jpeg() {
        assert!(!matches_image_signature(&png_bytes(), "image/jpeg"));
    }

    #[test]
    fn matches_real_jpeg_signature() {
        let bytes = [0xff, 0xd8, 0xff];
        assert!(matches_image_signature(&bytes, "image/jpeg"));
    }

    #[test]
    fn rejects_too_short_slice() {
        assert!(!matches_image_signature(&[0x89, 0x50], "image/png"));
    }

    #[test]
    fn rejects_random_bytes() {
        let bytes = [1u8, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        assert!(!matches_image_signature(&bytes, "image/png"));
        assert!(!matches_image_signature(&bytes, "image/jpeg"));
    }
}
