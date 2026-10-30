// Fake `gh` PATH shim for the #883 updater live check; must be an .exe (`Command` won't run a `.cmd` by bare name).
// Env: REFRACT_883_CALL_LOG (argv log), _FLAG_FILE (newer release listed when it exists), _CURRENT, _NEWER, _ASSET_DIR.

use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

fn var(name: &str) -> String {
    env::var(name).unwrap_or_default()
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if let Ok(mut log) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(var("REFRACT_883_CALL_LOG"))
    {
        let _ = writeln!(log, "{}", args.join(" "));
    }
    let word = |i: usize| args.get(i).map(String::as_str).unwrap_or("");
    match (word(0), word(1)) {
        ("--version", _) => println!("gh version 2.60.0 (verify-883 shim)"),
        ("auth", "status") => {}
        ("release", "list") => {
            let current = var("REFRACT_883_CURRENT");
            let mut items = vec![format!(
                "{{\"tagName\":\"v{current}\",\"isDraft\":false,\"isPrerelease\":false}}"
            )];
            if PathBuf::from(var("REFRACT_883_FLAG_FILE")).exists() {
                let newer = var("REFRACT_883_NEWER");
                items.insert(
                    0,
                    format!("{{\"tagName\":\"v{newer}\",\"isDraft\":false,\"isPrerelease\":false}}"),
                );
            }
            println!("[{}]", items.join(","));
        }
        ("release", "view") => {
            let newer = var("REFRACT_883_NEWER");
            println!(
                "{{\"assets\":[{{\"name\":\"Refract-Setup-{newer}.exe\"}},{{\"name\":\"Refract-Setup-{newer}.exe.sha256\"}}]}}"
            );
        }
        ("release", "download") => {
            let dir = args
                .iter()
                .position(|a| a == "--dir")
                .and_then(|i| args.get(i + 1))
                .cloned()
                .unwrap_or_default();
            if dir.is_empty() {
                eprintln!("verify-883 gh shim: no --dir");
                std::process::exit(1);
            }
            fs::create_dir_all(&dir).expect("create --dir");
            for entry in fs::read_dir(var("REFRACT_883_ASSET_DIR")).expect("asset dir") {
                let path = entry.expect("entry").path();
                fs::copy(&path, PathBuf::from(&dir).join(path.file_name().unwrap())).expect("copy");
            }
        }
        _ => {
            eprintln!("verify-883 gh shim: unsupported: {}", args.join(" "));
            std::process::exit(1);
        }
    }
}
