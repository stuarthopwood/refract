use super::*;

#[test]
fn root_sessions_get_the_three_prefixed_tools() {
    let names = tools_for(ToolAccess::root());
    assert_eq!(
        names,
        vec![
            "refract_list_panels",
            "refract_open_panel",
            "refract_invoke_panel_action",
            "refract_list_sessions",
            "refract_get_session_status",
            "refract_send_session_message"
        ]
    );
    assert!(names.iter().all(|n| n.starts_with(TOOL_PREFIX)));
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
    for def in host_tool_defs(ToolAccess::root()) {
        assert_eq!(def["loadMode"], "essential");
        assert!(def["name"].is_string());
        assert!(!def["description"].as_str().unwrap().is_empty());
        assert_eq!(def["parameters"]["type"], "object");
    }
}
