// Finds the WATCHDOG.yml advisor roster OMP would load (#1409, spec 070). A roster silently replaces
// the Advisor role, so Refract only reports it; it never edits or deletes the file.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RosterAdvisor {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Roster {
    pub path: String,
    pub advisors: Vec<RosterAdvisor>,
}

const FILE_NAMES: [&str; 4] = [
    "WATCHDOG.yml",
    "WATCHDOG.yaml",
    ".omp/WATCHDOG.yml",
    ".omp/WATCHDOG.yaml",
];
const MAX_BYTES: u64 = 256 * 1024;
const MAX_LEVELS: usize = 64;
const MAX_LINES: usize = 2000;

/// OMP's agent dir: `PI_CODING_AGENT_DIR`, else `~/.omp/agent`.
pub fn agent_dir() -> Option<PathBuf> {
    match std::env::var_os("PI_CODING_AGENT_DIR") {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => dirs::home_dir().map(|home| home.join(".omp").join("agent")),
    }
}

/// A symlink or special file is never read or opened: a repo can ship `WATCHDOG.yml` as a link.
fn is_regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_file())
        .unwrap_or(false)
}

/// The canonical roster file to open, or `None` when `path` no longer names one. The file must resolve to
/// exactly `<canonical root>/<known name>`, so a symlinked parent (for example `.omp`) or leaf is refused.
pub fn openable_target(path: &Path) -> Option<PathBuf> {
    let canonical = dunce::canonicalize(path).ok()?;
    if !canonical.is_file() {
        return None;
    }
    // Longest first, so `root/.omp/WATCHDOG.yml` is judged against `root`, not against `.omp`.
    let mut names = FILE_NAMES;
    names.sort_by_key(|name| std::cmp::Reverse(Path::new(name).components().count()));
    let name = names.into_iter().find(|name| path.ends_with(name))?;
    let mut root = path.to_path_buf();
    for _ in Path::new(name).components() {
        root.pop();
    }
    let root = dunce::canonicalize(root).ok()?;
    let expected = root.join(name);
    // NTFS is case-insensitive: the on-disk case may differ from the known name, but a link changes the path shape.
    let same = canonical == expected
        || (cfg!(windows)
            && canonical
                .to_string_lossy()
                .eq_ignore_ascii_case(&expected.to_string_lossy()));
    same.then_some(canonical)
}

fn find_in(dir: &Path) -> Option<PathBuf> {
    FILE_NAMES
        .iter()
        .map(|name| dir.join(name))
        .find(|path| is_regular_file(path))
}

/// Agent dir first, then `cwd` and each parent up to the directory holding `.git`.
pub fn detect(agent_dir: Option<&Path>, cwd: Option<&Path>) -> Option<Roster> {
    let mut found = agent_dir.and_then(find_in);
    if found.is_none() {
        if let Some(cwd) = cwd {
            for dir in cwd.ancestors().take(MAX_LEVELS) {
                if let Some(path) = find_in(dir) {
                    found = Some(path);
                    break;
                }
                if dir.join(".git").exists() {
                    break;
                }
            }
        }
    }
    let path = found?;
    let advisors = read_limited(&path)
        .map(|text| parse_advisors(&text))
        .unwrap_or_default();
    Some(Roster {
        path: path.to_string_lossy().into_owned(),
        advisors,
    })
}

/// Blocking filesystem work, so it runs off the async runtime.
pub async fn detect_for(cwd: Option<PathBuf>) -> Option<Roster> {
    tokio::task::spawn_blocking(move || detect(agent_dir().as_deref(), cwd.as_deref()))
        .await
        .ok()
        .flatten()
}

fn read_limited(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(MAX_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

struct Line {
    indent: usize,
    item: bool,
    key: Option<String>,
    value: String,
}

fn strip_comment(raw: &str) -> &str {
    if raw.trim_start().starts_with('#') {
        return "";
    }
    match raw.find(" #") {
        Some(at) => &raw[..at],
        None => raw,
    }
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    for quote in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

fn parse_lines(text: &str) -> Vec<Line> {
    let mut lines = Vec::new();
    for raw in text.lines().take(MAX_LINES) {
        let raw = strip_comment(raw).trim_end();
        let body = raw.trim_start();
        if body.is_empty() {
            continue;
        }
        let mut indent = raw.len() - body.len();
        let item = body == "-" || body.starts_with("- ");
        let content = if item {
            let rest = body[1..].trim_start();
            indent += body.len() - rest.len();
            rest
        } else {
            body
        };
        let keyed = content.split_once(':').filter(|(key, value)| {
            !key.is_empty()
                && key
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
                && (value.is_empty() || value.starts_with(char::is_whitespace))
        });
        lines.push(match keyed {
            Some((key, value)) => Line {
                indent,
                item,
                key: Some(key.to_string()),
                value: unquote(value),
            },
            None => Line {
                indent,
                item,
                key: None,
                value: unquote(content),
            },
        });
    }
    lines
}

/// Lenient on purpose: reads `- name: x` / `model: y` list entries, bare `- x` items, and
/// `name:` maps whose direct children include `model`.
fn parse_advisors(text: &str) -> Vec<RosterAdvisor> {
    let lines = parse_lines(text);
    let listed = parse_list_form(&lines);
    if listed.is_empty() {
        parse_map_form(&lines)
    } else {
        listed
    }
}

fn parse_list_form(lines: &[Line]) -> Vec<RosterAdvisor> {
    let mut advisors = Vec::new();
    let mut current: Option<(usize, RosterAdvisor)> = None;
    let mut flush = |current: &mut Option<(usize, RosterAdvisor)>| {
        if let Some((_, advisor)) = current.take() {
            if !advisor.name.is_empty() || advisor.model.is_some() {
                advisors.push(advisor);
            }
        }
    };
    for line in lines {
        // An item's indent already includes its "- ", so a sibling key sits at the same indent.
        let continues = matches!(&current, Some((dash, _)) if line.indent > *dash || (!line.item && line.indent == *dash));
        if line.item && !continues {
            flush(&mut current);
            let mut advisor = RosterAdvisor {
                name: String::new(),
                model: None,
            };
            apply(&mut advisor, line);
            current = Some((line.indent, advisor));
        } else if continues {
            if let Some((_, advisor)) = current.as_mut() {
                apply(advisor, line);
            }
        } else {
            flush(&mut current);
        }
    }
    flush(&mut current);
    advisors
}

fn apply(advisor: &mut RosterAdvisor, line: &Line) {
    match line.key.as_deref() {
        Some("name") | Some("id") => advisor.name = line.value.clone(),
        Some("model") if !line.value.is_empty() => advisor.model = Some(line.value.clone()),
        None if line.item && advisor.name.is_empty() => advisor.name = line.value.clone(),
        _ => {}
    }
}

fn parse_map_form(lines: &[Line]) -> Vec<RosterAdvisor> {
    let mut advisors = Vec::new();
    for (at, line) in lines.iter().enumerate() {
        let Some(name) = line
            .key
            .as_deref()
            .filter(|_| !line.item && line.value.is_empty())
        else {
            continue;
        };
        let mut child_indent = None;
        for child in &lines[at + 1..] {
            if child.indent <= line.indent {
                break;
            }
            let direct = *child_indent.get_or_insert(child.indent);
            if child.indent == direct
                && child.key.as_deref() == Some("model")
                && !child.value.is_empty()
            {
                advisors.push(RosterAdvisor {
                    name: name.to_string(),
                    model: Some(child.value.clone()),
                });
                break;
            }
        }
    }
    advisors
}
