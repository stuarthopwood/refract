// Maps one simple `gh` command (already tokenised) to the PR or issue it writes to.

use super::{WriteAction, WriteKind};

/// What a command names; `number` stays `None` when only the command's output can say.
pub(super) struct ParsedWrite {
    pub repo: Option<(String, String)>,
    pub kind: WriteKind,
    pub number: Option<u64>,
    pub action: WriteAction,
}

/// Flags that consume the next word, per verb, so `--body "..."` never yields a number.
struct ValueFlags {
    long: &'static [&'static str],
    short: &'static [char],
}

const PR_CREATE: ValueFlags = ValueFlags {
    long: &[
        "--assignee",
        "--base",
        "--body",
        "--body-file",
        "--head",
        "--label",
        "--milestone",
        "--project",
        "--reviewer",
        "--template",
        "--title",
    ],
    short: &['a', 'B', 'b', 'F', 'H', 'l', 'm', 'p', 'r', 'T', 't'],
};
const PR_MERGE: ValueFlags = ValueFlags {
    long: &[
        "--author-email",
        "--body",
        "--body-file",
        "--match-head-commit",
        "--subject",
    ],
    short: &['A', 'b', 'F', 't'],
};
const COMMENT_FLAGS: ValueFlags = ValueFlags {
    long: &["--body", "--body-file"],
    short: &['b', 'F'],
};
const CLOSE_PR: ValueFlags = ValueFlags {
    long: &["--comment"],
    short: &['c'],
};
const ISSUE_CREATE: ValueFlags = ValueFlags {
    long: &[
        "--assignee",
        "--body",
        "--body-file",
        "--label",
        "--milestone",
        "--project",
        "--template",
        "--title",
    ],
    short: &['a', 'b', 'F', 'l', 'm', 'p', 'T', 't'],
};
const ISSUE_EDIT: ValueFlags = ValueFlags {
    long: &[
        "--add-assignee",
        "--add-label",
        "--add-project",
        "--body",
        "--body-file",
        "--milestone",
        "--remove-assignee",
        "--remove-label",
        "--remove-project",
        "--title",
    ],
    short: &['b', 'F', 'm', 't'],
};
const ISSUE_CLOSE: ValueFlags = ValueFlags {
    long: &["--comment", "--reason"],
    short: &['c', 'r'],
};

/// `gh api` flags that consume the next word.
const API_VALUE_LONG: &[&str] = &[
    "--method",
    "--field",
    "--raw-field",
    "--header",
    "--input",
    "--jq",
    "--template",
    "--cache",
    "--hostname",
    "--preview",
];
const API_VALUE_SHORT: &[char] = &['X', 'F', 'f', 'H', 'q', 't', 'p'];

/// Parses a simple command; `None` for anything that is not a recognised `gh` write.
pub(super) fn parse(words: &[String]) -> Option<ParsedWrite> {
    let mut rest = words;
    while let Some(first) = rest.first() {
        if is_assignment(first) {
            rest = &rest[1..];
        } else {
            break;
        }
    }
    let (program, args) = rest.split_first()?;
    if program != "gh" {
        return None;
    }
    let (group, args) = args.split_first()?;
    match group.as_str() {
        "api" => parse_api(args),
        "pr" | "issue" => {
            let (verb, args) = args.split_first()?;
            let kind = if group == "pr" {
                WriteKind::Pr
            } else {
                WriteKind::Issue
            };
            let (action, flags) = match (kind, verb.as_str()) {
                (WriteKind::Pr, "create") => (WriteAction::Create, &PR_CREATE),
                (WriteKind::Pr, "merge") => (WriteAction::Merge, &PR_MERGE),
                (WriteKind::Pr, "close") => (WriteAction::Close, &CLOSE_PR),
                (WriteKind::Pr, "comment") => (WriteAction::Comment, &COMMENT_FLAGS),
                (WriteKind::Issue, "create") => (WriteAction::Create, &ISSUE_CREATE),
                (WriteKind::Issue, "edit") => (WriteAction::Edit, &ISSUE_EDIT),
                (WriteKind::Issue, "close") => (WriteAction::Close, &ISSUE_CLOSE),
                (WriteKind::Issue, "comment") => (WriteAction::Comment, &COMMENT_FLAGS),
                _ => return None,
            };
            Some(parse_verb(kind, action, flags, args))
        }
        _ => None,
    }
}

