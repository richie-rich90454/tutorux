use std::io::{self, BufRead, BufWriter, Write};

use crate::archive_lock_support::{ArchiveLock, LockMode};

pub(crate) fn archive_lock(mut arguments: impl Iterator<Item = String>) -> Result<(), String> {
    let mode = match arguments.next().as_deref() {
        Some("--shared") => LockMode::Shared,
        Some("--exclusive") => LockMode::Exclusive,
        _ => return Err("use archive-lock --shared|--exclusive <archive-path>".to_owned()),
    };
    let path = arguments
        .next()
        .ok_or_else(|| "an archive path is required".to_owned())?;
    if arguments.next().is_some() {
        return Err("archive-lock accepts one archive path".to_owned());
    }

    let mut lock = ArchiveLock::try_acquire(std::path::Path::new(&path), mode)?;
    let stdout = io::stdout();
    let mut output = BufWriter::new(stdout.lock());
    writeln!(output, "LOCKED")
        .and_then(|()| output.flush())
        .map_err(|error| format!("could not acknowledge archive lock: {error}"))?;

    for command in io::stdin().lock().lines() {
        let command =
            command.map_err(|error| format!("could not read archive-lock command: {error}"))?;
        match command.as_str() {
            "upgrade" => match lock.try_upgrade() {
                Ok(()) => writeln!(output, "EXCLUSIVE"),
                Err(error) => writeln!(output, "ERROR {error}"),
            },
            "downgrade" => match lock.downgrade() {
                Ok(()) => writeln!(output, "SHARED"),
                Err(error) => writeln!(output, "ERROR {error}"),
            },
            "adopt-replacement" => match lock.adopt_replacement_file() {
                Ok(()) => writeln!(output, "REPLACEMENT_ADOPTED"),
                Err(error) => writeln!(output, "ERROR {error}"),
            },
            "release" => {
                lock.release()?;
                writeln!(output, "RELEASED")
            }
            _ if command.starts_with("prepare-replacement ") => {
                let encoded_path = command
                    .strip_prefix("prepare-replacement ")
                    .unwrap_or_default();
                match serde_json::from_str::<String>(encoded_path) {
                    Ok(path) => match lock.prepare_replacement_file(std::path::Path::new(&path)) {
                        Ok(()) => writeln!(output, "REPLACEMENT_READY"),
                        Err(error) => writeln!(output, "ERROR {error}"),
                    },
                    Err(error) => writeln!(output, "ERROR invalid replacement path: {error}"),
                }
            }
            _ => writeln!(output, "ERROR unknown archive-lock command"),
        }
        .and_then(|()| output.flush())
        .map_err(|error| format!("could not respond to archive-lock command: {error}"))?;
    }
    Ok(())
}
