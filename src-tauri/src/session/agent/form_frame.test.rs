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
