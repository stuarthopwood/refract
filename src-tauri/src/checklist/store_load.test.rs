use super::*;

const FIXTURE: &str = include_str!("fixtures/checklist-v1.json");

fn names(dir: &Path) -> Vec<String> {
    let mut found: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    found.sort();
    found
}

#[tokio::test]
async fn missing_file_is_empty() {
    let dir = tempfile::tempdir().unwrap();
    let loaded = load(&dir.path().join("s1.json")).await.unwrap();
    assert_eq!(loaded, ChecklistFile::empty());
    assert!(names(dir.path()).is_empty());
}

#[tokio::test]
async fn corrupt_file_quarantined_session_works() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("s1.json");
    std::fs::write(&file, b"{ not json").unwrap();

    let loaded = load(&file).await.unwrap();

    assert_eq!(loaded, ChecklistFile::empty());
    assert!(!file.exists());
    let left = names(dir.path());
    assert_eq!(left.len(), 1);
    assert!(left[0].starts_with("s1.json.corrupt-"));
}

#[tokio::test]
async fn only_newest_three_corrupt_kept() {
    let dir = tempfile::tempdir().unwrap();
    for millis in 1..=5 {
        std::fs::write(dir.path().join(format!("s1.json.corrupt-{millis}")), b"x").unwrap();
    }
    // Another Session's quarantine files are never pruned by this one.
    std::fs::write(dir.path().join("s2.json.corrupt-1"), b"x").unwrap();
    let file = dir.path().join("s1.json");
    std::fs::write(&file, b"garbage").unwrap();

    load(&file).await.unwrap();

    let left = names(dir.path());
    assert!(left.contains(&"s2.json.corrupt-1".to_string()));
    assert!(left.contains(&"s1.json.corrupt-5".to_string()));
    assert!(left.contains(&"s1.json.corrupt-4".to_string()));
    assert!(!left.contains(&"s1.json.corrupt-3".to_string()));
    assert_eq!(
        left.iter()
            .filter(|n| n.starts_with("s1.json.corrupt-"))
            .count(),
        3
    );
}

#[tokio::test]
async fn leftover_tmp_deleted() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("s1.json.42.0.tmp"), b"half").unwrap();
    std::fs::write(dir.path().join("s2.json.42.0.tmp"), b"other").unwrap();

    load(&dir.path().join("s1.json")).await.unwrap();

    assert_eq!(names(dir.path()), ["s2.json.42.0.tmp"]);
}

#[tokio::test]
async fn version_two_refused_file_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("s1.json");
    let newer = br#"{"version": 2, "somethingNew": true}"#;
    std::fs::write(&file, newer).unwrap();

    let result = load(&file).await;

    assert!(matches!(result, Err(LoadError::Unsupported)));
    assert_eq!(std::fs::read(&file).unwrap(), newer);
    assert_eq!(names(dir.path()), ["s1.json"]);
}

#[tokio::test]
async fn missing_version_quarantined() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("s1.json");
    std::fs::write(&file, br#"{"active": null}"#).unwrap();

    let loaded = load(&file).await.unwrap();

    assert_eq!(loaded, ChecklistFile::empty());
    assert!(!file.exists());
}

#[tokio::test]
async fn valid_file_equals_saved() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("s1.json");
    let saved: ChecklistFile = serde_json::from_str(FIXTURE).unwrap();
    std::fs::write(&file, serde_json::to_vec_pretty(&saved).unwrap()).unwrap();

    assert_eq!(load(&file).await.unwrap(), saved);
    assert_eq!(names(dir.path()), ["s1.json"]);
}
