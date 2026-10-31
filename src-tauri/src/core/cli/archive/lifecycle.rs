use std::path::Path;

use serde_json::json;

use crate::core::archive::{create_archive_bytes, create_encrypted_archive_bytes, now_us};
use crate::core::cli::{
    emit, open_archive, require_unlocked, CliContext, CliError, CliOutput, CliResult,
    ParsedArguments,
};
use crate::core::format::{ArchiveRecord, RecordType};

use super::helpers::{file_stem, passphrase_from_env};
use super::save;

pub(super) fn init(
    path: &Path,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
) -> CliResult<i32> {
    let name = args.required_option("name")?.to_owned();
    let description = args.option("description").unwrap_or("").to_owned();
    let passphrase = passphrase_from_env(args, "new-passphrase-env")?;
    let bytes = match passphrase.as_deref() {
        Some(passphrase) => {
            create_encrypted_archive_bytes(&name, &description, passphrase, now_us())?
        }
        None => create_archive_bytes(&name, &description, now_us())?,
    };
    save::write_new_archive(path, &bytes)?;
    let created = json!({
        "path": path.display().to_string(),
        "name": name,
        "bytes": bytes.len(),
        "created": true,
    });
    emit(
        output,
        created,
        &format!("{} created ({} bytes).", file_stem(path), bytes.len()),
        args.json(),
    );
    Ok(0)
}

pub(super) fn rename(
    path: &Path,
    args: &ParsedArguments,
    output: &mut dyn CliOutput,
    context: &CliContext,
) -> CliResult<i32> {
    let name = args.required_option("name")?.to_owned();
    let snapshot = require_unlocked(&open_archive(path, context.passphrase())?)?;
    let manifest = snapshot
        .get_record(RecordType::SETTINGS, &snapshot.header.id)?
        .ok_or_else(|| CliError("Archive manifest is missing.".to_owned()))?;
    let mut fields = manifest.fields.clone();
    fields.insert("display_name".to_owned(), name.clone());
    let updated = ArchiveRecord {
        fields,
        ..manifest
    };
    let next = snapshot.append_records(&[updated])?;
    let bytes = super::helpers::read_bytes(&next)?;
    drop(next);
    drop(snapshot);
    save::save_bytes(path, &bytes)?;
    emit(
        output,
        json!({"name": name, "status": "updated"}),
        "Archive display name updated.",
        args.json(),
    );
    Ok(0)
}
