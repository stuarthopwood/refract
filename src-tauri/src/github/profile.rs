// Port of `src/main/github/profile.ts`: per-account GitHub profile/avatar fetch (research.md
// decisions 3-5, contracts/ipc.md), lane R9 issue #792. `fetch_profile` reads a short-lived token
// for one account via the GitHub CLI (`cli::auth_token`), makes one bounded HTTPS request to
// GitHub's REST API with it, and discards the token immediately -- it lives only in this
// function's local scope for that one request, never logged, never written to disk, never sent
// over IPC to the renderer (FR-012, constitution Principle V). `fetch_avatar` makes a second
// bounded request that validates and inlines that account's avatar as a `data:` URL (FR-007,
// decision 4) so the renderer never loads a remote image, or makes the request, itself.
//
// `HTTP_CLIENT` below is built with `redirect::Policy::none()`: `reqwest`'s own automatic
// redirect following is never enabled. `fetch_avatar` implements its own redirect loop so every
// hop can be re-validated against the avatar host allowlist before it is ever requested
// (SSRF-via-redirect), matching the ported TS's own manual loop byte for byte.

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
// GateSec008 HIGH / GateCode008 CRITICAL: the REST call below is hard-coded to `API_HOST`, so a
// token for any other host (GitHub Enterprise, say) must never even be read, let alone sent
// there. `fetch_profile` enforces this before `auth_token` is ever called.
const SUPPORTED_AUTH_HOST: &str = "github.com";
const AVATAR_HOST: &str = "avatars.githubusercontent.com";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
// A GitHub user profile JSON document is a few hundred bytes; generously bounded so a buggy or
// malicious response can never be buffered in full.
const MAX_PROFILE_RESPONSE_BYTES: usize = 64 * 1024;
// research.md decision 4: comfortably above GitHub's own largest served avatar size.
const MAX_AVATAR_BYTES: usize = 256 * 1024;
const MAX_AVATAR_REDIRECTS: u32 = 5;

/// Built once: redirects are NEVER followed automatically (`fetch_avatar` re-validates every hop
/// against `AVATAR_HOST` itself before requesting it), and a blanket 10s timeout matches both
/// callers' own `REQUEST_TIMEOUT`.
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

/// Describes a `reqwest` transport failure for an error message, without ever including response
/// body content (there may not be one yet at this point in either caller).
pub(super) fn describe_request_error(err: &reqwest::Error, context: &str) -> String {
    if err.is_timeout() {
        format!("{context} request timed out")
    } else {
        format!("{context} request failed: {err}")
    }
}

/// Reads `response`'s body up to `max_bytes`, chunk by chunk, erroring once exceeded so a huge or
/// malicious response can never be buffered in full. Deliberately uses `Response::chunk()` rather
/// than `.bytes()`/`.text()`, which buffer the whole body unconditionally before any cap could
/// ever apply.
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

/// Reads `host`/`login`'s GitHub profile (research.md decision 3): `auth_token` reads that
/// account's token without switching the real active account, held only in the local `token`
/// binding below for the one request it makes, then dropped -- never retained, never passed
/// anywhere else. Callers fall back to the previously cached entry on any `Err` (data-model.md
/// "a failed or skipped fetch... leaves the previous entry untouched").
pub async fn fetch_profile(host: &str, login: &str) -> Result<GitHubProfile, ProfileFetchError> {
    // Checked BEFORE auth_token is ever called (GateSec008 HIGH / GateCode008 CRITICAL): this
    // request always goes to the fixed API_HOST below, so a non-github.com account's token must
    // never be read at all, let alone sent to the wrong server.
    if host != SUPPORTED_AUTH_HOST {
        return Err(ProfileFetchError::new(format!(
            "profile fetch is only supported for {SUPPORTED_AUTH_HOST}, not {host}"
        )));
    }
    let token = auth_token(host, login).await?;

    // Built explicitly (not via `.header(_, format!(...))`) so `set_sensitive(true)` can be
    // applied before it is ever attached to the request builder: defence in depth so the token
    // is also excluded from reqwest's own debug/trace logging of outgoing headers, never just
    // this codebase's own logging.
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
        .map(str::to_owned);
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

/// Parses `value` and asserts it is an `https:` URL on `AVATAR_HOST` -- applied to the initial
/// URL and to every redirect target before it is ever requested.
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

/// Matches `shared/images.ts`'s own `matchesImageSignature`: checks only the first few bytes of
/// `body` against `mime_type`'s real magic-byte signature, never the whole payload. Also used by
/// `images.rs` for the pull request image allow-list (ADR 0004).
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

/// Fetches `avatar_url` and returns it as a validated `data:image/png;base64,...` or
/// `data:image/jpeg;base64,...` string (FR-007, research.md decision 4). Every URL this function
/// actually requests -- the one passed in, and the target of any redirect -- is bounded to
/// `AVATAR_HOST` before it is ever requested, so a redirect can never be trusted into fetching
/// some other host (SSRF-via-redirect); the response must also declare `Content-Type: image/png`
/// or `image/jpeg` AND its first bytes must match that format's real magic number, and the body
/// is capped at `MAX_AVATAR_BYTES`. Callers fall back to initials (FR-007) on any `Err`.
pub async fn fetch_avatar(avatar_url: &str) -> Result<String, AvatarFetchError> {
    let mut current = parse_avatar_url(avatar_url)?;
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

    // --- parse_avatar_url ---

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

    // --- resolve_avatar_mime_type ---

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

    // --- matches_image_signature ---

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
