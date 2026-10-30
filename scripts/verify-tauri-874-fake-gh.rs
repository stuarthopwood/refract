// Fake `gh` for the #874 live check: records every call's argv to FAKE_GH_LOG and serves pull
// requests for two GitHub repositories (octocat/hello-world, octocat/spoon-knife), honouring the
// repeated --repo, --state, --author/--assignee/--involves/--review-requested @me flags and the
// free-text query `gh search prs` receives. It never talks to GitHub.
use std::io::Write;

struct Pr {
    repo: &'static str,
    number: u64,
    title: &'static str,
    open: bool,
    draft: bool,
    checks: &'static str,
    authored: bool,
    assigned: bool,
    review_requested: bool,
}

const PRS: &[Pr] = &[
    Pr { repo: "octocat/hello-world", number: 1, title: "Add passing feature", open: true, draft: false, checks: "passed", authored: true, assigned: true, review_requested: false },
    Pr { repo: "octocat/hello-world", number: 2, title: "Fix failing build", open: true, draft: false, checks: "failed", authored: false, assigned: false, review_requested: true },
    Pr { repo: "octocat/hello-world", number: 3, title: "Old closed change", open: false, draft: false, checks: "passed", authored: true, assigned: false, review_requested: false },
    Pr { repo: "octocat/spoon-knife", number: 4, title: "Spoon polish in progress", open: true, draft: true, checks: "pending", authored: false, assigned: true, review_requested: false },
    Pr { repo: "octocat/spoon-knife", number: 5, title: "Handle tightening", open: true, draft: false, checks: "none", authored: false, assigned: false, review_requested: true },
];

fn rollup(checks: &str) -> &'static str {
    match checks {
        "passed" => r#"[{"status":"COMPLETED","conclusion":"SUCCESS","state":null}]"#,
        "failed" => r#"[{"status":"COMPLETED","conclusion":"FAILURE","state":null}]"#,
        "pending" => r#"[{"status":"IN_PROGRESS","conclusion":null,"state":null}]"#,
        _ => "null",
    }
}

fn author(pr: &Pr) -> &'static str {
    if pr.authored { "octotest" } else { "hubot" }
}

fn search_row(pr: &Pr) -> String {
    format!(
        r#"{{"number":{},"title":"{}","state":"{}","isDraft":{},"author":{{"login":"{}","name":null}},"updatedAt":"2026-10-2{}T10:00:00Z","repository":{{"name":"{}","nameWithOwner":"{}"}}}}"#,
        pr.number,
        pr.title,
        if pr.open { "open" } else { "closed" },
        pr.draft,
        author(pr),
        pr.number % 10,
        pr.repo.split('/').nth(1).unwrap_or(""),
        pr.repo
    )
}

fn view_row(pr: &Pr) -> String {
    format!(
        r#"{{"number":{n},"title":"{t}","state":"{s}","isDraft":{d},"author":{{"login":"{a}","name":null}},"headRefName":"feature-{n}","baseRefName":"main","updatedAt":"2026-10-2{n}T10:00:00Z","statusCheckRollup":{r},"labels":[],"reviewRequests":[],"assignees":[],"commits":[{{"oid":"sha-{n}","messageHeadline":"Commit for #{n}"}}],"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","additions":10,"deletions":2,"changedFiles":1,"files":[{{"path":"file.txt","additions":10,"deletions":2,"changeType":"MODIFIED"}}],"headRefOid":"head-{n}","body":"Description for pull request #{n}.","isCrossRepository":false,"headRepositoryOwner":null,"url":"https://github.com/{repo}/pull/{n}"}}"#,
        n = pr.number,
        t = pr.title,
        s = if pr.open { "OPEN" } else { "CLOSED" },
        d = pr.draft,
        a = author(pr),
        r = rollup(pr.checks),
        repo = pr.repo
    )
}

