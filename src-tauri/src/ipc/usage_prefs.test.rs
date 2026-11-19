// The Session usage toggles' stored choices; every test uses its own scratch `usage.db`.
use super::*;

fn scratch_db_path() -> std::path::PathBuf {
    let dir = crate::test_scratch::path("usage-prefs");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("usage.db")
}

#[test]
fn main_scope_survives_set_then_get() {
    let db = scratch_db_path();
    let set = write_prefs(
        &db,
        &json!({ "sessionScope": "main", "sessionRange": "today" }),
    )
    .unwrap();
    assert_eq!(set["sessionScope"], "main");
    let got = read_prefs(&db).unwrap();
    assert_eq!(got["sessionScope"], "main");
    assert_eq!(got["sessionRange"], "today");
}

#[test]
fn defaults_apply_until_a_choice_is_stored() {
    let got = read_prefs(&scratch_db_path()).unwrap();
    assert_eq!(got["sessionScope"], "session");
    assert_eq!(got["sessionRange"], "all");
}

#[test]
fn an_unknown_scope_is_rejected_and_not_stored() {
    let db = scratch_db_path();
    assert!(write_prefs(&db, &json!({ "sessionScope": "main thread" })).is_err());
    assert_eq!(read_prefs(&db).unwrap()["sessionScope"], "session");
}
