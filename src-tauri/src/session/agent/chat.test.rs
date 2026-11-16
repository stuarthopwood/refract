use super::*;

#[test]
fn a_paused_target_holds_whatever_its_response_says() {
    assert_eq!(
        delivery_of(true, &json!({ "queued": true })),
        MessageDelivery::Held
    );
    assert_eq!(delivery_of(true, &Value::Null), MessageDelivery::Held);
}

#[test]
fn a_working_target_queues_the_message() {
    assert_eq!(
        delivery_of(false, &json!({ "queued": true })),
        MessageDelivery::Queued
    );
}

#[test]
fn an_idle_target_takes_the_message_at_once() {
    assert_eq!(
        delivery_of(false, &json!({ "queued": false })),
        MessageDelivery::Sent
    );
    assert_eq!(delivery_of(false, &json!({})), MessageDelivery::Sent);
}

#[test]
fn only_an_idle_non_drain_prompt_that_asks_for_it_is_decorated() {
    assert!(should_decorate(false, false, true));
    assert!(!should_decorate(true, false, true));
    assert!(!should_decorate(false, true, true));
}

#[test]
fn session_messages_are_never_decorated() {
    assert!(!should_decorate(false, false, false));
}
