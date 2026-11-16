use super::*;

#[test]
fn a_cached_pull_request_is_used_without_a_lookup() {
    let cached = json!({ "number": 7, "url": "https://github.com/o/r/pull/7" });
    assert_eq!(pr_source(cached.clone()), PrSource::Cached(cached));
}

#[test]
fn a_null_cache_falls_through_to_a_lookup() {
    assert_eq!(pr_source(Value::Null), PrSource::Lookup);
}

#[test]
fn the_link_keeps_only_number_and_url() {
    let pr = json!({ "number": 7, "url": "u", "state": "open", "checks": "passing" });
    assert_eq!(link_of(&pr), json!({ "number": 7, "url": "u" }));
}

#[test]
fn a_value_without_number_and_url_is_no_link() {
    assert_eq!(link_of(&Value::Null), Value::Null);
    assert_eq!(link_of(&json!({ "number": 7 })), Value::Null);
    assert_eq!(link_of(&json!({ "url": "u" })), Value::Null);
}
