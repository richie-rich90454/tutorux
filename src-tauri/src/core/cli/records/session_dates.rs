use super::*;

pub(crate) fn valid_calendar_date(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    if parts.len() != 3
        || parts[0].len() != 4
        || parts[1].len() != 2
        || parts[2].len() != 2
        || !parts.iter().all(|part| part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return false;
    }
    let year: i64 = parts[0].parse().unwrap_or(0);
    let month: i64 = parts[1].parse().unwrap_or(0);
    let day: i64 = parts[2].parse().unwrap_or(0);
    year != 0 && (1..=12).contains(&month) && (1..=31).contains(&day)
        && civil_date(days_from_civil(year, month, day)) == value
}

pub(crate) fn session_started_at_us(record: &ArchiveRecord) -> i64 {
    record
        .field("started_at_us")
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit() || byte == b'-'))
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_else(|| {
            record
                .field("created_at_us")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0)
        })
}

pub(crate) fn date_bound(value: Option<&str>, inclusive_end: bool) -> CliResult<Option<i128>> {    let Some(value) = value else {
        return Ok(None);
    };
    let parts: Vec<&str> = value.split('-').collect();
    if parts.len() != 3 {
        return Err(CliError("Use a valid calendar date in YYYY-MM-DD format.".to_owned()).into());
    }
    let year: i64 = parts[0]
        .parse()
        .map_err(|_| CliError("Use a valid calendar date in YYYY-MM-DD format.".to_owned()))?;
    let month: i64 = parts[1]
        .parse()
        .map_err(|_| CliError("Use a valid calendar date in YYYY-MM-DD format.".to_owned()))?;
    let day: i64 = parts[2]
        .parse()
        .map_err(|_| CliError("Use a valid calendar date in YYYY-MM-DD format.".to_owned()))?;
    if year == 0 || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(CliError("Use a valid calendar date in YYYY-MM-DD format.".to_owned()).into());
    }
    let days = days_from_civil(year, month, day);
    if civil_date(days) != value {
        return Err(CliError("Use a valid calendar date in YYYY-MM-DD format.".to_owned()).into());
    }
    let seconds = days * 86_400;
    let micros = if inclusive_end {
        (seconds + 86_399) * 1_000_000
    } else {
        seconds * 1_000_000
    };
    Ok(Some(micros as i128))
}

pub(crate) fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

