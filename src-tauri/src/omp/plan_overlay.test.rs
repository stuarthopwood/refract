use super::*;

#[test]
fn plan_overlay_denies_every_write_tool_and_asks_for_bash() {
    assert_eq!(
        render(),
        "tools:\n  approval:\n    write: deny\n    edit: deny\n    ast_edit: deny\n    bash: prompt\n"
    );
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
