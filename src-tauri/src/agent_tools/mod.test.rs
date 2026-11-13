use super::*;

#[test]
fn root_sessions_get_the_five_session_tools_and_the_panel_tools() {
    let names = tools_for(ToolAccess::for_depth(1));
    assert_eq!(
        names,
        vec![
            "refract_list_panels",
            "refract_open_panel",
            "refract_invoke_panel_action",
            "refract_list_sessions",
            "refract_get_session_status",
            "refract_send_session_message",
            "refract_create_session",
            "refract_update_session"
        ]
    );
    assert!(names.iter().all(|n| n.starts_with(TOOL_PREFIX)));
}

#[test]
fn every_depth_registers_the_five_session_tools() {
    for depth in [1, 2, 3] {
        let names = tools_for(ToolAccess::for_depth(depth));
        for tool in sessions::SESSION_TOOLS {
            assert!(names.contains(&tool), "depth {depth}: {tool}");
        }
        assert_eq!(host_tool_defs(ToolAccess::for_depth(depth)).len(), 8);
    }
}

#[test]
fn the_session_in_the_registry_decides_the_depth_it_is_launched_with() {
    use crate::store::registry::Session;
    let row = |id: &str, parent: Option<&str>| -> Session {
        serde_json::from_value(json!({
            "id": id, "repositoryId": "r", "name": id, "branch": id, "baseBranch": "main",
            "worktreePath": id, "sessionDir": null, "currentConversation": null,
            "lastMessageCount": null, "createdAt": "t", "lastActivityAt": "t",
            "archivedAt": null, "parentSessionId": parent
        }))
        .unwrap()
    };
    let rows = [row("a", None), row("b", Some("a")), row("c", Some("b"))];
    for (id, depth) in [("a", 1), ("b", 2), ("c", 3)] {
        assert_eq!(
            ToolAccess::for_session(&rows, id),
            ToolAccess::for_depth(depth),
            "{id}"
        );
    }
    assert_eq!(ToolAccess::for_session(&rows, "c").depth, 3);
}

#[test]
fn child_sessions_get_no_tools() {
    let access = ToolAccess {
        role: Role::Child,
        depth: 2,
    };
    assert!(tools_for(access).is_empty());
    assert!(host_tool_defs(access).is_empty());
}

#[test]
fn child_sessions_are_never_offered_the_session_tools() {
    let access = ToolAccess {
        role: Role::Child,
        depth: 2,
    };
    let offered = tools_for(access);
    for tool in sessions::SESSION_TOOLS {
        assert!(!offered.contains(&tool), "{tool}");
    }
    assert!(host_tool_defs(access).is_empty());
}

#[test]
fn definitions_match_the_rpc_host_tool_shape() {
    for def in host_tool_defs(ToolAccess::for_depth(1)) {
        assert_eq!(def["loadMode"], "essential");
        assert!(def["name"].is_string());
        assert!(!def["description"].as_str().unwrap().is_empty());
        assert_eq!(def["parameters"]["type"], "object");
    }
}
