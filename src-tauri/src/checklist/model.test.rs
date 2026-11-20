use super::*;
use crate::checklist::ids::{take_checklist_id, take_item_id};

const FIXTURE: &str = include_str!("fixtures/checklist-v1.json");

fn pretty(file: &ChecklistFile) -> String {
    format!("{}\n", serde_json::to_string_pretty(file).unwrap())
}

#[test]
fn golden_fixture_round_trips_byte_equal() {
    let file: ChecklistFile = serde_json::from_str(FIXTURE).unwrap();
    assert_eq!(pretty(&file), FIXTURE.replace("\r\n", "\n"));
}

#[test]
fn ids_never_reused_after_remove() {
    let mut file = ChecklistFile::empty();
    assert_eq!(take_checklist_id(&mut file), "p1");
    assert_eq!(take_checklist_id(&mut file), "p2");
    let mut list = Checklist::empty("p2".into(), "t".into(), "now".into());
    let ids: Vec<String> = (0..3).map(|_| take_item_id(&mut list)).collect();
    assert_eq!(ids, ["i1", "i2", "i3"]);
    // `list.items` stays empty, as after removing every item: the next id still follows the counter.
    assert_eq!(take_item_id(&mut list), "i4");
}

#[test]
fn counters_persisted_not_derived() {
    let mut file: ChecklistFile = serde_json::from_str(FIXTURE).unwrap();
    let active = file.active.as_mut().unwrap();
    // The fixture's highest live item is i5; i6 was removed, so a derived counter would say i6.
    assert_eq!(active.items.last().unwrap().id, "i5");
    assert_eq!(take_item_id(active), "i7");
    assert_eq!(take_checklist_id(&mut file), "p3");
    let reloaded: ChecklistFile = serde_json::from_str(&pretty(&file)).unwrap();
    assert_eq!(reloaded.next_checklist_seq, 4);
    assert_eq!(reloaded.active.unwrap().next_item_seq, 8);
}

fn wire<T: serde::Serialize>(values: &[T]) -> Vec<String> {
    values
        .iter()
        .map(|v| {
            serde_json::to_value(v)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect()
}

#[test]
fn status_and_owner_sets_exact() {
    assert_eq!(
        wire(&ItemStatus::ALL),
        ["upcoming", "next", "in_progress", "blocked", "complete"]
    );
    assert_eq!(wire(&ItemOwner::ALL), ["agent", "human", "either"]);
    assert!(serde_json::from_str::<ItemStatus>("\"done\"").is_err());
    assert!(serde_json::from_str::<ItemOwner>("\"nobody\"").is_err());
}
