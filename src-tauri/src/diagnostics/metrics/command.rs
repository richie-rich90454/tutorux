use std::{
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub(super) fn run_bounded_command(program: &str, arguments: &[&str]) -> Result<String, String> {
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

pub(super) fn seconds_to_microseconds(seconds: f64) -> Result<u64, String> {
    if !seconds.is_finite() || seconds < 0.0 || seconds > (u64::MAX as f64 / 1_000_000.0) {
        return Err("The operating system returned an out-of-range time value.".into());
    }
    Ok((seconds * 1_000_000.0).round() as u64)
}
