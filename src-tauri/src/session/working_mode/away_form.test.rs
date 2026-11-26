use serde_json::json;

use super::*;

#[test]
fn an_empty_text_field_gets_the_away_reply_and_a_prefilled_one_keeps_its_value() {
    let data = form_defaults(
        "<form><input name=\"title\"><input type=\"text\" name=\"owner\" value=\"stu\"></form>",
    );
    assert_eq!(data, json!({ "title": ASK_FALLBACK, "owner": "stu" }));
}

#[test]
fn a_textarea_keeps_its_body_or_takes_the_away_reply() {
    let data = form_defaults(
        "<textarea name=\"a\">hello &amp; bye</textarea><textarea name=\"b\"></textarea>",
    );
    assert_eq!(data, json!({ "a": "hello & bye", "b": ASK_FALLBACK }));
}

#[test]
fn a_select_takes_its_marked_option_else_its_first_enabled_one() {
    let data = form_defaults(
        "<select name=\"a\"><option disabled>X</option><option value=\"s\">Small</option></select>\
         <select name=\"b\"><option>One</option><option selected>Two</option></select>",
    );
    assert_eq!(data, json!({ "a": "s", "b": "Two" }));
}

#[test]
fn a_radio_group_takes_the_checked_choice_else_the_first() {
    let data = form_defaults(
        "<input type=\"radio\" name=\"a\" value=\"x\"><input type=\"radio\" name=\"a\" value=\"y\">\
         <input type=\"radio\" name=\"b\" value=\"p\"><input type=\"radio\" name=\"b\" value=\"q\" checked>",
    );
    assert_eq!(data, json!({ "a": "x", "b": "q" }));
}

#[test]
fn checkboxes_stay_unticked_unless_the_form_ticked_them() {
    let data = form_defaults(
        "<input type=\"checkbox\" name=\"agree\" value=\"yes\">\
         <input type=\"checkbox\" name=\"tags\" value=\"a\" checked>\
         <input type=\"checkbox\" name=\"tags\" value=\"b\" checked>\
         <input type=\"checkbox\" name=\"tags\" value=\"c\">",
    );
    assert_eq!(data, json!({ "tags": ["a", "b"] }));
}

#[test]
fn a_number_field_takes_its_value_else_its_minimum_else_zero() {
    let data = form_defaults(
        "<input type=\"number\" name=\"a\" value=\"7\"><input type=\"number\" name=\"b\" min=\"3\">\
         <input type=\"number\" name=\"c\">",
    );
    assert_eq!(data, json!({ "a": 7, "b": 3, "c": 0 }));
}

#[test]
fn email_and_url_fields_are_left_out_when_empty() {
    let data = form_defaults(
        "<input type=\"email\" name=\"mail\"><input type=\"url\" name=\"site\" value=\"https://x.test\">",
    );
    assert_eq!(data, json!({ "site": "https://x.test" }));
}

#[test]
fn controls_without_a_name_and_buttons_are_left_out() {
    let data = form_defaults(
        "<input><input type=\"hidden\" name=\"h\" value=\"1\"><input type=\"submit\" name=\"go\">\
         <select><option>A</option></select><p>text</p>",
    );
    assert_eq!(data, json!({}));
}

#[test]
fn a_quoted_angle_bracket_and_a_comment_do_not_break_the_scan() {
    let data = form_defaults(
        "<!-- <input name=\"ghost\"> --><input name=\"a\" value=\"1 > 0\"><input name=\"b\">",
    );
    assert_eq!(data, json!({ "a": "1 > 0", "b": ASK_FALLBACK }));
}

#[test]
fn malformed_html_still_yields_an_object() {
    assert_eq!(form_defaults(""), json!({}));
    assert_eq!(
        form_defaults("<input name=\"a\" value=\"oops"),
        json!({ "a": "oops" })
    );
}

#[test]
fn a_form_with_more_than_the_field_cap_is_truncated_to_the_cap() {
    let html: String = (0..MAX_FIELDS + 20)
        .map(|i| format!("<input name=\"f{i}\">"))
        .collect();
    let data = form_defaults(&html);
    assert_eq!(data.as_object().unwrap().len(), MAX_FIELDS);
}
