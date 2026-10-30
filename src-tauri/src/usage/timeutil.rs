// Spec 060: the little date arithmetic the usage module needs without a date crate.

pub const HOUR_MS: i64 = 3_600_000;
pub const DAY_MS: i64 = 86_400_000;

/// Start of the UTC hour containing `ts_ms`.
pub fn hour_start(ts_ms: i64) -> i64 {
    ts_ms - ts_ms.rem_euclid(HOUR_MS)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `(year, month, day)` for days since 1970-01-01.
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `YYYY-MM-DD` of a UTC millisecond instant.
pub fn iso_date(ts_ms: i64) -> String {
    let (y, m, d) = civil_from_days(ts_ms.div_euclid(DAY_MS));
    format!("{y:04}-{m:02}-{d:02}")
}

/// UTC millisecond start of the first day of the month after `ts_ms`.
pub fn next_month_start(ts_ms: i64) -> i64 {
    let (y, m, _) = civil_from_days(ts_ms.div_euclid(DAY_MS));
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    days_from_civil(ny, nm, 1) * DAY_MS
}

/// Parses `YYYY-MM-DD` or an RFC 3339 `YYYY-MM-DDTHH:MM:SS[.fff](Z|+HH:MM|-HH:MM)` instant to UTC
/// milliseconds. Anything else is `None`.
pub fn parse_iso_ms(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let slice = b.get(from..from + len)?;
        slice
            .iter()
            .all(u8::is_ascii_digit)
            .then(|| slice.iter().fold(0i64, |a, d| a * 10 + i64::from(d - b'0')))
    };
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return None;
    }
    let (y, m, d) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let mut ms = days_from_civil(y, m, d) * DAY_MS;
    if b.len() == 10 {
        return Some(ms);
    }
    if !matches!(b.get(10), Some(b'T') | Some(b' ')) || b.get(13) != Some(&b':') {
        return None;
    }
    ms += num(11, 2)? * HOUR_MS + num(14, 2)? * 60_000;
    let mut i = 16;
    if b.get(i) == Some(&b':') {
        ms += num(i + 1, 2)? * 1000;
        i += 3;
    }
    if b.get(i) == Some(&b'.') {
        let digits = b[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
        let frac: String = text[i + 1..i + 1 + digits].chars().take(3).collect();
        let scale = 10i64.pow(3 - frac.len() as u32);
        ms += frac.parse::<i64>().unwrap_or(0) * scale;
        i += 1 + digits;
    }
    match b.get(i) {
        None | Some(b'Z') | Some(b'z') => Some(ms),
        Some(sign @ (b'+' | b'-')) => {
            let off = num(i + 1, 2)? * 60 + num(i + 4, 2).or_else(|| num(i + 3, 2))?;
            let off_ms = off * 60_000;
            Some(if *sign == b'+' { ms - off_ms } else { ms + off_ms })
        }
        _ => None,
    }
}
