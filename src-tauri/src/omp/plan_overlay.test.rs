use super::*;

#[test]
fn plan_overlay_denies_every_write_tool_and_asks_for_every_exec_or_write_tool() {
    let denied = ["write", "edit", "ast_edit"];
    let asked = [
        "bash",
        "eval",
        "ssh",
        "browser",
        "computer",
        "task",
        "github",
        "debug",
        "lsp",
        "hub",
        "security_scan",
        "security_publish",
        "manage_skill",
        "learn",
        "context_notes",
        "new_context",
        "generate_image",
        "tts",
        "vibe_spawn",
        "vibe_send",
    ];
    let expected: String = std::iter::once("tools:\n  approval:\n".to_string())
        .chain(denied.iter().map(|t| format!("    {t}: deny\n")))
        .chain(asked.iter().map(|t| format!("    {t}: prompt\n")))
        .collect();
    assert_eq!(render(), expected);
}

#[tokio::test]
async fn writes_the_overlay_file_and_returns_its_path() {
    let dir = std::env::temp_dir().join(format!("refract-plan-overlay-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = write(&dir).await.unwrap();
    assert_eq!(file, path(&dir));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), render());
    let _ = std::fs::remove_dir_all(&dir);
}
