// Validated `owner/name` repo refs; every `gh` list/clone argument passes through here (#867).

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    pub owner: String,
    pub name: String,
}

impl RepoRef {
    pub fn name_with_owner(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
}

const INVALID_SOURCE: &str =
    "Enter a GitHub repository as owner/name or https://github.com/owner/name.";

/// 1 to 39 characters of `[A-Za-z0-9-]`, not starting or ending with `-`, no `--`.
pub fn is_valid_owner(owner: &str) -> bool {
    let len = owner.len();
    (1..=39).contains(&len)
        && owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && !owner.starts_with('-')
        && !owner.ends_with('-')
        && !owner.contains("--")
}

/// 1 to 100 characters of `[A-Za-z0-9._-]`, not `.` or `..`. A trailing `.git` is stripped by
/// the caller (`parse_source`) before this runs.
pub fn is_valid_name(name: &str) -> bool {
    let len = name.len();
    (1..=100).contains(&len)
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn build(owner: &str, name: &str) -> Result<RepoRef, &'static str> {
    let name = name.strip_suffix(".git").unwrap_or(name);
    if is_valid_owner(owner) && is_valid_name(name) {
        Ok(RepoRef {
            owner: owner.to_string(),
            name: name.to_string(),
        })
    } else {
        Err(INVALID_SOURCE)
    }
}

/// Accepts `owner/name` or `https://github.com/owner/name[/][.git]`; anything else is refused.
pub fn parse_source(raw: &str) -> Result<RepoRef, &'static str> {
    let text = raw.trim();
    if text.is_empty() || text.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(INVALID_SOURCE);
    }
    let path = match text.split_once("://") {
        Some((scheme, rest)) => {
            if !scheme.eq_ignore_ascii_case("https") {
                return Err(INVALID_SOURCE);
            }
            let (host, path) = rest.split_once('/').ok_or(INVALID_SOURCE)?;
            if !host.eq_ignore_ascii_case("github.com") {
                return Err(INVALID_SOURCE);
            }
            path.strip_suffix('/').unwrap_or(path)
        }
        None => text,
    };
    let mut segments = path.split('/');
    match (segments.next(), segments.next(), segments.next()) {
        (Some(owner), Some(name), None) => build(owner, name),
        _ => Err(INVALID_SOURCE),
    }
}
