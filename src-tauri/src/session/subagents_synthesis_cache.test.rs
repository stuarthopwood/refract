use std::path::Path;

use super::*;

fn synthesis(goal: &str) -> Synthesis {
    Synthesis {
        overall_goal: Some(goal.to_string()),
        roles: vec![Some("Builder".to_string()), None],
    }
}

/// Insert then write, the two steps the hook splits around the cache lock.
trait InsertAndPersist {
    fn insert_and_persist(&mut self, id: &str, synthesis: Synthesis) -> io::Result<()>;
}

impl InsertAndPersist for SynthesisCache {
    fn insert_and_persist(&mut self, id: &str, synthesis: Synthesis) -> io::Result<()> {
        self.insert(id, synthesis)?.write()
    }
}

fn tmp_files(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect()
}

#[test]
fn a_session_with_no_cache_file_is_a_miss() {
    let dir = tempfile::tempdir().unwrap();
    let cache = SynthesisCache::load(&dir.path().join("absent"));
    assert_eq!(cache.get("t1"), None);
}

#[test]
fn an_inserted_entry_survives_a_reload() {
    let dir = tempfile::tempdir().unwrap();
    let mut cache = SynthesisCache::load(dir.path());
    cache
        .insert_and_persist("t1", synthesis("Ship it"))
        .unwrap();
    assert_eq!(cache.get("t1"), Some(&synthesis("Ship it")));
    let reloaded = SynthesisCache::load(dir.path());
    assert_eq!(reloaded.get("t1"), Some(&synthesis("Ship it")));
    assert_eq!(reloaded.get("t2"), None);
}

#[test]
fn a_second_insert_keeps_the_first_entry() {
    let dir = tempfile::tempdir().unwrap();
    let mut cache = SynthesisCache::load(dir.path());
    cache.insert_and_persist("t1", synthesis("One")).unwrap();
    cache.insert_and_persist("t2", synthesis("Two")).unwrap();
    let reloaded = SynthesisCache::load(dir.path());
    assert_eq!(reloaded.get("t1"), Some(&synthesis("One")));
    assert_eq!(reloaded.get("t2"), Some(&synthesis("Two")));
}

#[test]
fn the_file_is_a_camel_case_map_keyed_by_tool_call_id_and_leaves_no_temp_file() {
    let dir = tempfile::tempdir().unwrap();
    let mut cache = SynthesisCache::load(dir.path());
    cache
        .insert_and_persist("t1", synthesis("Ship it"))
        .unwrap();
    let raw = std::fs::read(dir.path().join("subagent-synthesis.json")).unwrap();
    let value: Value = serde_json::from_slice(&raw).unwrap();
    assert_eq!(value["t1"]["overallGoal"], "Ship it");
    assert_eq!(value["t1"]["roles"][0], "Builder");
    assert!(value["t1"]["roles"][1].is_null());
    assert!(tmp_files(dir.path()).is_empty());
}

#[test]
fn a_corrupt_file_is_a_miss_and_the_next_insert_replaces_it() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("subagent-synthesis.json"), "{ torn").unwrap();
    let mut cache = SynthesisCache::load(dir.path());
    assert_eq!(cache.get("t1"), None);
    cache
        .insert_and_persist("t1", synthesis("Ship it"))
        .unwrap();
    assert_eq!(
        SynthesisCache::load(dir.path()).get("t1"),
        Some(&synthesis("Ship it"))
    );
}

#[test]
fn one_corrupt_entry_drops_only_itself() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("subagent-synthesis.json"),
        r#"{"good": {"overallGoal": "Fine", "roles": ["A"]}, "bad": {"roles": "nope"}}"#,
    )
    .unwrap();
    let cache = SynthesisCache::load(dir.path());
    assert_eq!(cache.get("bad"), None);
    assert_eq!(
        cache.get("good").unwrap().overall_goal.as_deref(),
        Some("Fine")
    );
}

#[test]
fn a_failed_write_reports_the_error_and_keeps_the_entry_in_memory() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("blocker");
    std::fs::write(&blocker, "a file, not a folder").unwrap();
    let mut cache = SynthesisCache::load(&blocker.join("session"));
    let result = cache.insert_and_persist("t1", synthesis("Ship it"));
    assert!(result.is_err());
    assert_eq!(cache.get("t1"), Some(&synthesis("Ship it")));
}

#[test]
fn the_session_folder_is_under_the_data_dir_and_refuses_an_id_that_is_not_plain() {
    let data = Path::new("data");
    assert_eq!(
        session_cache_dir(data, "s-1_a"),
        Some(data.join("sessions").join("s-1_a"))
    );
    for evil in ["../escape", "a/b", "a\\b", "", "..", "x.y"] {
        assert_eq!(session_cache_dir(data, evil), None, "{evil}");
    }
}