fn is_assignment(word: &str) -> bool {
    match word.split_once('=') {
        Some((name, _)) => {
            !name.is_empty()
                && !name.starts_with(|c: char| c.is_ascii_digit())
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        }
        None => false,
    }
}

fn parse_verb(
    kind: WriteKind,
    action: WriteAction,
    flags: &ValueFlags,
    args: &[String],
) -> ParsedWrite {
    let mut repo: Option<(String, String)> = None;
    let mut number: Option<u64> = None;
    let mut positional_seen = false;
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        i += 1;
        if let Some(long) = arg.strip_prefix("--") {
            let (name, inline) = match long.split_once('=') {
                Some((n, v)) => (n, Some(v)),
                None => (long, None),
            };
            let flag = format!("--{name}");
            let is_repo = flag == "--repo";
            if is_repo || flags.long.contains(&flag.as_str()) {
                let value = match inline {
                    Some(v) => Some(v),
                    None => {
                        let v = args.get(i).map(String::as_str);
                        i += 1;
                        v
                    }
                };
                if is_repo {
                    repo = value.and_then(parse_repo);
                }
            }
        } else if arg.len() > 1 && arg.starts_with('-') {
            let letter = arg.chars().nth(1).unwrap_or('-');
            if letter == 'R' {
                let value = if arg.len() > 2 {
                    Some(&arg[2..])
                } else {
                    let v = args.get(i).map(String::as_str);
                    i += 1;
                    v
                };
                repo = value.and_then(parse_repo);
            } else if flags.short.contains(&letter) && arg.len() == 2 {
                i += 1;
            }
        } else if !positional_seen {
            positional_seen = true;
            if let Some((r, n)) = parse_target(arg) {
                if r.is_some() {
                    repo = repo.or(r);
                }
                number = Some(n);
            }
        }
    }
    ParsedWrite {
        repo,
        kind,
        number,
        action,
    }
}

/// A number (`12`, `#12`) or a GitHub PR/issue URL; a branch name or anything else is `None`.
fn parse_target(arg: &str) -> Option<(Option<(String, String)>, u64)> {
    let digits = arg.strip_prefix('#').unwrap_or(arg);
    if let Ok(n) = digits.parse::<u64>() {
        return (n > 0).then_some((None, n));
    }
    first_github_url(arg).map(|(owner, name, _, n)| (Some((owner, name)), n))
}

fn parse_repo(value: &str) -> Option<(String, String)> {
    let value = value.strip_prefix("https://github.com/").unwrap_or(value);
    let mut parts = value.trim_end_matches('/').split('/');
    let owner = parts.next()?;
    let name = parts.next()?;
    // A host-prefixed `HOST/OWNER/REPO` is a third segment: not github.com, so not handled.
    if parts.next().is_some() || !valid_segment(owner) || !valid_segment(name) {
        return None;
    }
    Some((owner.to_string(), name.to_string()))
}

