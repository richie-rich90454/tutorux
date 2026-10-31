mod apply;
mod plan;
mod plan_assets;
mod refs;
mod types;

pub use plan::plan_sanitized_copy;
pub use types::{
    SanitizedCopyOptions, SanitizedCopyPlan, SanitizedCopyResult, SanitizedCopySummary,
};

use crate::core::archive::{
    create_archive_bytes, create_encrypted_archive_bytes, ArchiveRecord, ArchiveSnapshot,
};
use crate::core::error::{err, Result};

use apply::sanitize_record;
use plan::{make_plan, normalize_options, COPY_TYPES};

pub fn preview_sanitized_copy(
    snapshot: &ArchiveSnapshot,
    options: &SanitizedCopyOptions,
) -> Result<SanitizedCopySummary> {
    let normalized = normalize_options(options)?;
    Ok(make_plan(snapshot, &normalized)?.summary)
}

pub fn create_sanitized_copy(
    snapshot: &ArchiveSnapshot,
    options: &SanitizedCopyOptions,
    expected: &SanitizedCopySummary,
    destination_passphrase: Option<&str>,
) -> Result<SanitizedCopyResult> {
    let normalized = normalize_options(options)?;
    let plan = make_plan(snapshot, &normalized)?;
    if plan.summary.source_generation != expected.source_generation {
        return err(
            "sanitized_copy_source_changed",
            "The source archive changed after preview; review a new preview.",
        );
    }
    if plan.summary.selection_fingerprint != expected.selection_fingerprint {
        return err(
            "sanitized_copy_selection_changed",
            "The selection differs from the reviewed preview; review it again.",
        );
    }
    if (snapshot.encrypted() || options.include_credentials) && destination_passphrase.is_none() {
        return err(
            "sanitized_copy_encryption_required",
            "An encrypted output passphrase is required to preserve source protection or include credentials.",
        );
    }
    let manifest = snapshot.get_manifest()?;
    let display_name = format!("Sanitized copy of {}", manifest.display_name);
    let description = "Created from an explicitly reviewed privacy selection.";
    let initial_bytes = match destination_passphrase {
        Some(passphrase) => create_encrypted_archive_bytes(
            &display_name,
            description,
            passphrase,
            crate::core::archive::now_us(),
        )?,
        None => create_archive_bytes(&display_name, description, crate::core::archive::now_us())?,
    };
    let initial = ArchiveSnapshot::open_bytes(initial_bytes)?;
    let mut output = match destination_passphrase {
        Some(passphrase) => initial.unlock(passphrase)?,
        None => initial,
    };
    let mut batch: Vec<ArchiveRecord> = Vec::new();
    let mut batch_bytes = 0usize;
    for record_type in COPY_TYPES {
        for id in plan.kept(record_type) {
            let Some(mut current) = snapshot.get_record(record_type, id)? else {
                return err(
                    "sanitized_copy_record_missing",
                    "A selected record disappeared after preview.",
                );
            };
            if current.field("_deleted") == Some("true") {
                return err(
                    "sanitized_copy_record_missing",
                    "A selected record disappeared after preview.",
                );
            }
            if let Some(updated) =
                plan.metadata_updates
                    .get(&format!("{}:{}", record_type, id.to_lowercase()))
            {
                current.fields = updated.fields.clone();
            }
            let record = sanitize_record(&current, &plan, &normalized, &plan.source_manifest_id);
            batch_bytes += record.blob.len();
            batch.push(record);
            if batch.len() >= 32 || batch_bytes >= 16 * 1024 * 1024 {
                output = output.append_records(&batch)?;
                batch.clear();
                batch_bytes = 0;
            }
        }
    }
    if !batch.is_empty() {
        output = output.append_records(&batch)?;
    }
    output.verify()?;
    Ok(SanitizedCopyResult {
        summary: plan.summary,
        snapshot: output,
    })
}

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_extra;