#[test]
fn the_cache_labels_a_card_by_spec_index_and_a_miss_is_unlabelled() {
    let dir = tempfile::tempdir().unwrap();
    let mut cache = SynthesisCache::load(dir.path());
    cache
        .insert_and_persist("t1", synthesis("Ship it"))
        .unwrap();
    let reloaded = SynthesisCache::load(dir.path());

    let first = reloaded.labels("t1", 0);
    assert_eq!(first.role.as_deref(), Some("Builder"));
    assert_eq!(first.overall_goal.as_deref(), Some("Ship it"));
    let second = reloaded.labels("t1", 1);
    assert_eq!(second.role, None);
    assert_eq!(second.overall_goal.as_deref(), Some("Ship it"));
    assert_eq!(reloaded.labels("t1", 9).role, None);
    assert_eq!(reloaded.labels("t2", 0), SubagentLabels::default());
}

#[test]
fn an_older_snapshot_written_late_never_replaces_a_newer_file() {
    let dir = tempfile::tempdir().unwrap();
    let mut cache = SynthesisCache::load(dir.path());
    let first = cache.insert("t1", synthesis("One")).unwrap();
    let second = cache.insert("t2", synthesis("Two")).unwrap();
    second.write().unwrap();
    first.write().unwrap();
    let reloaded = SynthesisCache::load(dir.path());
    assert_eq!(reloaded.get("t1"), Some(&synthesis("One")));
    assert_eq!(reloaded.get("t2"), Some(&synthesis("Two")));
}

#[test]
fn a_discarded_cache_never_recreates_the_session_folder() {
    let dir = tempfile::tempdir().unwrap();
    let session = dir.path().join("gone");
    let mut cache = SynthesisCache::load(&session);
    let pending = cache.insert("t1", synthesis("One")).unwrap();
    cache.discarder().discard();
    pending.write().unwrap();
    assert!(!session.exists());
}

#[test]
fn labels_read_from_disk_are_cut_to_the_same_caps_as_a_model_reply() {
    let dir = tempfile::tempdir().unwrap();
    let long = "x".repeat(5_000);
    let file = serde_json::json!({ "t1": { "overallGoal": long, "roles": [long, "  "] } });
    std::fs::write(dir.path().join("subagent-synthesis.json"), file.to_string()).unwrap();
    let loaded = SynthesisCache::load(dir.path());
    let entry = loaded.get("t1").unwrap();
    assert!(entry.overall_goal.as_deref().unwrap().chars().count() <= 120);
    assert!(entry.roles[0].as_deref().unwrap().chars().count() <= 40);
    assert_eq!(entry.roles[1], None);
}

#[test]
fn an_oversized_file_is_treated_as_empty() {
    let dir = tempfile::tempdir().unwrap();
    let padding = " ".repeat(1_048_577);
    let file = format!(r#"{{"t1": {{"overallGoal": "Fine", "roles": []}}{padding}}}"#);
    std::fs::write(dir.path().join("subagent-synthesis.json"), file).unwrap();
    assert_eq!(SynthesisCache::load(dir.path()).get("t1"), None);
}

#[test]
fn loading_sweeps_leftover_temp_files() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("subagent-synthesis.json.1.2.tmp"), "torn").unwrap();
    let _ = SynthesisCache::load(dir.path());
    assert!(tmp_files(dir.path()).is_empty());
}

#[tokio::test]
async fn removing_a_session_cache_deletes_its_files_and_empty_folder_only() {
    let data = tempfile::tempdir().unwrap();
    let dir = session_cache_dir(data.path(), "s1").unwrap();
    let mut cache = SynthesisCache::load(&dir);
    cache.insert_and_persist("t1", synthesis("One")).unwrap();
    std::fs::write(dir.join("subagent-synthesis.json.1.2.tmp"), "torn").unwrap();

    remove_session_cache(data.path(), "s1").await;

    assert!(!dir.exists());
}

#[tokio::test]
async fn removing_a_session_cache_keeps_the_folder_and_any_unrelated_file_in_it() {
    let data = tempfile::tempdir().unwrap();
    let dir = session_cache_dir(data.path(), "s1").unwrap();
    let mut cache = SynthesisCache::load(&dir);
    cache.insert_and_persist("t1", synthesis("One")).unwrap();
    std::fs::write(dir.join("subagent-synthesis.json.1.2.tmp"), "torn").unwrap();
    std::fs::write(dir.join("notes.txt"), "mine").unwrap();

    remove_session_cache(data.path(), "s1").await;

    assert!(!dir.join(CACHE_FILE).exists());
    assert!(tmp_files(&dir).is_empty());
    assert_eq!(
        std::fs::read_to_string(dir.join("notes.txt")).unwrap(),
        "mine"
    );
}

#[tokio::test]
async fn a_traversing_session_id_removes_nothing_outside_the_sessions_folder() {
    let data = tempfile::tempdir().unwrap();
    // `data/sessions/../s2` is `data/s2`: where a traversing id would reach.
    let outside = data.path().join("s2");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("sentinel"), "keep").unwrap();
    std::fs::write(outside.join(CACHE_FILE), "{}").unwrap();
    std::fs::create_dir_all(data.path().join("sessions")).unwrap();

    remove_session_cache(data.path(), "../s2").await;

    assert_eq!(
        std::fs::read_to_string(outside.join("sentinel")).unwrap(),
        "keep"
    );
    assert!(outside.join(CACHE_FILE).exists());
}
