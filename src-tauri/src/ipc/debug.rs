// Debug-build knobs for the R-lane live checks. Release builds always answer with nulls.
// `#[cfg(debug_assertions)]` gates the env reads, so the channel can be called in every build.
use serde::Serialize;
use serde_json::Value;

use super::{AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register("debug.getOverrides", debug_get_overrides);
}

/// Floor for the idle override: 0ms would busy-loop the pause/resume transition.
#[cfg(debug_assertions)]
const MIN_IDLE_TIMEOUT_MS: u64 = 1_000;

/// Floor for the flight-interval override: 0ms would busy-loop flights back-to-back.
#[cfg(debug_assertions)]
const MIN_FLIGHT_INTERVAL_MS: u64 = 500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct DebugOverrides {
    /// `REFRACT_DATE_OVERRIDE` (`YYYY-MM-DD`): stands in for today's date in holiday selection.
    /// Invalid dates such as `2026-02-30` resolve to `None`, never rolled forward.
    date: Option<String>,
    /// `REFRACT_HOLIDAY_IDLE_MS`: shortens the 60s ambient auto-pause (WCAG 2.2.2), clamped to a floor.
    #[serde(rename = "idleTimeoutMs")]
    idle_timeout_ms: Option<u64>,
    /// `REFRACT_HOLIDAY_FLIGHT_INTERVAL_MS`: fixes the 60-120s flight gap so a sample holds several flights.
    #[serde(rename = "flightIntervalMs")]
    flight_interval_ms: Option<u64>,
}

pub fn debug_get_overrides(_state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let overrides = resolve_overrides();
        Ok(serde_json::to_value(overrides).expect("DebugOverrides is always JSON-serialisable"))
    })
}

/// Debug block is the tail expression; release compiles it out and falls through to the inert default.
fn resolve_overrides() -> DebugOverrides {
    #[cfg(debug_assertions)]
    {
        resolve_overrides_from(
            std::env::var("REFRACT_DATE_OVERRIDE").ok(),
            std::env::var("REFRACT_HOLIDAY_IDLE_MS").ok(),
            std::env::var("REFRACT_HOLIDAY_FLIGHT_INTERVAL_MS").ok(),
        )
    }
    #[cfg(not(debug_assertions))]
    DebugOverrides {
        date: None,
        idle_timeout_ms: None,
        flight_interval_ms: None,
    }
}

/// Pure parsing, factored out. `resolve_overrides` never calls it in release builds.
/// Covered by the live check `verify-1048-holiday-touches.mjs`, not a unit test.
#[cfg(debug_assertions)]
fn resolve_overrides_from(
    raw_date: Option<String>,
    raw_idle_ms: Option<String>,
    raw_flight_interval_ms: Option<String>,
) -> DebugOverrides {
    let date = raw_date
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .filter(|v| is_valid_calendar_date_string(v))
        .map(str::to_string);
    let idle_timeout_ms = raw_idle_ms
        .as_deref()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(|ms| ms.max(MIN_IDLE_TIMEOUT_MS));
    let flight_interval_ms = raw_flight_interval_ms
        .as_deref()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map(|ms| ms.max(MIN_FLIGHT_INTERVAL_MS));
    DebugOverrides {
        date,
        idle_timeout_ms,
        flight_interval_ms,
    }
}

/// Strict `YYYY-MM-DD` with a real calendar check: `2026-02-30` is rejected, not rolled forward.
/// Each field must be ASCII digits of the expected width.
#[cfg(debug_assertions)]
fn is_valid_calendar_date_string(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    let [year_str, month_str, day_str] = parts.as_slice() else {
        return false;
    };
    if year_str.len() != 4 || month_str.len() != 2 || day_str.len() != 2 {
        return false;
    }
    if !year_str.bytes().all(|b| b.is_ascii_digit())
        || !month_str.bytes().all(|b| b.is_ascii_digit())
        || !day_str.bytes().all(|b| b.is_ascii_digit())
    {
        return false;
    }
    let (Ok(year), Ok(month), Ok(day)) = (
        year_str.parse::<i32>(),
        month_str.parse::<u32>(),
        day_str.parse::<u32>(),
    ) else {
        return false;
    };
    is_valid_calendar_date(year, month, day)
}

#[cfg(debug_assertions)]
fn is_valid_calendar_date(year: i32, month: u32, day: u32) -> bool {
    if !(1..=12).contains(&month) || day == 0 {
        return false;
    }
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap_year(year) {
                29
            } else {
                28
            }
        }
        _ => return false,
    };
    day <= days_in_month
}

#[cfg(debug_assertions)]
fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}
