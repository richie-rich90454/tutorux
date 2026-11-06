use std::{
    io::Read,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const MAX_COMMAND_OUTPUT_BYTES: usize = 1024 * 1024;

pub(super) fn run_bounded_command(program: &str, arguments: &[&str]) -> Result<String, String> {
    let mut child = Command::new(program)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "The local system command produced no output pipe.".to_owned())?;
    let reader = thread::spawn(move || {
        let mut output = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if output.len() < MAX_COMMAND_OUTPUT_BYTES {
                        let remaining = MAX_COMMAND_OUTPUT_BYTES - output.len();
                        output.extend_from_slice(&buffer[..read.min(remaining)]);
                    }
                }
            }
        }
        output
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    let status = loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err("The local system command exceeded its 3-second time limit.".into());
            }
            None => thread::sleep(Duration::from_millis(20)),
        }
    };
    let output = reader
        .join()
        .map_err(|_| "The local system command output reader failed.".to_owned())?;
    if !status.success() {
        return Err(format!(
            "The local system command exited with status {}.",
            status
        ));
    }
    Ok(String::from_utf8_lossy(&output).into_owned())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) fn seconds_to_microseconds(seconds: f64) -> Result<u64, String> {
    if !seconds.is_finite() || seconds < 0.0 || seconds > (u64::MAX as f64 / 1_000_000.0) {
        return Err("The operating system returned an out-of-range time value.".into());
    }
    Ok((seconds * 1_000_000.0).round() as u64)
}

#[cfg(test)]
mod tests {
    use super::{run_bounded_command, MAX_COMMAND_OUTPUT_BYTES};
    use std::path::Path;

    #[cfg(windows)]
    fn print_file(path: &Path) -> (String, Vec<String>) {
        (
            "cmd".to_owned(),
            vec![
                "/C".to_owned(),
                "type".to_owned(),
                path.to_string_lossy().into_owned(),
            ],
        )
    }

    #[cfg(not(windows))]
    fn print_file(path: &Path) -> (String, Vec<String>) {
        ("cat".to_owned(), vec![path.to_string_lossy().into_owned()])
    }

    #[test]
    fn drains_large_output_without_blocking_and_truncates_at_the_limit() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("output.txt");
        let (program, arguments) = print_file(&path);
        let arguments = arguments.iter().map(String::as_str).collect::<Vec<_>>();

        std::fs::write(&path, vec![b'a'; 96 * 1024]).expect("write command output");
        let output = run_bounded_command(&program, &arguments).expect("drain 96 KiB of output");
        assert_eq!(output.len(), 96 * 1024);

        std::fs::write(&path, vec![b'a'; 2 * 1024 * 1024]).expect("write oversized output");
        let output = run_bounded_command(&program, &arguments).expect("drain oversized output");
        assert_eq!(output.len(), MAX_COMMAND_OUTPUT_BYTES);
    }
}
