use std::path::Path;

use super::*;

fn synthesis(goal: &str) -> Synthesis {
    Synthesis {
        overall_goal: Some(goal.to_string()),
        roles: vec![Some("Builder".to_string()), None],
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
