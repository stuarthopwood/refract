use super::*;

#[test]
fn every_end_tool_has_a_description_and_a_closed_object_schema() {
    for tool in EndTool::ALL {
        assert!(tool.name().starts_with("refract_"), "{}", tool.name());
        assert!(!description(tool).is_empty(), "{}", tool.name());
        let schema = parameters(tool);
        assert_eq!(schema["type"], "object", "{}", tool.name());
        assert_eq!(schema["additionalProperties"], false, "{}", tool.name());
        assert_eq!(schema["required"], json!(["id"]), "{}", tool.name());
    }
}

#[test]
fn only_archive_takes_include_children() {
    for tool in EndTool::ALL {
        let has = parameters(tool)["properties"]
            .get("include_children")
            .is_some();
        assert_eq!(has, tool == EndTool::Archive, "{}", tool.name());
    }
}

#[test]
fn delete_says_it_always_asks() {
    assert!(description(EndTool::Delete).contains("always asked"));
}

#[test]
fn names_map_back_to_their_tool() {
    for tool in EndTool::ALL {
        assert_eq!(end_tool(tool.name()), Some(tool));
    }
    assert_eq!(end_tool("refract_update_session"), None);
}
