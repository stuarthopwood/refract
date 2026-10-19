// IPC handlers for debug-build-only knobs (issue #1048, R-lane live-check harness). Same posture
// as `lib.rs::data_dir`'s own `REFRACT_DATA_DIR`: every env var read here is gated
// `#[cfg(debug_assertions)]`, so a release build's `debug.getOverrides` always answers
// `{ date: null, idleTimeoutMs: null }` regardless of whether either variable happens to be set
// in the process environment (gate-fix precedent, security review MEDIUM) -- never a build-time
// `#[cfg]` on the channel's own registration, so the renderer can call this channel unconditionally
// in every build without a feature-detection round trip; a release build's answer is simply
// always inert.
use serde::Serialize;
use serde_json::Value;

use super::{AppState, Dispatcher, HandlerFuture};

pub fn register(d: &mut Dispatcher) {
    d.register("debug.getOverrides", debug_get_overrides);
}

/// Gate round 1 fix (Low, #1053): a debug build should never honour an idle override shorter
/// than this -- a live check that asked for 0ms would otherwise busy-loop the pause/resume
/// transition on every render. Only ever read from inside `resolve_overrides_from` (itself
/// `#[cfg(any(debug_assertions, test))]`), so this carries the same gate -- an unqualified
/// release build never declares (or warns about) a constant it can never read.
#[cfg(any(debug_assertions, test))]
const MIN_IDLE_TIMEOUT_MS: u64 = 1_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct DebugOverrides {
    /// `REFRACT_DATE_OVERRIDE` (`YYYY-MM-DD`): substitutes for `new Date()` everywhere the
    /// renderer computes the active holiday (`shared/holidays.ts::activeHoliday`), so a live
    /// check can see Halloween artwork without touching the system clock. Rejected (falls back
    /// to `None`, the real system date) unless it is a genuine calendar date that round-trips
    /// (`2026-02-30` is not a real day; never silently rolled forward to March 2nd the way
    /// JavaScript's own lenient `Date` parsing would).
    date: Option<String>,
    /// `REFRACT_HOLIDAY_IDLE_MS`: shortens the ambient loop's 60s no-input auto-pause
    /// (WCAG 2.2.2) so a live check does not have to wait a full minute for that path. Clamped
    /// to at least `MIN_IDLE_TIMEOUT_MS`.
    #[serde(rename = "idleTimeoutMs")]
    idle_timeout_ms: Option<u64>,
}

pub fn debug_get_overrides(_state: AppState, _args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let overrides = resolve_overrides();
        Ok(serde_json::to_value(overrides).expect("DebugOverrides is always JSON-serialisable"))
    })
}

/// Mirrors `lib.rs::data_dir`'s own shape: the `#[cfg(debug_assertions)]` block is this
/// function's own tail expression in a debug build (the `#[cfg(not(debug_assertions))]` block
/// below is compiled out entirely in that build); a release build compiles out the first block
/// instead and falls through to the always-inert default.
fn resolve_overrides() -> DebugOverrides {
    #[cfg(debug_assertions)]
    {
        return resolve_overrides_from(
            std::env::var("REFRACT_DATE_OVERRIDE").ok(),
            std::env::var("REFRACT_HOLIDAY_IDLE_MS").ok(),
        );
    }
    #[cfg(not(debug_assertions))]
    DebugOverrides {
        date: None,
        idle_timeout_ms: None,
    }
}

/// Pure parsing logic, factored out so it is `#[test]`-able without touching the real process
/// environment (same reasoning `lib.rs::resolve_data_dir_override` documents). Gate round 1 fix
/// (Low, #1053): now `#[cfg(any(debug_assertions, test))]` -- it has no reason to exist in a
/// release build at all (`resolve_overrides` above never calls it there), so it no longer does.
#[cfg(any(debug_assertions, test))]
fn resolve_overrides_from(raw_date: Option<String>, raw_idle_ms: Option<String>) -> DebugOverrides {
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
    DebugOverrides {
        date,
        idle_timeout_ms,
    }
}

/// Strict `YYYY-MM-DD` parse plus a real calendar-validity check (rejects `2026-02-30`, a
/// non-existent day, rather than letting it through for the caller's own `new Date(...)` to
/// silently roll forward to March 2nd). Never accepts a leading `+`/extra whitespace inside a
/// field: each part must be ALL ASCII digits, of the expected width.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_and_whitespace_date_is_none() {
        assert_eq!(resolve_overrides_from(Some("  ".to_string()), None).date, None);
        assert_eq!(resolve_overrides_from(None, None).date, None);
        assert_eq!(
            resolve_overrides_from(Some("2026-10-27".to_string()), None).date,
            Some("2026-10-27".to_string())
        );
    }

    /// Gate round 1 (#1053) added real calendar-validity rejection (`2026-02-30` is not a real
    /// day) and the `MIN_IDLE_TIMEOUT_MS` clamp -- AGENTS.md's prototyping rule forbids a new
    /// test for either, so both are proven live instead (`scripts/verify-1048-holiday-touches.mjs`
    /// launches once with `REFRACT_DATE_OVERRIDE=2026-02-30` and asserts the override resolves to
    /// `null`). This pre-existing test is only ADAPTED (never a new one): its second assertion
    /// now reflects the clamp the code under test gained, rather than the pre-clamp `Some(500)`.
    #[test]
    fn unparsable_idle_ms_is_none() {
        assert_eq!(resolve_overrides_from(None, Some("not-a-number".to_string())).idle_timeout_ms, None);
        assert_eq!(resolve_overrides_from(None, Some("500".to_string())).idle_timeout_ms, Some(MIN_IDLE_TIMEOUT_MS));
    }
}
