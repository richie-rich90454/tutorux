use super::{available_metric, unavailable_metric, ProcessMetrics};

const WINDOWS_TO_UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;

pub(super) fn windows_process_metrics() -> ProcessMetrics {
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

struct WindowsProcessSnapshot {
    cpu_time_microseconds: u64,
    resident_memory_bytes: u64,
    peak_resident_memory_bytes: u64,
    uptime_microseconds: u64,
    available_memory_bytes: u64,
}

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

fn filetime_ticks(value: windows_sys::Win32::Foundation::FILETIME) -> u64 {
    (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
}

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

#[cfg(test)]
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
