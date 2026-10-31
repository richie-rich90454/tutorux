use std::fs;

use super::{
    available_metric,
    command::{run_bounded_command, seconds_to_microseconds},
    unavailable_metric, ProcessMetrics,
};

pub(super) fn linux_process_metrics() -> ProcessMetrics {
    let status = fs::read_to_string("/proc/self/status");
    let resident_memory_bytes = status
        .as_ref()
        .map_err(|error| error.to_string())
        .and_then(|contents| parse_proc_memory_kib(contents, "VmRSS"));
    let peak_resident_memory_bytes = status
        .as_ref()
        .map_err(|error| error.to_string())
        .and_then(|contents| parse_proc_memory_kib(contents, "VmHWM"));
    let available_memory_bytes = fs::read_to_string("/proc/meminfo")
        .map_err(|error| error.to_string())
        .and_then(|contents| parse_proc_memory_kib(&contents, "MemAvailable"));

    let process = fs::read_to_string("/proc/self/stat")
        .map_err(|error| error.to_string())
        .and_then(|contents| parse_linux_process_stat(&contents));
    let clock_ticks = run_bounded_command("getconf", &["CLK_TCK"]).and_then(|output| {
        output
            .trim()
            .parse::<u64>()
            .map_err(|_| "getconf returned an invalid clock-tick rate.".to_owned())
    });
    let uptime_microseconds = fs::read_to_string("/proc/uptime")
        .map_err(|error| error.to_string())
        .and_then(|contents| parse_first_seconds(&contents));

    let (cpu_time_microseconds, process_uptime_microseconds) = match (process, clock_ticks) {
        (Ok((user_ticks, system_ticks, start_ticks)), Ok(ticks_per_second))
            if ticks_per_second > 0 =>
        {
            let cpu =
                ticks_to_microseconds(user_ticks.saturating_add(system_ticks), ticks_per_second);
            let uptime = uptime_microseconds.map(|system_uptime| {
                system_uptime.saturating_sub(ticks_to_microseconds(start_ticks, ticks_per_second))
            });
            (Ok(cpu), uptime)
        }
        (Err(error), _) => (Err(error.clone()), Err(error)),
        (_, Err(error)) => (Err(error.clone()), Err(error)),
        (_, Ok(_)) => {
            let reason = "Linux returned an invalid process clock-tick rate.".to_owned();
            (Err(reason.clone()), Err(reason))
        }
    };

    ProcessMetrics {
        uptime_microseconds: process_uptime_microseconds.map_or_else(
            |reason| unavailable_metric(format!("Linux process uptime is unavailable: {reason}")),
            available_metric,
        ),
        cpu_time_microseconds: cpu_time_microseconds.map_or_else(
            |reason| unavailable_metric(format!("Linux process CPU time is unavailable: {reason}")),
            available_metric,
        ),
        resident_memory_bytes: resident_memory_bytes.map_or_else(
            |reason| unavailable_metric(format!("Linux resident memory is unavailable: {reason}")),
            available_metric,
        ),
        peak_resident_memory_bytes: peak_resident_memory_bytes.map_or_else(
            |reason| {
                unavailable_metric(format!(
                    "Linux peak resident memory is unavailable: {reason}"
                ))
            },
            available_metric,
        ),
        available_memory_bytes: available_memory_bytes.map_or_else(
            |reason| unavailable_metric(format!("Linux available memory is unavailable: {reason}")),
            available_metric,
        ),
    }
}

fn parse_linux_process_stat(contents: &str) -> Result<(u64, u64, u64), String> {
    let command_end = contents
        .rfind(')')
        .ok_or_else(|| "The Linux process stat row is malformed.".to_owned())?;
    let fields: Vec<&str> = contents[command_end + 1..].split_whitespace().collect();
    let parse = |index: usize| {
        fields
            .get(index)
            .ok_or_else(|| "The Linux process stat row is incomplete.".to_owned())?
            .parse::<u64>()
            .map_err(|_| "The Linux process stat row contains an invalid counter.".to_owned())
    };
    // The first token after the command is field 3 (state), so these are fields 14, 15, and 22.
    Ok((parse(11)?, parse(12)?, parse(19)?))
}

fn parse_proc_memory_kib(contents: &str, field_name: &str) -> Result<u64, String> {
    let value = contents
        .lines()
        .find_map(|line| {
            let (name, remainder) = line.split_once(':')?;
            (name == field_name)
                .then(|| remainder.split_whitespace().next())
                .flatten()
        })
        .ok_or_else(|| format!("{field_name} was not present in the proc memory report."))?
        .parse::<u64>()
        .map_err(|_| format!("{field_name} was not a valid memory value."))?;
    value
        .checked_mul(1024)
        .ok_or_else(|| format!("{field_name} exceeded the supported memory range.".to_owned()))
}

fn parse_first_seconds(contents: &str) -> Result<u64, String> {
    let seconds = contents
        .split_whitespace()
        .next()
        .ok_or_else(|| "The Linux uptime report was empty.".to_owned())?
        .parse::<f64>()
        .map_err(|_| "The Linux uptime report contained an invalid value.".to_owned())?;
    seconds_to_microseconds(seconds)
}

fn ticks_to_microseconds(ticks: u64, ticks_per_second: u64) -> u64 {
    ((u128::from(ticks) * 1_000_000) / u128::from(ticks_per_second)).min(u128::from(u64::MAX))
        as u64
}
