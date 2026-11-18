use super::*;
use crate::agent_tools::panels;

#[test]
fn every_tool_has_a_description_and_a_closed_object_schema() {
    for tool in ConvTool::ALL {
        assert!(tool.name().starts_with("refract_"), "{}", tool.name());
        assert!(!description(tool).is_empty(), "{}", tool.name());
        let schema = parameters(tool);
        assert_eq!(schema["type"], "object", "{}", tool.name());
        assert_eq!(schema["additionalProperties"], false, "{}", tool.name());
    }
}

#[test]
fn required_arguments_follow_the_contract() {
    assert!(parameters(ConvTool::List).get("required").is_none());
    assert_eq!(parameters(ConvTool::New)["required"], json!(["prompt"]));
    assert_eq!(
        parameters(ConvTool::Switch)["required"],
        json!(["session_id", "conversation_id"])
    );
}

#[test]
fn the_schema_refuses_unknown_keys_and_wrong_types() {
    let list = parameters(ConvTool::List);
    assert!(panels::validate(&list, &json!({ "limit": 5 }), "arguments").is_ok());
    assert!(panels::validate(&list, &json!({ "limit": "5" }), "arguments").is_err());
    assert!(panels::validate(&list, &json!({ "limit": 0 }), "arguments").is_err());
    assert!(panels::validate(&list, &json!({ "extra": 1 }), "arguments").is_err());
    let new = parameters(ConvTool::New);
    assert!(panels::validate(&new, &json!({}), "arguments").is_err());
    assert!(panels::validate(&new, &json!({ "prompt": "hi" }), "arguments").is_ok());
}

#[test]
fn names_map_back_to_their_tool() {
    for tool in ConvTool::ALL {
        assert_eq!(conv_tool(tool.name()), Some(tool));
    }
    assert_eq!(conv_tool("refract_update_session"), None);
}
