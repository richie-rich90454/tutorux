use std::path::Path;

use serde_json::json;

use crate::core::archive::ArchiveSnapshot;
use crate::core::cli::{
    emit, open_archive, CliContext, CliError, CliOutput, CliResult, ParsedArguments,
};
use crate::core::error::CoreError;
use crate::core::maintenance::{change_passphrase as rekey, enable_encryption};

use super::helpers::{count_history, passphrase_from_env};
use super::save;

pub(super) fn encrypt(
    path: &Path,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    context: &CliContext,
) -> CliResult<i32> {
    let passphrase = match passphrase_from_env(args, "new-passphrase-env")? {
        Some(passphrase) => passphrase,
        None => context.passphrase().map(str::to_owned).ok_or_else(|| {
            CliError(
                "archive encrypt requires --new-passphrase-env <name> or --passphrase-env <name>."
                    .to_owned(),
            )
        })?,
    };
    let snapshot = open_archive(path, context.passphrase())?;
    if snapshot.encrypted() {
        return Err(CliError("This archive is already encrypted.".to_owned()).into());
    }
    let previous_generation = snapshot.commit.generation;
    let history = count_history(&snapshot)?;
    let bytes = enable_encryption(&snapshot, &passphrase)?;
    let next = ArchiveSnapshot::open_bytes(bytes.clone())?;
    let unlocked = next.unlock(&passphrase)?;
    unlocked.verify()?;
    let generation = unlocked.commit.generation;
    drop(unlocked);
    drop(next);
    drop(snapshot);
    save::save_bytes(path, &bytes)?;
    let value = json!({
        "path": path.display().to_string(),
        "previous_generation": previous_generation.to_string(),
        "generation": generation.to_string(),
        "encrypted": true,
        "verified": true,
        "preserved_historical_revisions": history,
    });
    emit(
        output,
        value,
        &format!(
            "Encrypted and verified {} while preserving {} historical record revisions.",
            path.display(),
            history
        ),
        args.json(),
    );
    Ok(0)
}

pub(super) fn change_passphrase(
    path: &Path,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    context: &CliContext,
) -> CliResult<i32> {
    let new_passphrase = passphrase_from_env(args, "new-passphrase-env")?
        .ok_or_else(|| CliError("--new-passphrase-env is required.".to_owned()))?;
    let current_passphrase = context.passphrase().ok_or_else(|| {
        CliError("--passphrase-env is required to change the passphrase.".to_owned())
    })?;
    if new_passphrase == current_passphrase {
        return Err(CliError(
            "Choose a different new passphrase from the current passphrase.".to_owned(),
        )
        .into());
    }
    if new_passphrase.as_bytes().len() < 12 {
        return Err(CoreError::new(
            "archive_passphrase_too_short",
            "Archive passphrases must contain at least 12 UTF-8 bytes.",
        )
        .into());
    }
    let snapshot = open_archive(path, Some(current_passphrase))?;
    if !snapshot.encrypted() {
        return Err(CliError("This archive is not encrypted.".to_owned()).into());
    }
    let previous_generation = snapshot.commit.generation;
    let bytes = rekey(&snapshot, &new_passphrase)?;
    let next = ArchiveSnapshot::open_bytes(bytes.clone())?;
    let unlocked = next.unlock(&new_passphrase)?;
    unlocked.verify()?;
    let generation = unlocked.commit.generation;
    drop(unlocked);
    drop(next);
    drop(snapshot);
    save::save_bytes(path, &bytes)?;
    let value = json!({
        "path": path.display().to_string(),
        "previous_generation": previous_generation.to_string(),
        "generation": generation.to_string(),
        "encrypted": true,
        "verified": true,
        "passphrase_changed": true,
    });
    emit(
        output,
        value,
        &format!(
            "Passphrase changed and verified for {} at generation {}.",
            path.display(),
            generation
        ),
        args.json(),
    );
    Ok(0)
}
