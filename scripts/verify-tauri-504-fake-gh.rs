// Fake `gh` for the #504 live check: records every call's argv to FAKE_GH_LOG and serves a fixed
// set of issues for two repositories (octocat/hello-world and octocat/spoon-knife), honouring the
// state, assignee, author, mention, label and search flags `issues.list` sends. It never talks to
// GitHub.
use std::io::Write;

struct Issue {
    repo: &'static str,
    number: u64,
    title: &'static str,
    state: &'static str,
    labels: &'static [&'static str],
    assignee: bool,
    author_me: bool,
    mention: bool,
    comments: usize,
}

const ISSUES: &[Issue] = &[
    Issue { repo: "octocat/hello-world", number: 12, title: "Crash when saving a draft", state: "OPEN", labels: &["bug"], assignee: true, author_me: true, mention: false, comments: 3 },
    Issue { repo: "octocat/hello-world", number: 7, title: "Saving fails on Windows", state: "CLOSED", labels: &["bug"], assignee: false, author_me: false, mention: false, comments: 1 },
    Issue { repo: "octocat/hello-world", number: 20, title: "Docs mention the old flag", state: "OPEN", labels: &["docs"], assignee: false, author_me: false, mention: true, comments: 0 },
    Issue { repo: "octocat/spoon-knife", number: 3, title: "Spoon bends under load", state: "OPEN", labels: &["enhancement"], assignee: false, author_me: true, mention: false, comments: 2 },
    Issue { repo: "octocat/spoon-knife", number: 5, title: "Fork handle is loose", state: "OPEN", labels: &["bug"], assignee: true, author_me: false, mention: false, comments: 0 },
];

fn colour(label: &str) -> &'static str {
    match label {
        "bug" => "d73a4a",
        "docs" => "0075ca",
        _ => "a2eeef",
    }
}

fn row(issue: &Issue, with_body: bool) -> String {
    let labels: Vec<String> = issue
        .labels
        .iter()
        .map(|l| format!(r#"{{"name":"{l}","color":"{}","description":""}}"#, colour(l)))
        .collect();
    let assignees = if issue.assignee { r#"[{"login":"octotest"}]"# } else { "[]" };
    let author = if issue.author_me { "octotest" } else { "hubot" };
    let comments = vec!["{}"; issue.comments].join(",");
    let body = if with_body {
        format!(r#","body":"Body of issue {} with **markdown** and <b>raw html</b>.","createdAt":"2026-10-01T09:00:00Z""#, issue.number)
    } else {
        String::new()
    };
    format!(
        r#"{{"number":{},"title":"{}","state":"{}","url":"https://github.com/{}/issues/{}","labels":[{}],"assignees":{},"author":{{"login":"{}"}},"comments":[{}],"updatedAt":"2026-10-2{}T10:00:00Z"{}}}"#,
        issue.number, issue.title, issue.state, issue.repo, issue.number, labels.join(","), assignees, author, comments, issue.number % 10, body
    )
}

fn flag(args: &[String], name: &str) -> Option<String> {
    let prefixed = format!("{name}=");
    for (i, arg) in args.iter().enumerate() {
        if let Some(value) = arg.strip_prefix(&prefixed) {
            return Some(value.to_string());
        }
        if arg == name {
            return args.get(i + 1).cloned();
        }
    }
    None
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Ok(log) = std::env::var("FAKE_GH_LOG") {
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(log) {
            let argv: Vec<String> = args.iter().map(|a| format!("{a:?}")).collect();
            let _ = writeln!(file, "ARGV [{}]", argv.join(", "));
        }
    }
    let joined = args.join(" ");
    let repo = flag(&args, "--repo").unwrap_or_default();
    let out = if joined.starts_with("auth status") {
        r#"{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"octotest"}]}}"#.to_string()
    } else if joined.starts_with("label list") {
        r#"[{"name":"bug","color":"d73a4a","description":""},{"name":"enhancement","color":"a2eeef","description":""},{"name":"docs","color":"0075ca","description":""}]"#.to_string()
    } else if joined.starts_with("issue list") {
        let state = flag(&args, "--state").unwrap_or_else(|| "open".into());
        let label = flag(&args, "--label");
        let search = flag(&args, "--search").map(|s| s.to_lowercase());
        let assignee = flag(&args, "--assignee").is_some();
        let author = flag(&args, "--author").is_some();
        let mention = flag(&args, "--mention").is_some();
        let rows: Vec<String> = ISSUES
            .iter()
            .filter(|i| i.repo == repo)
            .filter(|i| state == "all" || i.state.eq_ignore_ascii_case(&state))
            .filter(|i| !assignee || i.assignee)
            .filter(|i| !author || i.author_me)
            .filter(|i| !mention || i.mention)
            .filter(|i| label.as_ref().map_or(true, |l| i.labels.contains(&l.as_str())))
            .filter(|i| search.as_ref().map_or(true, |s| i.title.to_lowercase().contains(s)))
            .map(|i| row(i, false))
            .collect();
        format!("[{}]", rows.join(","))
    } else if joined.starts_with("issue view") {
        let number: u64 = args.get(2).and_then(|n| n.parse().ok()).unwrap_or(0);
        match ISSUES.iter().find(|i| i.repo == repo && i.number == number) {
            Some(issue) => row(issue, true),
            None => std::process::exit(1),
        }
    } else {
        std::process::exit(1);
    };
    println!("{out}");
}
