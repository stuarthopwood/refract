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
fn a_pre_checked_checkbox_stays_unticked_unless_the_form_requires_it() {
    let data = form_defaults(
        "<input type=\"checkbox\" name=\"agree\" value=\"yes\">\
         <input type=\"checkbox\" name=\"news\" value=\"on\" checked>\
         <input type=\"checkbox\" name=\"terms\" value=\"ok\" checked required>\
         <input type=\"checkbox\" name=\"tags\" value=\"a\" checked>\
         <input type=\"checkbox\" name=\"tags\" value=\"b\" checked required>\
         <input type=\"checkbox\" name=\"tags\" value=\"c\">",
    );
    assert_eq!(data, json!({ "terms": "ok", "tags": ["b"] }));
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

#[test]
fn a_large_form_stops_at_the_field_cap_and_the_html_cap() {
    let big: String = (0..50_000)
        .map(|i| format!("<input name=\"f{i}\">"))
        .collect();
    assert!(big.len() > MAX_HTML_BYTES);
    let data = form_defaults(&big);
    assert_eq!(data.as_object().unwrap().len(), MAX_FIELDS);

    let padded = format!("{}<input name=\"late\">", "é".repeat(MAX_HTML_BYTES));
    assert_eq!(form_defaults(&padded), json!({}));
}

#[test]
fn a_huge_radio_group_is_read_in_bounded_time() {
    let html: String = (0..20_000)
        .map(|i| format!("<input type=\"radio\" name=\"g\" value=\"v{i}\">"))
        .collect();
    let data = form_defaults(&html);
    assert_eq!(data, json!({ "g": "v0" }));
}

#[test]
fn a_radio_group_or_select_picks_the_safe_option_not_the_first() {
    let data = form_defaults(
        "<input type=\"radio\" name=\"ok\" value=\"yes\">Yes<input type=\"radio\" name=\"ok\" value=\"no\">No\
         <select name=\"env\"><option>Staging</option><option>Production</option></select>\
         <select name=\"go\"><option>Approve and execute</option><option>Refine plan</option></select>",
    );
    assert_eq!(
        data,
        json!({ "ok": "no", "env": "Staging", "go": "Refine plan" })
    );
}

#[test]
fn a_marked_radio_option_still_beats_the_safe_one() {
    let data = form_defaults(
        "<input type=\"radio\" name=\"ok\" value=\"yes\" checked><input type=\"radio\" name=\"ok\" value=\"no\">",
    );
    assert_eq!(data, json!({ "ok": "yes" }));
}
