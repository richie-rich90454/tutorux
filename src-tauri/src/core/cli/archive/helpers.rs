use std::path::{Path, PathBuf};

use crate::core::archive::ArchiveSnapshot;
use crate::core::cli::{CliError, CliResult, ParsedArguments};
use crate::core::error::Result;

pub(super) fn environment_name<'a>(
    args: &'a ParsedArguments,
    name: &str,
) -> CliResult<Option<&'a str>> {
    let Some(environment) = args.option(name) else {
        if args.flag(name) {
            return Err(CliError(format!(
                "--{name} requires an environment variable name."
            ))
            .into());
        }
        return Ok(None);
    };
    let mut bytes = environment.bytes();
    let valid = match bytes.next() {
        Some(first) if first.is_ascii_alphabetic() || first == b'_' => {
            bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        }
        _ => false,
    };
    if !valid {
        return Err(CliError(format!(
            "--{name} requires a valid environment variable name."
        ))
        .into());
    }
    Ok(Some(environment))
}

pub(super) fn passphrase_from_env(
    args: &ParsedArguments,
    name: &str,
) -> CliResult<Option<String>> {
    let Some(environment) = environment_name(args, name)? else {
        return Ok(None);
    };
    match std::env::var(environment) {
        Ok(value) => Ok(Some(value)),
        Err(_) => Err(CliError(format!(
            "The {} environment variable is not set.",
            if name == "new-passphrase-env" {
                "new archive passphrase"
            } else {
                "archive passphrase"
            }
        ))
        .into()),
    }
}

pub(super) fn file_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("archive")
        .to_owned()
}

pub(super) fn counter(value: Option<&str>) -> String {
    value
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
        .to_string()
}

pub(super) fn is_writable(path: &Path) -> bool {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .is_ok()
}

fn canonical(path: &Path) -> PathBuf {
    if let Ok(value) = std::fs::canonicalize(path) {
        return value;
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    match std::fs::canonicalize(parent) {
        Ok(parent) => match path.file_name() {
            Some(name) => parent.join(name),
            None => path.to_path_buf(),
        },
        Err(_) => path.to_path_buf(),
    }
}

pub(super) fn same_path(left: &Path, right: &Path) -> bool {
    let left = canonical(left);
    let right = canonical(right);
    if cfg!(windows) {
        left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
    } else {
        left == right
    }
}

pub(super) fn read_bytes(snapshot: &ArchiveSnapshot) -> Result<Vec<u8>> {
    snapshot.source.read(0, snapshot.source.size() as usize)
}

fn revision_counts(snapshot: &ArchiveSnapshot) -> Result<(usize, usize)> {
    let mut total = 0usize;
    let mut historical = 0usize;
    for key in snapshot.all_index_entries().keys() {
        if key.matches(':').count() != 1 {
            continue;
        }
        let Some((type_name, id)) = key.split_once(':') else {
            continue;
        };
        if id.len() != 36 {
            continue;
        }
        let Some(record_type) = crate::core::format::record_type_from_name(type_name) else {
            continue;
        };
        let revisions = snapshot
            .get_record_history(record_type, id, 10_000)?
            .len();
        total += revisions;
        historical += revisions.saturating_sub(1);
    }
    Ok((total, historical))
}

pub(super) fn count_history(snapshot: &ArchiveSnapshot) -> Result<usize> {
    Ok(revision_counts(snapshot)?.0)
}

pub(super) fn count_historical_revisions(snapshot: &ArchiveSnapshot) -> Result<usize> {
    Ok(revision_counts(snapshot)?.1)
}