fn flag_values(args: &[String], name: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (i, arg) in args.iter().enumerate() {
        if arg == "--" {
            break;
        }
        if arg == name {
            if let Some(v) = args.get(i + 1) {
                out.push(v.clone());
            }
        }
    }
    out
}

fn bulk_prs() -> Vec<Pr> {
    (100..400u64)
        .map(|number| Pr {
            repo: "octocat/hello-world",
            number,
            title: Box::leak(format!("Bulk change {number}").into_boxed_str()),
            open: true,
            draft: false,
            checks: "none",
            authored: false,
            assigned: false,
            review_requested: false,
        })
        .collect()
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
    let out = if joined.starts_with("auth status") {
        r#"{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"octotest"}]}}"#.to_string()
    } else if joined.starts_with("api rate_limit") {
        r#"{"resources":{"search":{"limit":30,"remaining":28,"reset":0}}}"#.to_string()
    } else if joined.starts_with("api user") {
        r#"{"login":"octotest"}"#.to_string()
    } else if joined.starts_with("search prs") {
        let repos = flag_values(&args, "--repo");
        let state = flag_values(&args, "--state").pop();
        let want = |f: &str| !flag_values(&args, f).is_empty();
        let limit: usize = flag_values(&args, "--limit").pop().and_then(|l| l.parse().ok()).unwrap_or(30);
        let query = args.iter().position(|a| a == "--").and_then(|i| args.get(i + 1)).map(|q| q.to_lowercase());
        // Paging check: while FAKE_GH_FAIL_FILE exists, any search for more than one page fails.
        if limit > 50 && std::env::var("FAKE_GH_FAIL_FILE").map_or(false, |f| std::path::Path::new(&f).exists()) {
            eprintln!("fake gh: forced failure for limit {limit}");
            std::process::exit(1);
        }
        let bulk = if query.as_deref().map_or(false, |q| q.contains("bulk")) { bulk_prs() } else { Vec::new() };
        let rows: Vec<String> = PRS
            .iter()
            .chain(bulk.iter())
            .filter(|p| repos.iter().any(|r| r.eq_ignore_ascii_case(p.repo)))
            .filter(|p| match state.as_deref() {
                Some("open") => p.open,
                Some("closed") => !p.open,
                _ => true,
            })
            .filter(|p| !want("--author") || p.authored)
            .filter(|p| !want("--assignee") || p.assigned)
            .filter(|p| !want("--review-requested") || p.review_requested)
            .filter(|p| !want("--involves") || p.authored || p.assigned || p.review_requested)
            .filter(|p| query.as_ref().map_or(true, |q| p.title.to_lowercase().contains(q)))
            .take(limit)
            .map(search_row)
            .collect();
        format!("[{}]", rows.join(","))
    } else if joined.starts_with("pr view") {
        let number: u64 = args.get(2).and_then(|n| n.parse().ok()).unwrap_or(0);
        let repo = flag_values(&args, "--repo").pop().unwrap_or_default();
        let bulk = bulk_prs();
        match PRS.iter().chain(bulk.iter()).find(|p| p.number == number && p.repo.eq_ignore_ascii_case(&repo)) {
            Some(pr) => view_row(pr),
            None => std::process::exit(1),
        }
    } else if joined.starts_with("api graphql") {
        r#"{"data":{"repository":{"pullRequest":{"id":"PR_fixture","reviewThreads":{"nodes":[]},"timelineItems":{"nodes":[]}}}}}"#.to_string()
    } else if joined.starts_with("api repos/") && joined.contains("/files") {
        "[]".to_string()
    } else if joined.starts_with("issue list") {
        "[]".to_string()
    } else if joined.starts_with("label list") {
        "[]".to_string()
    } else if joined.starts_with("repo view") {
        r#"{"mergeCommitAllowed":true,"squashMergeAllowed":true,"rebaseMergeAllowed":true}"#.to_string()
    } else {
        eprintln!("fake gh: unhandled command: gh {joined}");
        std::process::exit(1);
    };
    println!("{out}");
}
