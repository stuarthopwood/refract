// One-shot Alarms set from the composer clock (#1426, spec 072).
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{Settings, SettingsStore};

pub(super) const KEY: &str = "alarms";
pub const MAX_ALARMS: usize = 20;
pub const MAX_LABEL_CHARS: usize = 80;
const MAX_ID_CHARS: usize = 64;
/// An alarm overdue by more than this (app closed or asleep) goes inactive without notifying.
pub const FIRE_GRACE_MS: i64 = 5 * 60 * 1000;
/** Year 9999: anything later is garbage and would overflow time arithmetic. */
const MAX_FIRE_AT_MS: i64 = 253_402_300_799_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alarm {
    pub id: String,
    pub label: String,
    /// UTC epoch milliseconds the alarm fires at.
    pub fire_at_ms: i64,
    pub active: bool,
}

impl Alarm {
    /// Trims the label, caps lengths, and rejects an empty or oversize id.
    pub fn sanitized(id: &str, label: &str, fire_at_ms: i64, active: bool) -> Option<Alarm> {
        let id = id.trim();
        if id.is_empty()
            || id.chars().count() > MAX_ID_CHARS
            || !(0..=MAX_FIRE_AT_MS).contains(&fire_at_ms)
        {
            return None;
        }
        Some(Alarm {
            id: id.to_string(),
            label: label
                .trim()
                .chars()
                .filter(|c| !c.is_control())
                .take(MAX_LABEL_CHARS)
                .collect(),
            fire_at_ms,
            active,
        })
    }
}

fn parse_one(value: &Value) -> Option<Alarm> {
    let object = value.as_object()?;
    Alarm::sanitized(
        object.get("id")?.as_str()?,
        object.get("label").and_then(Value::as_str).unwrap_or(""),
        object.get("fireAtMs")?.as_i64()?,
        object
            .get("active")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )
}

/// A malformed entry is dropped, never the whole list; duplicates keep the first.
pub(super) fn parse(object: &Map<String, Value>) -> Vec<Alarm> {
    let mut alarms: Vec<Alarm> = Vec::new();
    for alarm in object
        .get(KEY)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(parse_one)
    {
        if alarms.len() < MAX_ALARMS && !alarms.iter().any(|a| a.id == alarm.id) {
            alarms.push(alarm);
        }
    }
    alarms
}

pub(super) fn write(map: &mut Map<String, Value>, alarms: &[Alarm]) {
    map.insert(KEY.to_string(), serde_json::json!(alarms));
}

impl SettingsStore {
    /// `settings.upsertAlarm`: replaces by id, or appends. `Ok(None)` when the list is full.
    pub async fn upsert_alarm(&mut self, alarm: Alarm) -> std::io::Result<Option<Settings>> {
        let mut alarms = self.data.alarms.clone();
        if let Some(index) = alarms.iter().position(|a| a.id == alarm.id) {
            alarms[index] = alarm;
        } else if alarms.len() >= MAX_ALARMS {
            return Ok(None);
        } else {
            alarms.push(alarm);
        }
        let next = Settings {
            alarms,
            ..self.data.clone()
        };
        self.persist_whole(next).await.map(Some)
    }

    /// `settings.deleteAlarm`: an unknown id is a no-op.
    pub async fn delete_alarm(&mut self, id: &str) -> std::io::Result<Settings> {
        let mut alarms = self.data.alarms.clone();
        alarms.retain(|a| a.id != id);
        let next = Settings {
            alarms,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// Soonest active fire time, for the scheduler's single timer.
    pub fn next_alarm_ms(&self) -> Option<i64> {
        self.data
            .alarms
            .iter()
            .filter(|a| a.active)
            .map(|a| a.fire_at_ms)
            .min()
    }

    /// Marks every due alarm inactive and persists once; returns those fresh enough to notify.
    /// A failed save still returns them (the in-memory state is already updated), with the error.
    pub async fn take_due_alarms(&mut self, now_ms: i64) -> (Vec<Alarm>, Option<std::io::Error>) {
        let mut alarms = self.data.alarms.clone();
        let mut to_notify = Vec::new();
        for alarm in alarms
            .iter_mut()
            .filter(|a| a.active && a.fire_at_ms <= now_ms)
        {
            alarm.active = false;
            if now_ms.saturating_sub(alarm.fire_at_ms) <= FIRE_GRACE_MS {
                to_notify.push(alarm.clone());
            }
        }
        if alarms == self.data.alarms {
            return (to_notify, None);
        }
        let next = Settings {
            alarms,
            ..self.data.clone()
        };
        (to_notify, self.persist_whole(next).await.err())
    }
}
