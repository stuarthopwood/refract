// Runs against scratch folders from `test_scratch`, left in place like the other usage test modules.

use serde_json::json;

use super::*;
use crate::usage::schema;

fn scratch(label: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = crate::test_scratch::path(format!(
        "refract-copilot-{label}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(dir.join("sessions").join("s1")).unwrap();
    dir
}

fn events(cwd: &str) -> String {
    let start = json!({"type":"session.start","timestamp":"2026-10-01T10:00:00.000Z",
        "data":{"sessionId":"s1","context":{"cwd":cwd}}});
    let shutdown = json!({"type":"session.shutdown","timestamp":"2026-10-01T10:05:00.000Z",
        "data":{"totalNanoAiu":2.0e9,"currentModel":"gpt-5",
                "modelMetrics":{"gpt-5":{"totalNanoAiu":2.0e9}}}});
    format!("{start}\n{shutdown}\n")
}

#[test]
fn a_session_in_a_project_cwd_is_stamped_with_the_registry_id_and_its_name_recorded() {
    let dir = scratch("stamp");
    let root = dir.join("sessions");
    let file = root.join("s1").join(EVENTS_FILE);
    std::fs::write(&file, events("C:\\Work\\proj\\src")).unwrap();
    let mut conn = schema::open_db(&dir.join("usage.db")).unwrap();
    let projects = ProjectIndex::from_triples([(
        "C:\\Work\\proj".to_string(),
        "repo-7".to_string(),
        "Proj Name".to_string(),
    )]);

    let written = ingest_events_file(&mut conn, &file, &root, &projects).unwrap();

    assert_eq!(written, 1);
    for table in ["messages", "message_rollup", "file_offsets"] {
        let id: String = conn
            .query_row(&format!("SELECT project_id FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(id, "repo-7", "{table}");
    }
    let name: String = conn
        .query_row(
            "SELECT name FROM projects WHERE project_id = 'repo-7'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(name, "Proj Name");
}
