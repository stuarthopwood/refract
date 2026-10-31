// Fake `gh` for the #1315 live check: octocat/hello-world has open PR #7 (checks passing) closing issues
// #11 (open) and #12 (closed); octocat/spoon-knife has no PR. Every call's argv goes to FAKE_GH_LOG. It never talks to GitHub.
use std::io::Write;

fn issue(number: u64) -> (&'static str, &'static str) {
    match number {
        11 => ("First linked issue", "OPEN"),
        _ => ("Second linked issue", "CLOSED"),
    }
}

fn issue_view(args: &[String]) -> String {
    let number: u64 = args.get(2).and_then(|n| n.parse().ok()).unwrap_or(11);
    let (title, state) = issue(number);
    format!(
        r#"{{"number":{number},"title":"{title}","state":"{state}","url":"https://github.com/octocat/hello-world/issues/{number}","labels":[],"assignees":[],"author":{{"login":"octotest"}},"comments":[],"updatedAt":"2026-10-29T10:00:00Z","body":"Body of issue #{number}.","createdAt":"2026-10-29T09:00:00Z"}}"#
    )
}

fn pr_view() -> String {
    r#"{"number":7,"title":"Header badges","state":"OPEN","isDraft":false,"author":{"login":"octotest","name":null},"headRefName":"feature-7","baseRefName":"main","updatedAt":"2026-10-29T10:00:00Z","statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS","state":null}],"labels":[],"reviewRequests":[],"assignees":[],"commits":[{"oid":"sha-7","messageHeadline":"Commit for #7"}],"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","additions":10,"deletions":2,"changedFiles":1,"files":[{"path":"file.txt","additions":10,"deletions":2,"changeType":"MODIFIED"}],"headRefOid":"head-7","body":"Description for pull request #7.","isCrossRepository":false,"headRepositoryOwner":null,"url":"https://github.com/octocat/hello-world/pull/7"}"#.to_string()
}

fn lookup(joined: &str) -> String {
    if joined.contains("name=spoon-knife") {
        return r#"{"data":{"repository":{"pullRequests":{"nodes":[]}}}}"#.to_string();
    }
    r#"{"data":{"repository":{"pullRequests":{"nodes":[{"number":7,"url":"https://github.com/octocat/hello-world/pull/7","state":"OPEN","isDraft":false,"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS"}}}]},"closingIssuesReferences":{"nodes":[{"number":11,"state":"OPEN","title":"First linked issue"},{"number":12,"state":"CLOSED","title":"Second linked issue"}]}}]}}}}"#.to_string()
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
    } else if joined.starts_with("search prs") || joined.starts_with("issue list") || joined.starts_with("label list") {
        "[]".to_string()
    } else if joined.starts_with("pr view") {
        pr_view()
    } else if joined.starts_with("api graphql") && joined.contains("headRefName") {
        lookup(&joined)
    } else if joined.starts_with("api graphql") {
        r#"{"data":{"repository":{"pullRequest":{"id":"PR_fixture","reviewThreads":{"nodes":[]},"timelineItems":{"nodes":[]}}}}}"#.to_string()
    } else if joined.starts_with("api repos/") && joined.contains("/files") {
        "[]".to_string()
    } else if joined.starts_with("issue view") {
        issue_view(&args)
    } else if joined.starts_with("repo view") {
        r#"{"mergeCommitAllowed":true,"squashMergeAllowed":true,"rebaseMergeAllowed":true}"#.to_string()
    } else {
        eprintln!("fake gh: unhandled command: gh {joined}");
        std::process::exit(1);
    };
    println!("{out}");
}
