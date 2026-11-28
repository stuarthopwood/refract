use std::collections::{HashMap, HashSet};

use super::*;

#[derive(Default)]
struct FakeEnv {
    vars: HashMap<String, OsString>,
    files: HashSet<PathBuf>,
}

impl FakeEnv {
    fn var(mut self, name: &str, value: &str) -> Self {
        self.vars.insert(name.to_string(), OsString::from(value));
        self
    }

    fn file(mut self, path: &str) -> Self {
        self.files.insert(PathBuf::from(path));
        self
    }
}

impl ShellEnv for FakeEnv {
    fn var(&self, name: &str) -> Option<OsString> {
        self.vars.get(name).cloned()
    }

    fn is_file(&self, path: &Path) -> bool {
        self.files.contains(path)
    }
}

const WINPS: &str = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
const CMD: &str = r"C:\Windows\System32\cmd.exe";

fn base() -> FakeEnv {
    FakeEnv::default()
        .var("SystemRoot", r"C:\Windows")
        .var("COMSPEC", CMD)
}

#[test]
fn pwsh_on_path_wins() {
    let env = base()
        .var("PATH", r"C:\Tools;C:\Program Files\PowerShell\7")
        .file(r"C:\Program Files\PowerShell\7\pwsh.exe")
        .file(WINPS)
        .file(CMD);
    let shell = resolve_shell(&env).unwrap();
    assert_eq!(shell.kind, ShellKind::Pwsh);
    assert_eq!(
        shell.path,
        PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe")
    );
}

#[test]
fn the_first_path_entry_with_pwsh_is_used() {
    let env = base()
        .var("PATH", r"C:\A;C:\B")
        .file(r"C:\A\pwsh.exe")
        .file(r"C:\B\pwsh.exe");
    assert_eq!(
        resolve_shell(&env).unwrap().path,
        PathBuf::from(r"C:\A\pwsh.exe")
    );
}

#[test]
fn windows_powershell_is_next_when_pwsh_is_absent() {
    let env = base().var("PATH", r"C:\Tools").file(WINPS).file(CMD);
    let shell = resolve_shell(&env).unwrap();
    assert_eq!(shell.kind, ShellKind::Powershell);
    assert_eq!(shell.path, PathBuf::from(WINPS));
}

#[test]
fn comspec_is_the_last_resort() {
    let env = base().var("PATH", r"C:\Tools").file(CMD);
    let shell = resolve_shell(&env).unwrap();
    assert_eq!(shell.kind, ShellKind::Cmd);
    assert_eq!(shell.path, PathBuf::from(CMD));
}

#[test]
fn a_missing_comspec_variable_falls_back_to_system32_cmd() {
    let env = FakeEnv::default()
        .var("SystemRoot", r"C:\Windows")
        .file(CMD);
    assert_eq!(resolve_shell(&env).unwrap().kind, ShellKind::Cmd);
}

#[test]
fn nothing_found_is_none() {
    assert_eq!(resolve_shell(&base().var("PATH", r"C:\Tools")), None);
    assert_eq!(resolve_shell(&FakeEnv::default()), None);
}

#[test]
fn relative_and_empty_path_entries_never_supply_pwsh() {
    // `.` and an empty entry mean the current directory; a pwsh.exe planted there must not run.
    let env = base()
        .var("PATH", r".;;tools;..\bin")
        .file(r".\pwsh.exe")
        .file(r"tools\pwsh.exe")
        .file(r"..\bin\pwsh.exe")
        .file("pwsh.exe")
        .file(WINPS);
    assert_eq!(resolve_shell(&env).unwrap().kind, ShellKind::Powershell);
}

#[test]
fn a_relative_system_root_is_not_trusted() {
    let env = FakeEnv::default()
        .var("SystemRoot", "Windows")
        .file(r"Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
    assert_eq!(resolve_shell(&env), None);
}

#[test]
fn a_relative_comspec_is_not_trusted() {
    let env = FakeEnv::default().var("COMSPEC", "cmd.exe").file("cmd.exe");
    assert_eq!(resolve_shell(&env), None);
}

#[test]
fn the_shell_kind_has_a_stable_saved_name() {
    assert_eq!(ShellKind::Pwsh.as_str(), "pwsh");
    assert_eq!(ShellKind::Powershell.as_str(), "powershell");
    assert_eq!(ShellKind::Cmd.as_str(), "cmd");
    assert_eq!(serde_json::to_string(&ShellKind::Pwsh).unwrap(), "\"pwsh\"");
    assert_eq!(
        serde_json::from_str::<ShellKind>("\"cmd\"").unwrap(),
        ShellKind::Cmd
    );
}

#[test]
fn an_unknown_saved_shell_becomes_windows_powershell() {
    assert_eq!(ShellKind::parse_saved("pwsh"), ShellKind::Pwsh);
    assert_eq!(ShellKind::parse_saved("cmd"), ShellKind::Cmd);
    assert_eq!(ShellKind::parse_saved("powershell"), ShellKind::Powershell);
    assert_eq!(ShellKind::parse_saved("bash"), ShellKind::Powershell);
    assert_eq!(ShellKind::parse_saved(""), ShellKind::Powershell);
}

#[test]
fn only_term_and_colorterm_are_added_to_the_environment() {
    assert_eq!(
        ADDED_ENV,
        [("TERM", "xterm-256color"), ("COLORTERM", "truecolor")]
    );
}

#[test]
fn both_powershells_keep_the_profile_and_wrap_the_prompt_once() {
    for kind in [ShellKind::Pwsh, ShellKind::Powershell] {
        let args = shell_args(kind);

        assert_eq!(&args[..3], &["-NoLogo", "-NoExit", "-Command"]);
        assert_eq!(args.len(), 4);
        assert!(!args.contains(&"-NoProfile"));
        assert!(args[3].contains("function global:prompt"));
        assert!(args[3].contains("]133;A"));
        assert!(
            !args[3].contains('"'),
            "no quotes to escape on a command line"
        );
    }
}

#[test]
fn cmd_has_no_prompt_marker_arguments() {
    assert!(shell_args(ShellKind::Cmd).is_empty());
}
