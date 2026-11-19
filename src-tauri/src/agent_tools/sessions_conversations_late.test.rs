// A late handoff failure never brings a deleted Session's agent back (#1861).

use std::sync::Arc;

use super::report_late;
use crate::session::SessionManager;

async fn manager() -> Arc<SessionManager> {
    let dir = crate::test_scratch::path(format!("refract-late-report-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.unwrap();
    let registry = Arc::new(tokio::sync::Mutex::new(
        crate::store::registry::RegistryStore::open(&dir)
            .await
            .unwrap(),
    ));
    let settings = Arc::new(tokio::sync::Mutex::new(
        crate::store::settings::SettingsStore::open(&dir)
            .await
            .unwrap(),
    ));
    let events =
        crate::events::EventSink::new(Arc::new(std::sync::Mutex::new(None)), registry.clone());
    SessionManager::new(registry, settings, events)
}

#[tokio::test]
async fn a_late_failure_for_a_deleted_session_does_not_recreate_its_agent() {
    let manager = manager().await;
    manager.get_or_create_agent("gone");
    manager.remove_agent("gone");

    report_late(&manager, "gone", "omp refused").await;

    assert!(manager.get_agent("gone").is_none());
}
