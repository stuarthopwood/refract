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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct DebugOverrides {
    /// `REFRACT_DATE_OVERRIDE` (`YYYY-MM-DD`): substitutes for `new Date()` everywhere the
    /// renderer computes the active holiday (`shared/holidays.ts::activeHoliday`), so a live
    /// check can see Halloween artwork without touching the system clock.
    date: Option<String>,
    /// `REFRACT_HOLIDAY_IDLE_MS`: shortens the ambient loop's 60s no-input auto-pause
    /// (WCAG 2.2.2) so a live check does not have to wait a full minute for that path.
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
        resolve_overrides_from(
            std::env::var("REFRACT_DATE_OVERRIDE").ok(),
            std::env::var("REFRACT_HOLIDAY_IDLE_MS").ok(),
        )
    }
    #[cfg(not(debug_assertions))]
    DebugOverrides {
        date: None,
        idle_timeout_ms: None,
    }
}

/// Pure parsing logic, factored out so it is `#[test]`-able without touching the real process
/// environment (same reasoning `lib.rs::resolve_data_dir_override` documents) -- compiled in
/// every build (not `#[cfg(debug_assertions)]` itself) so its own tests always run, even though
/// `resolve_overrides` above only ever calls it from inside a debug build.
fn resolve_overrides_from(raw_date: Option<String>, raw_idle_ms: Option<String>) -> DebugOverrides {
    let date = raw_date
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    let idle_timeout_ms = raw_idle_ms
        .as_deref()
        .and_then(|v| v.trim().parse::<u64>().ok());
    DebugOverrides {
        date,
        idle_timeout_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_and_whitespace_date_is_none() {
        assert_eq!(
            resolve_overrides_from(Some("  ".to_string()), None).date,
            None
        );
        assert_eq!(resolve_overrides_from(None, None).date, None);
        assert_eq!(
            resolve_overrides_from(Some("2026-10-27".to_string()), None).date,
            Some("2026-10-27".to_string())
        );
    }

    #[test]
    fn unparsable_idle_ms_is_none() {
        assert_eq!(
            resolve_overrides_from(None, Some("not-a-number".to_string())).idle_timeout_ms,
            None
        );
        assert_eq!(
            resolve_overrides_from(None, Some("500".to_string())).idle_timeout_ms,
            Some(500)
        );
    }
}
