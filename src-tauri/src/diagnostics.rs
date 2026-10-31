use crate::platform::synchronized_audio::inspect_application_audio_endpoints;
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Data,
};
use serde::Serialize;
#[cfg(target_os = "linux")]
use std::fs;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::{
    process::{Command, Stdio},
    time::Instant,
};
use tauri::WebviewWindow;

const MAX_AUDIO_STREAM_PROBES: usize = 12;
const AUDIO_STREAM_PROBE_DURATION: Duration = Duration::from_millis(125);
#[cfg(target_os = "windows")]
const WINDOWS_TO_UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDiagnostics {
    os: String,
    architecture: String,
    available_threads: Option<usize>,
    process_metrics: ProcessMetrics,
    audio_endpoints: AudioEndpointDiagnostics,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessMetrics {
    uptime_microseconds: DiagnosticMetric,
    cpu_time_microseconds: DiagnosticMetric,
    resident_memory_bytes: DiagnosticMetric,
    peak_resident_memory_bytes: DiagnosticMetric,
    available_memory_bytes: DiagnosticMetric,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticMetric {
    available: bool,
    value: Option<u64>,
    unavailable_reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioEndpointDiagnostics {
    probe_scope: &'static str,
    microphones: EndpointAvailability,
    system_audio: EndpointAvailability,
    application_audio: EndpointAvailability,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EndpointAvailability {
    available: bool,
    count: usize,
    truncated_count: usize,
    probes: Vec<AudioEndpointProbe>,
    unavailable_reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioEndpointProbe {
    state: &'static str,
    sample_format: Option<String>,
    sample_rate_hz: Option<u32>,
    channel_count: Option<u16>,
    unavailable_reason: Option<String>,
}

#[tauri::command]
pub async fn get_desktop_diagnostics(
    window: WebviewWindow,
    probe_audio_endpoints: bool,
) -> Result<DesktopDiagnostics, String> {
    if window.label() != "main" {
        return Err(
            "Desktop diagnostics are only available from the main application window.".into(),
        );
    }

    tauri::async_runtime::spawn_blocking(move || DesktopDiagnostics {
        os: std::env::consts::OS.to_owned(),
        architecture: std::env::consts::ARCH.to_owned(),
        available_threads: std::thread::available_parallelism().ok().map(usize::from),
        process_metrics: collect_process_metrics(),
        audio_endpoints: enumerate_audio_endpoints(probe_audio_endpoints),
    })
    .await
    .map_err(|_| "Desktop diagnostics stopped unexpectedly.".to_owned())
}

fn available_metric(value: u64) -> DiagnosticMetric {
    DiagnosticMetric {
        available: true,
        value: Some(value),
        unavailable_reason: None,
    }
}

fn unavailable_metric(reason: impl Into<String>) -> DiagnosticMetric {
    DiagnosticMetric {
        available: false,
        value: None,
        unavailable_reason: Some(reason.into()),
    }
}

fn collect_process_metrics() -> ProcessMetrics {
    #[cfg(target_os = "windows")]
    {
        windows_process_metrics()
    }
    #[cfg(target_os = "macos")]
    {
        macos_process_metrics()
    }
    #[cfg(target_os = "linux")]
    {
        linux_process_metrics()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let reason = "Process metrics are not implemented for this operating system.";
        ProcessMetrics {
            uptime_microseconds: unavailable_metric(reason),
            cpu_time_microseconds: unavailable_metric(reason),
            resident_memory_bytes: unavailable_metric(reason),
            peak_resident_memory_bytes: unavailable_metric(reason),
            available_memory_bytes: unavailable_metric(reason),
        }
    }
}

#[cfg(target_os = "windows")]
fn windows_process_metrics() -> ProcessMetrics {
    match windows_process_snapshot() {
        Ok(snapshot) => ProcessMetrics {
            cpu_time_microseconds: available_metric(snapshot.cpu_time_microseconds),
            resident_memory_bytes: available_metric(snapshot.resident_memory_bytes),
            peak_resident_memory_bytes: available_metric(snapshot.peak_resident_memory_bytes),
            uptime_microseconds: available_metric(snapshot.uptime_microseconds),
            available_memory_bytes: available_metric(snapshot.available_memory_bytes),
        },
        Err(reason) => {
            let reason = format!(
                "Windows process metrics could not be read through the local Win32 process API: {reason}"
            );
            ProcessMetrics {
                uptime_microseconds: unavailable_metric(reason.clone()),
                cpu_time_microseconds: unavailable_metric(reason.clone()),
                resident_memory_bytes: unavailable_metric(reason.clone()),
                peak_resident_memory_bytes: unavailable_metric(reason.clone()),
                available_memory_bytes: unavailable_metric(reason),
            }
        }
    }
}

#[cfg(target_os = "windows")]
struct WindowsProcessSnapshot {
    cpu_time_microseconds: u64,
    resident_memory_bytes: u64,
    peak_resident_memory_bytes: u64,
    uptime_microseconds: u64,
    available_memory_bytes: u64,
}

#[cfg(target_os = "windows")]
fn windows_process_snapshot() -> Result<WindowsProcessSnapshot, String> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::{
        ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
        SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX},
        Threading::{GetCurrentProcess, GetProcessTimes},
    };

    let process = unsafe { GetCurrentProcess() };
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: GetCurrentProcess returns a pseudo handle valid for this process, and every
    // FILETIME pointer refers to a live, uniquely borrowed local.
    if unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err("GetProcessTimes did not return this process's timing counters.".to_owned());
    }

    let cpu_ticks = filetime_ticks(kernel).saturating_add(filetime_ticks(user));
    let creation_ticks = filetime_ticks(creation);
    let now_ticks = unix_filetime_ticks()?;
    let uptime_ticks = now_ticks.saturating_sub(creation_ticks);

    let mut counters = PROCESS_MEMORY_COUNTERS::default();
    counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    // SAFETY: counters is a live, uniquely borrowed PROCESS_MEMORY_COUNTERS whose cb field
    // states its own size, as GetProcessMemoryInfo requires.
    if unsafe { GetProcessMemoryInfo(process, &mut counters, counters.cb) } == 0 {
        return Err(
            "GetProcessMemoryInfo did not return this process's memory counters.".to_owned(),
        );
    }

    let mut memory = MEMORYSTATUSEX::default();
    memory.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    // SAFETY: memory is a live, uniquely borrowed MEMORYSTATUSEX whose dwLength field states
    // its own size, as GlobalMemoryStatusEx requires.
    if unsafe { GlobalMemoryStatusEx(&mut memory) } == 0 {
        return Err("GlobalMemoryStatusEx did not return the system memory status.".to_owned());
    }

    Ok(WindowsProcessSnapshot {
        cpu_time_microseconds: cpu_ticks / 10,
        resident_memory_bytes: u64::try_from(counters.WorkingSetSize)
            .map_err(|_| "The resident memory counter exceeded the supported range.".to_owned())?,
        peak_resident_memory_bytes: u64::try_from(counters.PeakWorkingSetSize).map_err(|_| {
            "The peak resident memory counter exceeded the supported range.".to_owned()
        })?,
        uptime_microseconds: uptime_ticks / 10,
        available_memory_bytes: memory.ullAvailPhys,
    })
}

#[cfg(target_os = "windows")]
fn filetime_ticks(value: windows_sys::Win32::Foundation::FILETIME) -> u64 {
    (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
}

#[cfg(target_os = "windows")]
fn unix_filetime_ticks() -> Result<u64, String> {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "The system clock is before the Unix epoch.".to_owned())?;
    let ticks = elapsed
        .as_micros()
        .checked_mul(10)
        .and_then(|value| value.checked_add(u128::from(WINDOWS_TO_UNIX_EPOCH_TICKS)))
        .ok_or_else(|| "The system clock exceeded the supported Windows time range.".to_owned())?;
    u64::try_from(ticks)
        .map_err(|_| "The system clock exceeded the supported Windows time range.".to_owned())
}

#[cfg(target_os = "macos")]
fn macos_process_metrics() -> ProcessMetrics {
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

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "linux")]
fn linux_process_metrics() -> ProcessMetrics {
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
fn parse_first_seconds(contents: &str) -> Result<u64, String> {
    let seconds = contents
        .split_whitespace()
        .next()
        .ok_or_else(|| "The Linux uptime report was empty.".to_owned())?
        .parse::<f64>()
        .map_err(|_| "The Linux uptime report contained an invalid value.".to_owned())?;
    seconds_to_microseconds(seconds)
}

#[cfg(target_os = "linux")]
fn ticks_to_microseconds(ticks: u64, ticks_per_second: u64) -> u64 {
    ((u128::from(ticks) * 1_000_000) / u128::from(ticks_per_second)).min(u128::from(u64::MAX))
        as u64
}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "macos")]
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

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn run_bounded_command(program: &str, arguments: &[&str]) -> Result<String, String> {
    let mut child = Command::new(program)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(3);
    let status = loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("The local system command exceeded its 3-second time limit.".into());
            }
            None => thread::sleep(Duration::from_millis(20)),
        }
    };
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if !status.success() {
        return Err(format!(
            "The local system command exited with status {}.",
            status
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn seconds_to_microseconds(seconds: f64) -> Result<u64, String> {
    if !seconds.is_finite() || seconds < 0.0 || seconds > (u64::MAX as f64 / 1_000_000.0) {
        return Err("The operating system returned an out-of-range time value.".into());
    }
    Ok((seconds * 1_000_000.0).round() as u64)
}

#[cfg(target_os = "macos")]
fn parse_seconds(value: &str) -> Result<f64, String> {
    value
        .parse::<f64>()
        .map_err(|_| "The operating system returned an invalid seconds value.".to_owned())
}

#[derive(Clone, Copy)]
enum EndpointProbeMode {
    ConfigurationOnly,
    OpenStream,
    LimitReached,
}

fn next_probe_mode(requested: bool, started: &mut usize) -> EndpointProbeMode {
    if !requested {
        return EndpointProbeMode::ConfigurationOnly;
    }
    if *started >= MAX_AUDIO_STREAM_PROBES {
        return EndpointProbeMode::LimitReached;
    }
    *started += 1;
    EndpointProbeMode::OpenStream
}

fn enumerate_audio_endpoints(probe_streams: bool) -> AudioEndpointDiagnostics {
    let mut microphone_keys = HashSet::new();
    let mut system_audio_keys = HashSet::new();
    let mut microphone_probes = Vec::new();
    let mut system_audio_probes = Vec::new();
    let mut stream_probe_count = 0;

    for host in hosts() {
        let backend = host.id().to_string();

        if let Ok(devices) = host.input_devices() {
            for device in devices {
                let key = endpoint_key(&backend, &device);
                #[cfg(target_os = "linux")]
                let is_monitor = device
                    .description()
                    .ok()
                    .as_ref()
                    .is_some_and(|description| is_linux_monitor_name(description.name()));
                #[cfg(not(target_os = "linux"))]
                let is_monitor = false;

                let (seen, probes) = if is_monitor {
                    (&mut system_audio_keys, &mut system_audio_probes)
                } else {
                    (&mut microphone_keys, &mut microphone_probes)
                };
                if key.as_ref().is_some_and(|key| !seen.insert(key.clone())) {
                    continue;
                }
                let mode = next_probe_mode(probe_streams, &mut stream_probe_count);
                probes.push(probe_input_endpoint(&device, mode));
            }
        }

        #[cfg(any(target_os = "windows", target_os = "macos"))]
        if let Ok(devices) = host.output_devices() {
            for device in devices {
                if !device.supports_output() {
                    continue;
                }
                #[cfg(target_os = "macos")]
                if device.supports_input() {
                    continue;
                }
                let key = endpoint_key(&backend, &device);
                if key
                    .as_ref()
                    .is_some_and(|key| !system_audio_keys.insert(key.clone()))
                {
                    continue;
                }
                let mode = next_probe_mode(probe_streams, &mut stream_probe_count);
                system_audio_probes.push(probe_output_endpoint(&device, mode));
            }
        }
    }

    let remaining_probe_slots = if probe_streams {
        MAX_AUDIO_STREAM_PROBES.saturating_sub(stream_probe_count)
    } else {
        0
    };
    let application_audio = inspect_application_audio_endpoints(
        probe_streams,
        MAX_AUDIO_STREAM_PROBES,
        remaining_probe_slots,
        AUDIO_STREAM_PROBE_DURATION,
    );
    let application_endpoint_count = application_audio.endpoint_count;
    let application_unavailable_reason = application_audio.unavailable_reason;
    let application_probes = application_audio
        .probes
        .into_iter()
        .map(|result| match result {
            Some(Ok(())) => AudioEndpointProbe {
                state: "stream-opened",
                sample_format: Some("normalized PCM".to_owned()),
                sample_rate_hz: Some(48_000),
                channel_count: Some(2),
                unavailable_reason: None,
            },
            Some(Err(reason)) => AudioEndpointProbe {
                state: "unavailable",
                sample_format: Some("normalized PCM".to_owned()),
                sample_rate_hz: Some(48_000),
                channel_count: Some(2),
                unavailable_reason: Some(reason),
            },
            None => AudioEndpointProbe {
                state: "not-probed",
                sample_format: Some("normalized PCM".to_owned()),
                sample_rate_hz: Some(48_000),
                channel_count: Some(2),
                unavailable_reason: Some(if !probe_streams {
                    "Per-application endpoints were enumerated, but native stream probes require explicit opt-in."
                        .to_owned()
                } else {
                    "The bounded report probe limit was reached; this endpoint was listed but its stream was not opened."
                        .to_owned()
                }),
            },
        })
        .collect();
    let application_truncated_count =
        application_endpoint_count.saturating_sub(MAX_AUDIO_STREAM_PROBES);
    let application_unavailable_reason = application_unavailable_reason.or_else(|| {
        if application_endpoint_count == 0 {
            None
        } else if remaining_probe_slots == 0 {
            Some("No per-application endpoint was opened because the shared diagnostic probe limit was reached.".to_owned())
        } else {
            None
        }
    });
    let application_audio = endpoint_availability(
        application_probes,
        "per-application audio",
        application_truncated_count,
        application_unavailable_reason,
    );

    AudioEndpointDiagnostics {
        probe_scope: if probe_streams {
            "explicit opt-in: supported microphone, system-audio, and per-application endpoints are opened briefly; callback samples are discarded and no audio is saved"
        } else {
            "configuration-only; no audio stream or per-application endpoint discovery was started"
        },
        microphones: endpoint_availability(microphone_probes, "microphone", 0, None),
        system_audio: endpoint_availability(system_audio_probes, "system-audio", 0, None),
        application_audio,
    }
}

fn probe_input_endpoint(device: &cpal::Device, mode: EndpointProbeMode) -> AudioEndpointProbe {
    match device.default_input_config() {
        Ok(config) => endpoint_probe_result(&config, mode, device),
        Err(_) => AudioEndpointProbe {
            state: "unavailable",
            sample_format: None,
            sample_rate_hz: None,
            channel_count: None,
            unavailable_reason: Some(
                "The endpoint did not provide a supported input configuration.".into(),
            ),
        },
    }
}

fn probe_output_endpoint(device: &cpal::Device, mode: EndpointProbeMode) -> AudioEndpointProbe {
    match device.default_output_config() {
        Ok(config) => endpoint_probe_result(&config, mode, device),
        Err(_) => AudioEndpointProbe {
            state: "unavailable",
            sample_format: None,
            sample_rate_hz: None,
            channel_count: None,
            unavailable_reason: Some(
                "The endpoint did not provide a supported output configuration.".into(),
            ),
        },
    }
}

fn endpoint_probe_result(
    config: &cpal::SupportedStreamConfig,
    mode: EndpointProbeMode,
    device: &cpal::Device,
) -> AudioEndpointProbe {
    let state = match mode {
        EndpointProbeMode::ConfigurationOnly => "configuration-ready",
        EndpointProbeMode::LimitReached => "not-probed",
        EndpointProbeMode::OpenStream => match open_discarding_probe_stream(device, config) {
            Ok(()) => "stream-opened",
            Err(_) => "unavailable",
        },
    };
    let unavailable_reason = match state {
        "not-probed" => Some(
            "The bounded report probe limit was reached; this endpoint's configuration is listed but its stream was not opened."
                .into(),
        ),
        "unavailable" => Some(
            "The native audio backend could not open this endpoint for the brief capture probe. Check device availability and operating-system audio permissions."
                .into(),
        ),
        _ => None,
    };
    AudioEndpointProbe {
        state,
        sample_format: Some(format!("{:?}", config.sample_format())),
        sample_rate_hz: Some(config.sample_rate()),
        channel_count: Some(config.channels()),
        unavailable_reason,
    }
}

fn open_discarding_probe_stream(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
) -> Result<(), String> {
    let callback_failed = Arc::new(Mutex::new(false));
    let error_callback_failed = Arc::clone(&callback_failed);
    let stream_config = config.config();
    let stream = device
        .build_input_stream_raw(
            stream_config,
            config.sample_format(),
            |_data: &Data, _info| {},
            move |_error| {
                if let Ok(mut failed) = error_callback_failed.lock() {
                    *failed = true;
                }
            },
            None,
        )
        .map_err(|_| "The native audio backend refused to build the probe stream.".to_owned())?;
    stream
        .play()
        .map_err(|_| "The native audio backend refused to start the probe stream.".to_owned())?;
    thread::sleep(AUDIO_STREAM_PROBE_DURATION);
    drop(stream);
    if callback_failed.lock().map(|failed| *failed).unwrap_or(true) {
        return Err("The native audio probe stream reported an asynchronous error.".into());
    }
    Ok(())
}

fn endpoint_availability(
    probes: Vec<AudioEndpointProbe>,
    kind: &str,
    truncated_count: usize,
    unavailable_reason: Option<String>,
) -> EndpointAvailability {
    let count = probes
        .iter()
        .filter(|probe| matches!(probe.state, "configuration-ready" | "stream-opened"))
        .count();
    EndpointAvailability {
        available: count > 0,
        count,
        truncated_count,
        unavailable_reason: if count == 0 {
            unavailable_reason.or_else(|| {
                Some(if probes.is_empty() {
                    format!("No compatible {kind} endpoints were enumerated on this audio backend.")
                } else if kind == "per-application audio" {
                    "No enumerated per-application endpoint could be opened for a native stream probe."
                        .to_owned()
                } else {
                    format!("No enumerated {kind} endpoint provided a supported audio configuration.")
                })
            })
        } else {
            unavailable_reason
        },
        probes,
    }
}

fn endpoint_key(backend: &str, device: &cpal::Device) -> Option<(String, String)> {
    device
        .id()
        .ok()
        .map(|device_id| (backend.to_owned(), device_id.to_string()))
}

fn hosts() -> Vec<cpal::Host> {
    #[cfg(target_os = "linux")]
    {
        cpal::available_hosts()
            .into_iter()
            .filter_map(|id| cpal::host_from_id(id).ok())
            .collect()
    }
    #[cfg(not(target_os = "linux"))]
    {
        vec![cpal::default_host()]
    }
}

#[cfg(target_os = "linux")]
fn is_linux_monitor_name(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase();
    normalized.contains("monitor") || normalized.contains("loopback")
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn filetime_ticks_combines_both_halves() {
        let value = windows_sys::Win32::Foundation::FILETIME {
            dwLowDateTime: 0x1234_5678,
            dwHighDateTime: 0x0000_0001,
        };
        assert_eq!(filetime_ticks(value), 0x0000_0001_1234_5678);
    }

    #[test]
    fn native_process_metrics_return_positive_values() {
        let snapshot =
            windows_process_snapshot().expect("the local Win32 process queries should work");
        assert!(snapshot.resident_memory_bytes > 0);
        assert!(snapshot.available_memory_bytes > 0);
    }
}
