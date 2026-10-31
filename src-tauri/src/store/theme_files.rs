// Custom theme files (#458, spec 078): untrusted JSON in `<data dir>/themes/`, validated before it reaches the renderer.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use super::theme_id::ThemeId;

const MAX_FILE_BYTES: u64 = 64 * 1024;
const MAX_FILES: usize = 100;
const MAX_NAME_CHARS: usize = 40;
const ALLOWLIST_JSON: &str = include_str!("../../../src/shared/theme-tokens.json");

#[derive(Deserialize)]
struct Allowlist {
    tokens: Vec<String>,
}

fn allowed_tokens() -> &'static HashSet<String> {
    static TOKENS: OnceLock<HashSet<String>> = OnceLock::new();
    TOKENS.get_or_init(|| {
        let parsed: Allowlist =
            serde_json::from_str(ALLOWLIST_JSON).expect("theme-tokens.json is valid");
        parsed.tokens.into_iter().collect()
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawTheme {
    version: u32,
    name: String,
    base: ThemeId,
    tokens: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeFile {
    pub id: String,
    pub name: String,
    pub base: ThemeId,
    pub tokens: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RejectedTheme {
    pub file: String,
    pub error: String,
}

#[derive(Debug, Default, Serialize)]
pub struct ThemeList {
    pub themes: Vec<ThemeFile>,
    pub rejected: Vec<RejectedTheme>,
}

pub fn themes_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("themes")
}

fn is_number(arg: &str) -> bool {
    let body = arg
        .strip_suffix('%')
        .or_else(|| arg.strip_suffix("deg"))
        .unwrap_or(arg);
    let body = body.strip_prefix(['+', '-']).unwrap_or(body);
    let mut digits = 0;
    let mut dots = 0;
    for c in body.chars() {
        match c {
            '0'..='9' => digits += 1,
            '.' => dots += 1,
            _ => return false,
        }
    }
    digits > 0 && dots <= 1
}

/// The strict colour grammar: hex, `transparent`, or rgb/hsl/oklch with numeric arguments only.
pub fn is_valid_colour(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    if value == "transparent" {
        return true;
    }
    if let Some(hex) = value.strip_prefix('#') {
        return matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit());
    }
    let Some((func, rest)) = value.split_once('(') else {
        return false;
    };
    if !matches!(func, "rgb" | "rgba" | "hsl" | "hsla" | "oklch") {
        return false;
    }
    let Some(args) = rest.strip_suffix(')') else {
        return false;
    };
    if args.matches('/').count() > 1 {
        return false;
    }
    let parts: Vec<&str> = args
        .split([' ', ',', '/'])
        .filter(|part| !part.is_empty())
        .collect();
    (3..=4).contains(&parts.len()) && parts.iter().all(|part| is_number(part))
}

fn is_valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.len() <= 48
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn is_valid_name(name: &str) -> bool {
    let count = name.chars().count();
    (1..=MAX_NAME_CHARS).contains(&count)
        && name.trim() == name
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_' | '(' | ')' | '.'))
}

/// Validates the text of one theme file; the error is a single short reason for the user.
pub fn parse_theme(id: &str, text: &str) -> Result<ThemeFile, String> {
    let raw: RawTheme = serde_json::from_str(text).map_err(|err| {
        let msg = err.to_string();
        let msg: String = msg.chars().take(120).collect();
        format!("not a valid theme file ({msg})")
    })?;
    if raw.version != 1 {
        return Err("only version 1 theme files are supported".to_string());
    }
    if !is_valid_name(&raw.name) {
        return Err(format!(
            "the name must be 1 to {MAX_NAME_CHARS} letters, digits, spaces, dashes or brackets"
        ));
    }
    let allowed = allowed_tokens();
    for (token, value) in &raw.tokens {
        if !allowed.contains(token) {
            let shown: String = token.chars().take(40).collect();
            return Err(format!("'--{shown}' isn't a Refract colour token"));
        }
        if !is_valid_colour(value) {
            return Err(format!("the value of '--{token}' isn't a supported colour"));
        }
    }
    Ok(ThemeFile {
        id: id.to_string(),
        name: raw.name,
        base: raw.base,
        tokens: raw.tokens,
    })
}

/// Reads one file by id. Returns the reason when it cannot be used.
async fn read_theme(dir: &Path, id: &str) -> Result<ThemeFile, String> {
    if !is_valid_id(id) {
        return Err("file names use lowercase letters, digits and dashes".to_string());
    }
    let path = dir.join(format!("{id}.json"));
    let meta = tokio::fs::symlink_metadata(&path)
        .await
        .map_err(|_| "the file cannot be read".to_string())?;
    if !meta.is_file() {
        return Err("not a regular file".to_string());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err("the file is larger than 64 KiB".to_string());
    }
    let text = tokio::fs::read_to_string(&path)
        .await
        .map_err(|_| "the file is not readable text".to_string())?;
    parse_theme(id, &text)
}

pub async fn load(dir: &Path, id: &str) -> Option<ThemeFile> {
    read_theme(dir, id).await.ok()
}

pub async fn list(dir: &Path) -> ThemeList {
    let mut out = ThemeList::default();
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return out;
    };
    let mut seen = 0;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(".json") else {
            continue;
        };
        seen += 1;
        if seen > MAX_FILES {
            break;
        }
        match read_theme(dir, stem).await {
            Ok(theme) => out.themes.push(theme),
            Err(error) => out.rejected.push(RejectedTheme { file: name, error }),
        }
    }
    out.themes.sort_by_key(|a| a.name.to_lowercase());
    out.rejected.sort_by(|a, b| a.file.cmp(&b.file));
    out
}

fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_matches('-');
    let out: String = out.chars().take(40).collect();
    let reserved = matches!(out.as_str(), "con" | "prn" | "aux" | "nul")
        || ((out.starts_with("com") || out.starts_with("lpt"))
            && out.len() == 4
            && out.ends_with(|c: char| c.is_ascii_digit()));
    if out.is_empty() {
        "theme".to_string()
    } else if reserved {
        format!("theme-{out}")
    } else {
        out
    }
}

/// Validates `text` and stores it under a fresh id derived from its name.
pub async fn save_validated(dir: &Path, text: &str) -> Result<ThemeFile, String> {
    if text.len() as u64 > MAX_FILE_BYTES {
        return Err("the file is larger than 64 KiB".to_string());
    }
    let probe = parse_theme("probe", text)?;
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|_| "the themes folder cannot be created".to_string())?;
    let base = slug(&probe.name);
    for n in 1..100 {
        let id = if n == 1 {
            base.clone()
        } else {
            format!("{base}-{n}")
        };
        let path = dir.join(format!("{id}.json"));
        let created = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await;
        if let Ok(mut file) = created {
            use tokio::io::AsyncWriteExt;
            file.write_all(text.as_bytes())
                .await
                .map_err(|_| "the theme cannot be saved".to_string())?;
            return Ok(ThemeFile { id, ..probe });
        }
    }
    Err("too many themes share that name".to_string())
}

pub async fn remove(dir: &Path, id: &str) -> Result<(), String> {
    if !is_valid_id(id) {
        return Err("invalid theme id".to_string());
    }
    let path = dir.join(format!("{id}.json"));
    let meta = tokio::fs::symlink_metadata(&path)
        .await
        .map_err(|_| "the theme file is already gone".to_string())?;
    if !meta.is_file() {
        return Err("not a regular file".to_string());
    }
    tokio::fs::remove_file(&path)
        .await
        .map_err(|_| "the theme file cannot be removed".to_string())
}
