mod backup;
mod crypto;
mod discovery;
mod helpers;
mod info;
mod lifecycle;
mod maintenance;
mod sanitize;
pub(crate) mod save;
mod selection;

use crate::core::cli::{
    resolve_path, CliContext, CliError, CliOutput, CliResult, ParsedArguments,
};

pub fn run_archive_command(
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    context: &CliContext,
) -> CliResult<i32> {
    if action == "discover" || action == "list" {
        return discovery::run(&args, output);
    }
    let path = args
        .positionals
        .first()
        .map(String::as_str)
        .map(resolve_path)
        .or_else(|| {
            if action == "unlock" || action == "info" || action == "open" {
                context.archive_path.clone()
            } else {
                None
            }
        });
    let Some(path) = path else {
        return Err(CliError(format!("archive {action} requires a file path.")).into());
    };
    match action {
        "init" => lifecycle::init(&path, &args, output),
        "rename" => lifecycle::rename(&path, &args, output, context),
        "encrypt" => crypto::encrypt(&path, &args, output, context),
        "change-passphrase" => crypto::change_passphrase(&path, &args, output, context),
        "unlock" => info::unlock(&path, &args, output, context),
        "backup" | "copy" => backup::backup(&path, &args, output, context),
        "recover" => backup::recover(&path, &args, output, context),
        "compact" => maintenance::compact(&path, &args, output, context),
        "backfill-indexes" => maintenance::backfill(&path, &args, output, context),
        "purge-trash" => maintenance::purge_trash(&path, &args, output, context),
        "repair" => maintenance::repair(&path, &args, output, context),
        "rebuild-index" => maintenance::rebuild_index(&path, &args, output, context),
        "sanitize" => sanitize::run(&path, &args, output, context),
        "info" | "open" | "verify" => info::run(action, &path, &args, output, context),
        _ => Err(CliError(format!(
            "archive {action} is not implemented in the Rust CLI yet."
        ))
        .into()),
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_maintenance;
