use super::*;

#[path = "package_export.rs"]
mod package_export;
#[path = "package_import.rs"]
mod package_import;
#[path = "package_journal.rs"]
mod package_journal;

pub(crate) use package_export::export_session_package;
pub(crate) use package_import::import_session_package;

pub(crate) fn run_session_export(
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
) -> CliResult<i32> {
    export_session_package(snapshot, args, output, path)
}

pub(crate) fn run_session_import(
    snapshot: &ArchiveSnapshot,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    import_session_package(snapshot, args, output, path, context)
}

pub(crate) fn same_path_public(left: &std::path::Path, right: &std::path::Path) -> bool {
    let left = std::fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = std::fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    if cfg!(windows) {
        left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
    } else {
        left == right
    }
}
