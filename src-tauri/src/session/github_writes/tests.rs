// Fixtures for how `gh api` commands read: which are PR or issue writes, and which are reads.

use serde_json::json;

use super::shell_words::split_commands;
use super::{detect, GithubWrite, ToolCallRecord, WriteAction, WriteKind};

fn run(tool: &str, key: &str, text: &str, output: &str) -> Vec<GithubWrite> {
    let args = json!({ key: text });
    detect(&ToolCallRecord {
        tool,
        args: &args,
        output,
        is_error: false,
        at_ms: 7,
    })
}

fn bash(command: &str) -> Vec<GithubWrite> {
    run("bash", "command", command, "")
}

/// The single write a command must produce, as `(owner/repo or None, kind, number)`.
fn only(writes: Vec<GithubWrite>) -> (Option<String>, WriteKind, u64) {
    assert_eq!(writes.len(), 1, "expected exactly one write: {writes:?}");
    let w = &writes[0];
    assert_eq!(w.action, WriteAction::ApiWrite);
    (
        w.repo.as_ref().map(|(o, n)| format!("{o}/{n}")),
        w.kind,
        w.number,
    )
}

fn pr(number: u64) -> (Option<String>, WriteKind, u64) {
    (Some("o/r".to_string()), WriteKind::Pr, number)
}

#[test]
fn tokenizer_keeps_method_flag_and_endpoint_as_words() {
    let commands = split_commands("gh api -X PATCH repos/o/r/pulls/5 -f state=closed");
    assert_eq!(
        commands,
        vec![vec![
            "gh",
            "api",
            "-X",
            "PATCH",
            "repos/o/r/pulls/5",
            "-f",
            "state=closed"
        ]]
    );
}

#[test]
fn tokenizer_keeps_input_dash_and_drops_the_heredoc_body() {
    let commands = split_commands(
        "gh api repos/o/r/pulls/5 --input - <<'EOF'\n{\"state\":\"closed\"}\nEOF\necho done",
    );
    assert_eq!(
        commands,
        vec![
            vec!["gh", "api", "repos/o/r/pulls/5", "--input", "-", "<<"],
            vec!["echo", "done"]
        ]
    );
}

#[test]
fn x_patch_on_a_pull_is_a_write() {
    assert_eq!(
        only(bash("gh api -X PATCH repos/o/r/pulls/5 -f state=closed")),
        pr(5)
    );
}

#[test]
fn method_flag_forms_are_writes() {
    for command in [
        "gh api repos/o/r/pulls/5 --method PATCH",
        "gh api repos/o/r/pulls/5 --method=patch",
        "gh api repos/o/r/pulls/5 -XPATCH",
        "gh api repos/o/r/pulls/5 -X=PATCH",
        "gh api repos/o/r/pulls/5 -X put",
        "gh api -X DELETE /repos/o/r/pulls/5/requested_reviewers",
    ] {
        assert_eq!(only(bash(command)), pr(5), "{command}");
    }
}

#[test]
fn input_forms_are_writes() {
    for command in [
        "gh api repos/o/r/pulls/5 --input body.json",
        "gh api repos/o/r/pulls/5 --input=body.json",
        "gh api repos/o/r/pulls/5 -X PATCH --input -",
        "echo '{\"state\":\"closed\"}' | gh api repos/o/r/pulls/5 --input -",
        "gh api repos/o/r/pulls/5 --input - <<'EOF'\n{\"state\":\"closed\"}\nEOF",
    ] {
        assert_eq!(only(bash(command)), pr(5), "{command}");
    }
}

#[test]
fn fields_without_a_method_default_to_post() {
    for command in [
        "gh api repos/o/r/pulls/5/comments -f body=hi",
        "gh api repos/o/r/pulls/5/comments -F body=@note.md",
        "gh api repos/o/r/pulls/5/comments --field body=hi",
        "gh api repos/o/r/pulls/5/comments --raw-field=body=hi",
        "gh api repos/o/r/pulls/5/comments -fbody=hi",
    ] {
        assert_eq!(only(bash(command)), pr(5), "{command}");
    }
}

#[test]
fn an_explicit_get_stays_a_read_even_with_fields_or_input() {
    for command in [
        "gh api repos/o/r/pulls/5",
        "gh api -X GET repos/o/r/pulls/5 -f per_page=100",
        "gh api --method GET repos/o/r/pulls/5 --input query.json",
        "gh api repos/o/r/pulls/5 --jq .state",
    ] {
        assert!(bash(command).is_empty(), "{command}");
    }
}

#[test]
fn query_string_and_repo_placeholders_resolve() {
    assert_eq!(
        only(bash("gh api -X PATCH 'repos/o/r/pulls/5?draft=true'")),
        pr(5)
    );
    for command in [
        "gh api -X PATCH repos/{owner}/{repo}/pulls/5 -f state=closed",
        "gh api -X PATCH repos/:owner/:repo/pulls/5 -f state=closed",
    ] {
        assert_eq!(only(bash(command)), (None, WriteKind::Pr, 5), "{command}");
    }
}

#[test]
fn issues_and_collection_posts_resolve() {
    assert_eq!(
        only(bash("gh api -X PATCH repos/o/r/issues/9 -f state=closed")),
        (Some("o/r".to_string()), WriteKind::Issue, 9)
    );
    let created = run(
        "bash",
        "command",
        "gh api repos/o/r/pulls -f title=t -f head=h -f base=main",
        "{\"html_url\":\"https://github.com/o/r/pull/12\"}",
    );
    assert_eq!(only(created), pr(12));
}

#[test]
fn eval_string_literals_are_read_too() {
    let code = "await $`gh api -X PATCH repos/o/r/pulls/5 -f state=closed`";
    assert_eq!(only(run("eval", "code", code, "")), pr(5));
}

#[test]
fn non_pr_endpoints_and_failed_calls_are_ignored() {
    assert!(bash("gh api -X POST repos/o/r/git/refs -f ref=x").is_empty());
    assert!(bash("gh api -X PATCH user -f name=x").is_empty());
    let args = json!({ "command": "gh api -X PATCH repos/o/r/pulls/5 -f state=closed" });
    let failed = detect(&ToolCallRecord {
        tool: "bash",
        args: &args,
        output: "",
        is_error: true,
        at_ms: 7,
    });
    assert!(failed.is_empty());
}