fn valid_segment(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// First `https://github.com/{o}/{r}/(pull|issues)/{n}` in `text`: `(owner, repo, kind, number)`.
pub(super) fn first_github_url(text: &str) -> Option<(String, String, WriteKind, u64)> {
    all_github_urls(text).into_iter().next()
}

/// Every such URL in `text`, in order.
pub(super) fn all_github_urls(text: &str) -> Vec<(String, String, WriteKind, u64)> {
    const PREFIX: &str = "https://github.com/";
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(pos) = text[from..].find(PREFIX) {
        let start = from + pos + PREFIX.len();
        from = start;
        let tail: &str = text[start..]
            .split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ')' | '>' | '<' | '`'))
            .next()
            .unwrap_or("");
        let mut parts = tail.split('/');
        let (Some(owner), Some(name), Some(segment), Some(num)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let kind = match segment {
            "pull" => WriteKind::Pr,
            "issues" => WriteKind::Issue,
            _ => continue,
        };
        let digits: String = num.chars().take_while(char::is_ascii_digit).collect();
        let Ok(number) = digits.parse::<u64>() else {
            continue;
        };
        if number > 0 && valid_segment(owner) && valid_segment(name) {
            found.push((owner.to_string(), name.to_string(), kind, number));
        }
    }
    found
}

fn parse_api(args: &[String]) -> Option<ParsedWrite> {
    let mut method: Option<String> = None;
    // `gh api` sends POST when any field or an input file is given and no method is set.
    let mut has_body = false;
    let mut endpoint: Option<&str> = None;
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        i += 1;
        if let Some(long) = arg.strip_prefix("--") {
            let (name, inline) = match long.split_once('=') {
                Some((n, v)) => (n, Some(v)),
                None => (long, None),
            };
            let flag = format!("--{name}");
            if API_VALUE_LONG.contains(&flag.as_str()) {
                let value = match inline {
                    Some(v) => Some(v.to_string()),
                    None => {
                        let v = args.get(i).cloned();
                        i += 1;
                        v
                    }
                };
                match flag.as_str() {
                    "--method" => method = value.map(|v| v.to_ascii_uppercase()),
                    "--input" | "--field" | "--raw-field" => has_body = true,
                    _ => {}
                }
            }
        } else if arg.len() > 1 && arg.starts_with('-') {
            let letter = arg.chars().nth(1).unwrap_or('-');
            if API_VALUE_SHORT.contains(&letter) {
                let value = if arg.len() > 2 {
                    // pflag accepts `-X=PATCH` as well as `-XPATCH`.
                    Some(arg[2..].strip_prefix('=').unwrap_or(&arg[2..]).to_string())
                } else {
                    let v = args.get(i).cloned();
                    i += 1;
                    v
                };
                match letter {
                    'X' => method = value.map(|v| v.to_ascii_uppercase()),
                    'F' | 'f' => has_body = true,
                    _ => {}
                }
            }
        } else if endpoint.is_none() {
            endpoint = Some(arg);
        }
    }
    let method = method.or_else(|| has_body.then(|| "POST".to_string()));
    if !matches!(method.as_deref(), Some("POST" | "PATCH" | "PUT" | "DELETE")) {
        return None;
    }
    let path = endpoint?.split(['?', '#']).next()?.trim_start_matches('/');
    let mut segments = path.split('/');
    if segments.next()? != "repos" {
        return None;
    }
    let owner = segments.next()?;
    let name = segments.next()?;
    // `gh` fills these placeholders from the current repository, as for a command with no repo.
    let repo = if is_repo_placeholder(owner, name) {
        None
    } else if valid_segment(owner) && valid_segment(name) {
        Some((owner.to_string(), name.to_string()))
    } else {
        return None;
    };
    let kind = match segments.next()? {
        "pulls" => WriteKind::Pr,
        "issues" => WriteKind::Issue,
        _ => return None,
    };
    let number = match segments.next() {
        Some(n) => Some(n.parse::<u64>().ok().filter(|n| *n > 0)?),
        // POST to the collection creates; its output URL names the new item.
        None if method.as_deref() == Some("POST") => None,
        None => return None,
    };
    Some(ParsedWrite {
        repo,
        kind,
        number,
        action: WriteAction::ApiWrite,
    })
}

fn is_repo_placeholder(owner: &str, name: &str) -> bool {
    matches!((owner, name), ("{owner}" | ":owner", "{repo}" | ":repo"))
}
