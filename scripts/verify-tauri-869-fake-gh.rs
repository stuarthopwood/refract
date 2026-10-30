// Fake `gh` for the #869 live check: records every call's argv to FAKE_GH_LOG and serves pull
// requests (`search prs`), issues (`issue list`) and closed or merged pull requests (`pr list`)
// for octocat/hello-world and octocat/spoon-knife. While FAKE_GH_FAIL_FILE exists, `issue list`
// fails (the Refresh error line), and while FAKE_GH_FAIL_PRS_FILE exists, search prs fails. `pr list` reads FAKE_GH_BRANCHES: one `repo|branch|state|number`
// per line, written by the verify script once it knows the Sessions' generated branch names.
// It never talks to GitHub.
use std::io::Write;

fn flag_values(args: &[String], name: &str) -> Vec<String> {
    let prefixed = format!("{name}=");
    let mut out = Vec::new();
    for (i, arg) in args.iter().enumerate() {
        if arg == "--" {
            break;
        }
        if let Some(v) = arg.strip_prefix(&prefixed) {
            out.push(v.to_string());
        } else if arg == name {
            if let Some(v) = args.get(i + 1) {
                out.push(v.clone());
            }
        }
    }
    out
}

fn pr_row(repo: &str, number: u64, title: &str, author: &str) -> String {
    format!(
        r#"{{"number":{number},"title":"{title}","state":"open","isDraft":false,"author":{{"login":"{author}","name":null}},"updatedAt":"2026-10-2{}T10:00:00Z","repository":{{"name":"{}","nameWithOwner":"{repo}"}}}}"#,
        number % 10,
        repo.split('/').nth(1).unwrap_or("")
    )
}

fn issue_row(repo: &str, number: u64, title: &str, author: &str, assigned: bool) -> String {
    let assignees = if assigned { r#"[{"login":"octotest"}]"# } else { "[]" };
    format!(
        r#"{{"number":{number},"title":"{title}","state":"OPEN","url":"https://github.com/{repo}/issues/{number}","labels":[],"assignees":{assignees},"author":{{"login":"{author}"}},"comments":[],"updatedAt":"2026-10-2{}T10:00:00Z"}}"#,
        number % 10
    )
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
    let repos = flag_values(&args, "--repo");
    let out = if joined.starts_with("auth status") {
        r#"{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"octotest"}]}}"#.to_string()
    } else if joined.starts_with("api rate_limit") {
        r#"{"resources":{"search":{"limit":30,"remaining":28,"reset":0}}}"#.to_string()
    } else if joined.starts_with("api user") {
        r#"{"login":"octotest"}"#.to_string()
    } else if joined.starts_with("search prs") {
        if std::env::var("FAKE_GH_FAIL_PRS_FILE").map_or(false, |f| std::path::Path::new(&f).exists()) {
            eprintln!("fake gh: forced search prs failure");
            std::process::exit(1);
        }
        let review = !flag_values(&args, "--review-requested").is_empty();
        let rows: Vec<String> = repos
            .iter()
            .filter_map(|r| match (r.as_str(), review) {
                ("octocat/hello-world", false) => Some(pr_row(r, 1, "Add passing feature", "octotest")),
                ("octocat/hello-world", true) => Some(pr_row(r, 2, "Fix failing build", "hubot")),
                ("octocat/spoon-knife", false) => Some(pr_row(r, 4, "Spoon polish", "octotest")),
                ("octocat/spoon-knife", true) => Some(pr_row(r, 5, "Handle tightening", "hubot")),
                _ => None,
            })
            .collect();
        format!("[{}]", rows.join(","))
    } else if joined.starts_with("issue list") {
        if std::env::var("FAKE_GH_FAIL_FILE").map_or(false, |f| std::path::Path::new(&f).exists()) {
            eprintln!("fake gh: forced issue list failure");
            std::process::exit(1);
        }
        let assigned = !flag_values(&args, "--assignee").is_empty();
        let rows: Vec<String> = repos
            .iter()
            .filter_map(|r| match (r.as_str(), assigned) {
                ("octocat/hello-world", true) => Some(issue_row(r, 12, "Crash when saving a draft", "hubot", true)),
                ("octocat/hello-world", false) => Some(issue_row(r, 13, "Docs mention the old flag", "octotest", false)),
                ("octocat/spoon-knife", true) => Some(issue_row(r, 5, "Fork handle is loose", "hubot", true)),
                _ => None,
            })
            .collect();
        format!("[{}]", rows.join(","))
    } else if joined.starts_with("pr list") {
        let repo = repos.first().cloned().unwrap_or_default();
        let lines = std::env::var("FAKE_GH_BRANCHES").ok().and_then(|f| std::fs::read_to_string(f).ok()).unwrap_or_default();
        let rows: Vec<String> = lines
            .lines()
            .filter_map(|l| {
                let p: Vec<&str> = l.split('|').collect();
                if p.len() == 4 && p[0] == repo {
                    Some(format!(r#"{{"number":{n},"state":"{s}","url":"https://github.com/{repo}/pull/{n}","headRefName":"{b}","headRepositoryOwner":{{"login":"octocat"}}}}"#, n = p[3], s = p[2], b = p[1]))
                } else {
                    None
                }
            })
            .collect();
        format!("[{}]", rows.join(","))
    } else {
        eprintln!("fake gh: unhandled command: gh {joined}");
        std::process::exit(1);
    };
    println!("{out}");
}
