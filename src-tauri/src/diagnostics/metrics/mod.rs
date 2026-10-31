use serde::Serialize;
#[cfg(target_os = "linux")]
use std::fs;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod command;

#[cfg(target_os = "windows")]
use windows::windows_process_metrics;
#[cfg(target_os = "macos")]
use macos::macos_process_metrics;
#[cfg(target_os = "linux")]
use linux::linux_process_metrics;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProcessMetrics {
    pub(super) uptime_microseconds: DiagnosticMetric,
    pub(super) cpu_time_microseconds: DiagnosticMetric,
    pub(super) resident_memory_bytes: DiagnosticMetric,
    pub(super) peak_resident_memory_bytes: DiagnosticMetric,
    pub(super) available_memory_bytes: DiagnosticMetric,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiagnosticMetric {
    available: bool,
    value: Option<u64>,
    unavailable_reason: Option<String>,
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

pub(super) fn collect_process_metrics() -> ProcessMetrics {
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

pub(crate) fn total_system_memory_bytes() -> Result<u64, String> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

        let mut memory = MEMORYSTATUSEX::default();
        memory.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        // SAFETY: memory is a live, uniquely borrowed MEMORYSTATUSEX whose dwLength
        // states its own size, as GlobalMemoryStatusEx requires.
        if unsafe { GlobalMemoryStatusEx(&mut memory) } == 0 {
            return Err("GlobalMemoryStatusEx did not return the system memory status.".to_owned());
        }
        return Ok(memory.ullTotalPhys);
    }
    #[cfg(target_os = "linux")]
    {
        let contents = fs::read_to_string("/proc/meminfo")
            .map_err(|error| format!("/proc/meminfo could not be read: {error}"))?;
        let kib = contents
            .lines()
            .find_map(|line| {
                let (name, remainder) = line.split_once(':')?;
                (name == "MemTotal")
                    .then(|| remainder.split_whitespace().next())
                    .flatten()
            })
            .ok_or_else(|| "MemTotal was not present in /proc/meminfo.".to_owned())?
            .parse::<u64>()
            .map_err(|_| "MemTotal was not a valid memory value.".to_owned())?;
        return kib
            .checked_mul(1024)
            .ok_or_else(|| "MemTotal exceeded the supported memory range.".to_owned());
    }
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/sbin/sysctl")
            .args(["-n", "hw.memsize"])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .map_err(|error| format!("sysctl could not be started: {error}"))?;
        if !output.status.success() {
            return Err("sysctl did not return the installed memory size.".to_owned());
        }
        return String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<u64>()
            .map_err(|_| "sysctl returned an invalid installed memory size.".to_owned());
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        Err("Total system memory is not implemented for this operating system.".to_owned())
    }
}

fn metric_value(metric: &DiagnosticMetric) -> Option<u64> {
    metric.available.then_some(metric.value).flatten()
}

pub(super) fn metric_string(metric: &DiagnosticMetric) -> String {
    metric_value(metric)
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unavailable".to_owned())
}

pub(super) fn metric_available(metric: &DiagnosticMetric) -> String {
    metric.available.to_string()
}

pub(crate) fn available_system_memory_bytes() -> Result<u64, String> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

        let mut memory = MEMORYSTATUSEX::default();
        memory.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        // SAFETY: memory is a live, uniquely borrowed MEMORYSTATUSEX whose dwLength
        // states its own size, as GlobalMemoryStatusEx requires.
        if unsafe { GlobalMemoryStatusEx(&mut memory) } == 0 {
            return Err("GlobalMemoryStatusEx did not return the system memory status.".to_owned());
        }
        return Ok(memory.ullAvailPhys);
    }
    #[cfg(target_os = "linux")]
    {
        let contents = fs::read_to_string("/proc/meminfo")
            .map_err(|error| format!("/proc/meminfo could not be read: {error}"))?;
        let kib = contents
            .lines()
            .find_map(|line| {
                let (name, remainder) = line.split_once(':')?;
                (name == "MemAvailable")
                    .then(|| remainder.split_whitespace().next())
                    .flatten()
            })
            .ok_or_else(|| "MemAvailable was not present in /proc/meminfo.".to_owned())?
            .parse::<u64>()
            .map_err(|_| "MemAvailable was not a valid memory value.".to_owned())?;
        return kib
            .checked_mul(1024)
            .ok_or_else(|| "MemAvailable exceeded the supported memory range.".to_owned());
    }
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/vm_stat")
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .map_err(|error| format!("vm_stat could not be started: {error}"))?;
        if !output.status.success() {
            return Err("vm_stat did not return the available memory counters.".to_owned());
        }
        let report = String::from_utf8_lossy(&output.stdout);
        let page_size = report
            .lines()
            .next()
            .and_then(|line| line.split("page size of ").nth(1))
            .and_then(|rest| rest.split_whitespace().next())
            .ok_or_else(|| "vm_stat did not report its page size.".to_owned())?
            .parse::<u64>()
            .map_err(|_| "vm_stat returned an invalid page size.".to_owned())?;
        let mut available_pages = 0_u64;
        let mut found = 0_u8;
        for line in report.lines() {
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
            return Err("vm_stat did not expose all available-memory page counters.".to_owned());
        }
        return available_pages
            .checked_mul(page_size)
            .ok_or_else(|| "vm_stat returned an out-of-range available memory value.".to_owned());
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        Err("Available system memory is not implemented for this operating system.".to_owned())
    }
}
