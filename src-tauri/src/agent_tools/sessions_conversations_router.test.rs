use super::*;
use crate::agent_tools::router::{plan, tests::agent_of_a_dropped_manager, Plan, CANCELLED};
use crate::agent_tools::router_native::run_native;

fn valid_args(tool: ConvTool) -> Value {
    match tool {
        ConvTool::List => json!({}),
        ConvTool::New => json!({ "prompt": "go" }),
        ConvTool::Switch => json!({ "session_id": "s1", "conversation_id": "c1" }),
    }
}

#[test]
fn conversation_tools_plan_as_native() {
    for tool in ConvTool::ALL {
        let args = valid_args(tool);
        let planned = plan(tool.name(), &args).unwrap();
        assert_eq!(
            planned,
            Plan::Native {
                tool: tool.name().to_string(),
                args: args.clone()
            },
            "{}",
            tool.name()
        );
    }
}

/// A caller whose app has gone reads as `cancelled`, which only the conversation handler returns
/// here: an unrouted tool would be `unknown_tool` and the send handler `invalid_input`.
#[tokio::test]
async fn conversation_tools_are_dispatched_to_their_own_handler() {
    let agent = agent_of_a_dropped_manager().await;
    for tool in ConvTool::ALL {
        let err = run_native(&agent, "call-1", tool.name(), &valid_args(tool))
            .await
            .unwrap_err();
        assert_eq!(err.code, CANCELLED, "{}", tool.name());
    }
}
