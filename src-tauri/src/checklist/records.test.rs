use super::*;

fn add(file: &mut ChecklistFile, n: u64) {
    add_send_record(
        file,
        "p1",
        &format!("i{n}"),
        n,
        SendAction::Complete,
        "do it",
    );
}

#[test]
fn add_501st_evicts_oldest() {
    let mut file = ChecklistFile::empty();
    for n in 1..=501 {
        add(&mut file, n);
    }

    assert_eq!(file.send_records.len(), 500);
    assert_eq!(file.send_records[0].item_id, "i2");
    assert_eq!(file.send_records[499].item_id, "i501");
    assert!(!has_send_record(
        &file,
        "p1",
        "i1",
        1,
        SendAction::Complete,
        "do it"
    ));
    assert!(has_send_record(
        &file,
        "p1",
        "i2",
        2,
        SendAction::Complete,
        "do it"
    ));
}

#[test]
fn lookup_matches_all_five_fields() {
    let mut file = ChecklistFile::empty();
    add_send_record(&mut file, "p1", "i1", 7, SendAction::Ask, "question");

    assert!(has_send_record(
        &file,
        "p1",
        "i1",
        7,
        SendAction::Ask,
        "question"
    ));
}

#[test]
fn one_field_differs_no_match() {
    let mut file = ChecklistFile::empty();
    add_send_record(&mut file, "p1", "i1", 7, SendAction::Ask, "question");

    assert!(!has_send_record(
        &file,
        "p2",
        "i1",
        7,
        SendAction::Ask,
        "question"
    ));
    assert!(!has_send_record(
        &file,
        "p1",
        "i2",
        7,
        SendAction::Ask,
        "question"
    ));
    assert!(!has_send_record(
        &file,
        "p1",
        "i1",
        8,
        SendAction::Ask,
        "question"
    ));
    assert!(!has_send_record(
        &file,
        "p1",
        "i1",
        7,
        SendAction::Value,
        "question"
    ));
    assert!(!has_send_record(
        &file,
        "p1",
        "i1",
        7,
        SendAction::Ask,
        "question?"
    ));
}

#[test]
fn record_stores_hash_not_text() {
    let mut file = ChecklistFile::empty();
    add_send_record(
        &mut file,
        "p1",
        "i1",
        1,
        SendAction::Value,
        "secret turn text",
    );

    let stored = serde_json::to_string(&file.send_records).unwrap();
    assert!(!stored.contains("secret"));
    assert_eq!(file.send_records[0].text_hash.len(), 64);
    assert_eq!(
        file.send_records[0].text_hash,
        text_hash("secret turn text")
    );
}
