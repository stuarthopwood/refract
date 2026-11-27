// IPC handler for `settings.setSessionListCollapse`. Own file to respect the 600-line cap (#1862).
use serde_json::Value;

use super::{invalid_argument, AppState, Dispatcher, HandlerFuture};
use crate::store::settings::SessionListCollapse;

pub fn register(d: &mut Dispatcher) {
    d.register(
        "settings.setSessionListCollapse",
        settings_set_session_list_collapse,
    );
}

/// `settings.setSessionListCollapse` (#735): `{ collapsedRepositoryIds, archivedOpen,
/// collapsedParentIds }`. Ids are de-duplicated silently; an over-cap count or id length is
/// `invalid-argument`.
const SESSION_LIST_COLLAPSE_SHAPE_MESSAGE: &str =
    "settings.setSessionListCollapse expects { collapsedRepositoryIds: string[], archivedOpen: boolean, collapsedParentIds: string[] }";

fn parse_session_list_collapse_arg(value: &Value) -> Result<SessionListCollapse, super::IpcError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid_argument(SESSION_LIST_COLLAPSE_SHAPE_MESSAGE))?;
    let id_list = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_array)
            .and_then(|ids| crate::store::settings::sanitize_collapsed_ids(ids))
            .ok_or_else(|| invalid_argument(SESSION_LIST_COLLAPSE_SHAPE_MESSAGE))
    };
    let collapsed_repository_ids = id_list("collapsedRepositoryIds")?;
    let collapsed_parent_ids = id_list("collapsedParentIds")?;
    // Optional so an older renderer build keeps working; a present but malformed list is rejected.
    let expanded_conversation_session_ids = match object.get("expandedConversationSessionIds") {
        None => Vec::new(),
        Some(ids) => ids
            .as_array()
            .and_then(|ids| crate::store::settings::sanitize_collapsed_ids(ids))
            .ok_or_else(|| invalid_argument(SESSION_LIST_COLLAPSE_SHAPE_MESSAGE))?,
    };
    let archived_open = object
        .get("archivedOpen")
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid_argument(SESSION_LIST_COLLAPSE_SHAPE_MESSAGE))?;
    let show_hidden = object
        .get("showHidden")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(SessionListCollapse {
        collapsed_repository_ids,
        archived_open,
        show_hidden,
        collapsed_parent_ids,
        expanded_conversation_session_ids,
    })
}

pub fn settings_set_session_list_collapse(state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let value = parse_session_list_collapse_arg(args.first().unwrap_or(&Value::Null))?;
        let value = state
            .settings
            .lock()
            .await
            .set_session_list_collapse(value)
            .await
            .map_err(|err| super::IpcError::new("git-failed", err.to_string()))?;
        let value_json = serde_json::to_value(value).expect("Settings is always JSON-serialisable");
        state.session_manager.emit_settings_changed(&value_json);
        Ok(value_json)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn collapse_arg_requires_collapsed_parent_ids() {
        let missing = json!({ "collapsedRepositoryIds": [], "archivedOpen": false });
        let err = parse_session_list_collapse_arg(&missing).unwrap_err();
        assert_eq!(err.message, SESSION_LIST_COLLAPSE_SHAPE_MESSAGE);
        assert!(err.message.contains("collapsedParentIds"));
    }

    #[test]
    fn collapse_arg_rejects_malformed_or_over_cap_parent_ids() {
        let too_many: Vec<String> = (0..=1000).map(|n| format!("p{n}")).collect();
        for bad in [json!("p"), json!([1]), json!(too_many)] {
            let arg = json!({
                "collapsedRepositoryIds": [], "archivedOpen": false, "collapsedParentIds": bad
            });
            assert!(parse_session_list_collapse_arg(&arg).is_err());
        }
    }

    #[test]
    fn collapse_arg_de_duplicates_and_keeps_every_field() {
        let arg = json!({
            "collapsedRepositoryIds": ["r"], "archivedOpen": true, "showHidden": true,
            "collapsedParentIds": ["a", "a", "b"]
        });
        let parsed = parse_session_list_collapse_arg(&arg).unwrap();
        assert_eq!(
            parsed.collapsed_parent_ids,
            ["a".to_string(), "b".to_string()]
        );
        assert_eq!(parsed.collapsed_repository_ids, ["r".to_string()]);
        assert!(parsed.archived_open && parsed.show_hidden);
    }

    #[test]
    fn collapse_arg_expanded_conversation_ids_are_optional_but_not_malformed() {
        let base = json!({
            "collapsedRepositoryIds": [], "archivedOpen": false, "collapsedParentIds": []
        });
        let absent = parse_session_list_collapse_arg(&base).unwrap();
        assert!(absent.expanded_conversation_session_ids.is_empty());
        let arg = json!({
            "collapsedRepositoryIds": [], "archivedOpen": false, "collapsedParentIds": [],
            "expandedConversationSessionIds": ["a", "a", "b"]
        });
        let parsed = parse_session_list_collapse_arg(&arg).unwrap();
        assert_eq!(
            parsed.expanded_conversation_session_ids,
            ["a".to_string(), "b".to_string()]
        );
        let bad = json!({
            "collapsedRepositoryIds": [], "archivedOpen": false, "collapsedParentIds": [],
            "expandedConversationSessionIds": "a"
        });
        assert!(parse_session_list_collapse_arg(&bad).is_err());
    }
}
