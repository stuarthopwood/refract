// Fake `gh` for the #503 live check: records every call's argv (and stdin for `--body-file -`)
// to the file named by FAKE_GH_LOG and answers just enough of the GitHub CLI for the Report an
// issue dialog. It never talks to GitHub, so the live check cannot file a real issue.
use std::io::{Read, Write};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut stdin_text = String::new();
    if args.iter().any(|arg| arg == "--body-file") {
        let _ = std::io::stdin().read_to_string(&mut stdin_text);
    }
    if let Ok(log) = std::env::var("FAKE_GH_LOG") {
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(log) {
            let argv: Vec<String> = args.iter().map(|a| format!("{a:?}")).collect();
            let _ = writeln!(file, "ARGV [{}] STDIN {stdin_text:?}", argv.join(", "));
        }
    }
    let joined = args.join(" ");
    let out = if joined.starts_with("auth status") {
        r#"{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"octotest"}]}}"#
    } else if joined.starts_with("label list") {
        r#"[{"name":"bug","color":"d73a4a","description":"Something is broken"},{"name":"enhancement","color":"a2eeef","description":"New feature"},{"name":"docs","color":"0075ca","description":""}]"#
    } else if joined.starts_with("issue list") {
        r#"[{"number":12,"title":"Crash when saving a draft","state":"OPEN","url":"https://github.com/octocat/hello-world/issues/12"},{"number":7,"title":"Saving fails on Windows","state":"CLOSED","url":"https://github.com/octocat/hello-world/issues/7"}]"#
    } else if joined.starts_with("issue create") {
        "https://github.com/octocat/hello-world/issues/99"
    } else {
        std::process::exit(1);
    };
    println!("{out}");
}
