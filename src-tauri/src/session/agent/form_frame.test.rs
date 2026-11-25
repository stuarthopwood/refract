use serde_json::json;

use super::validate_form_data;

#[test]
fn strings_numbers_and_string_arrays_are_valid_form_data() {
    let data = json!({ "name": "Ada", "age": 36, "ratio": 0.5, "tags": ["a", "b"], "none": [] });
    assert!(validate_form_data(&data).is_ok());
    assert!(validate_form_data(&json!({})).is_ok());
}

#[test]
fn other_value_types_are_refused_by_field_name() {
    for bad in [
        json!(true),
        json!(null),
        json!({ "nested": "x" }),
        json!([1, 2]),
        json!(["a", 1]),
    ] {
        let err = validate_form_data(&json!({ "field": bad })).unwrap_err();
        assert!(err.contains("field"), "{err}");
    }
}

#[test]
fn form_data_must_be_an_object() {
    for bad in [json!("x"), json!(3), json!(["a"]), json!(null)] {
        assert!(validate_form_data(&bad).is_err(), "{bad}");
    }
}

fn at_and_over(over: serde_json::Value, at: serde_json::Value) {
    assert!(validate_form_data(&at).is_ok(), "at the cap: {at}");
    assert!(validate_form_data(&over).is_err(), "over the cap");
}

#[test]
fn the_key_count_is_capped_at_100() {
    let keys = |n: usize| {
        json!((0..n)
            .map(|i| (format!("k{i}"), json!("v")))
            .collect::<serde_json::Map<_, _>>())
    };
    at_and_over(keys(101), keys(100));
}

#[test]
fn a_string_is_capped_at_64_kib() {
    let text = |n: usize| json!({ "field": "a".repeat(n) });
    at_and_over(text(64 * 1024 + 1), text(64 * 1024));
}

#[test]
fn an_array_is_capped_at_200_items() {
    let items = |n: usize| json!({ "field": vec!["a"; n] });
    at_and_over(items(201), items(200));
}

#[test]
fn an_array_item_is_capped_at_64_kib() {
    let item = |n: usize| json!({ "field": ["a", "b".repeat(n)] });
    at_and_over(item(64 * 1024 + 1), item(64 * 1024));
}

#[test]
fn an_over_cap_form_answer_is_refused_as_an_error_naming_the_form_request() {
    let answer = json!({ "data": { "field": "a".repeat(64 * 1024 + 1) } });
    let err = super::build_form_response("f1", &answer).unwrap_err();
    assert!(err.contains("field") && err.contains("f1"), "{err}");
}
