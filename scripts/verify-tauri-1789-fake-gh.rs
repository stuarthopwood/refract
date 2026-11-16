// Fake `gh` for the #1789 live check: records every call's argv to FAKE_GH_LOG and serves a fixed
// set of issues and pull requests for octocat/hello-world through `api search/issues` and
// `api repos/<o>/<r>/issues|pulls/<n>`. Control files next to FAKE_GH_LOG: `fail` makes every call
// exit 1 (offline / signed out); `delay-ms` holds each call so the loading row can be seen.
// It never talks to GitHub.
use std::io::Write;

struct Item {
    number: u64,
    title: &'static str,
    state: &'static str, // open | closed
    pr: bool,
    draft: bool,
    merged: bool,
}

// Listed newest-updated first, as GitHub's sort=updated&order=desc would.
const ITEMS: &[Item] = &[
    Item { number: 42, title: "Add hash picker to the composer", state: "open", pr: true, draft: false, merged: false },
    Item { number: 12, title: "Crash when saving a draft", state: "open", pr: false, draft: false, merged: false },
    Item { number: 31, title: "WIP: rewrite the parser", state: "open", pr: true, draft: true, merged: false },
    Item { number: 7, title: "Saving fails on Windows", state: "closed", pr: false, draft: false, merged: false },
    Item { number: 5, title: "Fix save crash", state: "closed", pr: true, draft: false, merged: true },
];

fn search_row(i: &Item) -> String {
    let pull = if i.pr {
        format!(r#","pull_request":{{"merged_at":{}}}"#, if i.merged { r#""2026-01-01T00:00:00Z""# } else { "null" })
    } else {
        String::new()
    };
    format!(r#"{{"number":{},"title":"{}","state":"{}","draft":{}{}}}"#, i.number, i.title, i.state, i.draft, pull)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let log = std::env::var("FAKE_GH_LOG").ok();
    let dir = log.as_ref().and_then(|l| std::path::Path::new(l).parent().map(|p| p.to_path_buf()));
    if let Some(log) = &log {
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(log) {
            let argv: Vec<String> = args.iter().map(|a| format!("{a:?}")).collect();
            let _ = writeln!(file, "ARGV [{}]", argv.join(", "));
        }
    }
    if let Some(dir) = &dir {
        if let Ok(ms) = std::fs::read_to_string(dir.join("delay-ms")) {
            if let Ok(ms) = ms.trim().parse::<u64>() {
                std::thread::sleep(std::time::Duration::from_millis(ms));
            }
        }
        if dir.join("fail").exists() {
            eprintln!("gh: error connecting to api.github.com");
            std::process::exit(1);
        }
    }
    let joined = args.join(" ");
    if joined.starts_with("auth status") {
        println!(r#"{{"hosts":{{"github.com":[{{"state":"success","active":true,"host":"github.com","login":"octotest"}}]}}}}"#);
        return;
    }
    // `gh issue view <n>` feeds the Issue right pane (#1950 pins it); only the fixed issues are served.
    if joined.starts_with("issue view ") {
        let number: u64 = args.get(2).and_then(|n| n.parse().ok()).unwrap_or(0);
        let Some(item) = ITEMS.iter().find(|i| i.number == number && !i.pr) else { std::process::exit(1) };
        println!(
            r#"{{"number":{n},"title":"{t}","state":"{s}","url":"https://github.com/octocat/hello-world/issues/{n}","labels":[],"assignees":[],"author":{{"login":"octotest"}},"body":"Fixture body.","createdAt":"2026-10-01T09:00:00Z","updatedAt":"2026-10-02T09:00:00Z"}}"#,
            n = item.number,
            t = item.title,
            s = item.state.to_uppercase(),
        );
        return;
    }
    if args.first().map(String::as_str) != Some("api") {
        std::process::exit(1);
    }
    if args.iter().any(|a| a == "search/issues") {
        let q = args.iter().find_map(|a| a.strip_prefix("q=")).unwrap_or("").to_lowercase();
        if !q.starts_with("repo:octocat/hello-world ") {
            println!(r#"{{"items":[]}}"#);
            return;
        }
        let rows: Vec<String> = ITEMS
            .iter()
            .filter(|i| match q.split("in:title ").nth(1) {
                Some(term) => i.title.to_lowercase().contains(term.trim()),
                None => i.state == "open",
            })
            .map(search_row)
            .collect();
        println!(r#"{{"items":[{}]}}"#, rows.join(","));
        return;
    }
    // repos/octocat/hello-world/(issues|pulls)/<n>
    let path = args.iter().find(|a| a.starts_with("repos/")).cloned().unwrap_or_default();
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() != 5 || parts[1] != "octocat" || parts[2] != "hello-world" {
        std::process::exit(1);
    }
    let number: u64 = parts[4].parse().unwrap_or(0);
    let Some(item) = ITEMS.iter().find(|i| i.number == number) else { std::process::exit(1) };
    if parts[3] == "pulls" {
        println!(r#"{{"merged":{},"draft":{},"base":{{"ref":"main"}},"head":{{"ref":"feat/hash-picker"}}}}"#, item.merged, item.draft);
    } else {
        let pull = if item.pr { r#","pull_request":{}"# } else { "" };
        println!(
            r#"{{"number":{n},"title":"{t}","state":"{s}","html_url":"https://github.com/octocat/hello-world/{k}/{n}","created_at":"2026-10-01T09:00:00Z","user":{{"login":"octotest"}}{pull}}}"#,
            n = item.number,
            t = item.title,
            s = item.state,
            k = if item.pr { "pull" } else { "issues" },
        );
    }
}
