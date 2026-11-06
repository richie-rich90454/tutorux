use super::{
    available_metric,
    command::{run_bounded_command, seconds_to_microseconds},
    unavailable_metric, ProcessMetrics,
};

pub(super) fn macos_process_metrics() -> ProcessMetrics {
    let process_id = std::process::id();
    let process_values = run_bounded_command(
        "/bin/ps",
        &[
            "-o",
            "cputime=",
            "-o",
            "rss=",
            "-o",
            "etimes=",
            "-p",
            &process_id.to_string(),
        ],
    )
    .and_then(|output| parse_macos_process_row(&output));

    let (uptime_microseconds, cpu_time_microseconds, resident_memory_bytes) = match process_values {
        Ok((cpu_time, resident_memory, uptime)) => (
            available_metric(uptime.saturating_mul(1_000_000)),
            available_metric(cpu_time),
            available_metric(resident_memory),
        ),
        Err(reason) => {
            let reason = format!("macOS process metrics could not be read using ps: {reason}");
            (
                unavailable_metric(reason.clone()),
                unavailable_metric(reason.clone()),
                unavailable_metric(reason),
            )
        }
    };

    let peak_resident_memory_bytes = macos_peak_resident_memory().map_or_else(
        |reason| {
            unavailable_metric(format!(
                "macOS peak resident memory is unavailable: {reason}"
            ))
        },
        available_metric,
    );
    let available_memory_bytes = macos_available_memory().map_or_else(
        |reason| unavailable_metric(format!("macOS available memory is unavailable: {reason}")),
        available_metric,
    );
    ProcessMetrics {
        uptime_microseconds,
        cpu_time_microseconds,
        resident_memory_bytes,
        peak_resident_memory_bytes,
        available_memory_bytes,
    }
}

fn macos_peak_resident_memory() -> Result<u64, String> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // SAFETY: getrusage writes the complete rusage structure for RUSAGE_SELF before returning 0;
    // the pointer is valid and uniquely borrowed for the duration of this call.
    let status = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    if status != 0 {
        return Err("getrusage could not read this process's resource usage.".into());
    }
    // SAFETY: the successful getrusage call above initialized the entire rusage structure.
    let usage = unsafe { usage.assume_init() };
    u64::try_from(usage.ru_maxrss)
        .map_err(|_| "getrusage returned an invalid peak resident memory value.".to_owned())
}

fn parse_macos_process_row(contents: &str) -> Result<(u64, u64, u64), String> {
    let fields: Vec<&str> = contents.split_whitespace().collect();
    if fields.len() < 3 {
        return Err("ps did not return a complete process metrics row.".into());
    }
    let cpu_time = parse_clock_duration_microseconds(fields[0])?;
    let resident_kib = fields[1]
        .parse::<u64>()
        .map_err(|_| "ps returned an invalid resident memory value.".to_owned())?;
    let resident_bytes = resident_kib
        .checked_mul(1024)
        .ok_or_else(|| "ps returned an out-of-range resident memory value.".to_owned())?;
    let uptime = fields[2]
        .parse::<u64>()
        .map_err(|_| "ps returned an invalid process uptime value.".to_owned())?;
    Ok((cpu_time, resident_bytes, uptime))
}

fn parse_clock_duration_microseconds(value: &str) -> Result<u64, String> {
    let (days, clock) = match value.split_once('-') {
        Some((days, clock)) => (
            days.parse::<u64>()
                .map_err(|_| "ps returned an invalid CPU time value.".to_owned())?,
            clock,
        ),
        None => (0, value),
    };
    let components: Vec<&str> = clock.split(':').collect();
    let (hours, minutes, seconds) = match components.as_slice() {
        [seconds] => (0_u64, 0_u64, parse_seconds(seconds)?),
        [minutes, seconds] => (
            0,
            minutes
                .parse::<u64>()
                .map_err(|_| "ps returned an invalid CPU time value.".to_owned())?,
            parse_seconds(seconds)?,
        ),
        [hours, minutes, seconds] => (
            hours
                .parse::<u64>()
                .map_err(|_| "ps returned an invalid CPU time value.".to_owned())?,
            minutes
                .parse::<u64>()
                .map_err(|_| "ps returned an invalid CPU time value.".to_owned())?,
            parse_seconds(seconds)?,
        ),
        _ => return Err("ps returned an unsupported CPU time format.".into()),
    };
    let total_seconds = days as f64 * 24.0 * 60.0 * 60.0
        + hours as f64 * 60.0 * 60.0
        + minutes as f64 * 60.0
        + seconds;
    seconds_to_microseconds(total_seconds)
}

fn macos_available_memory() -> Result<u64, String> {
    let output = run_bounded_command("/usr/bin/vm_stat", &[])?;
    let first_line = output
        .lines()
        .next()
        .ok_or_else(|| "vm_stat returned an empty memory report.".to_owned())?;
    let page_size = first_line
        .split("page size of ")
        .nth(1)
        .and_then(|rest| rest.split_whitespace().next())
        .ok_or_else(|| "vm_stat did not report its page size.".to_owned())?
        .parse::<u64>()
        .map_err(|_| "vm_stat returned an invalid page size.".to_owned())?;
    let mut available_pages = 0_u64;
    let mut found = 0_u8;
    for line in output.lines() {
        let Some((name, count)) = line.split_once(':') else {
            continue;
        };
        if matches!(
            name.trim(),
            "Pages free" | "Pages inactive" | "Pages speculative"
        ) {
            let count = count
                .trim()
                .trim_end_matches('.')
                .parse::<u64>()
                .map_err(|_| "vm_stat returned an invalid available page count.".to_owned())?;
            available_pages = available_pages.saturating_add(count);
            found += 1;
        }
    }
    if found != 3 {
        return Err("vm_stat did not expose all available-memory page counters.".into());
    }
    available_pages
        .checked_mul(page_size)
        .ok_or_else(|| "vm_stat returned an out-of-range available memory value.".into())
}

fn parse_seconds(value: &str) -> Result<f64, String> {
    value
        .parse::<f64>()
        .map_err(|_| "The operating system returned an invalid seconds value.".to_owned())
}
