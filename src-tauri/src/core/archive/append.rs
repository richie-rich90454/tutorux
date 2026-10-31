use crate::core::error::{err, Result};
use crate::core::format::{ArchiveRecord, RecordType};

use super::append_prepare::prepare_transaction;
use super::append_write::write_transaction;
use super::ArchiveSnapshot;

impl ArchiveSnapshot {
    pub fn append_records(&self, changes: &[ArchiveRecord]) -> Result<ArchiveSnapshot> {
        if self.locked() {
            return err("archive_locked", "Unlock this archive before editing it.");
        }
        if changes.is_empty() {
            return Ok(self.clone());
        }
        if self.encrypted()
            && changes.iter().any(|record| {
                record.record_type == RecordType::ENCRYPTION
                    && record.id.eq_ignore_ascii_case(&self.header.id)
            })
        {
            return err(
                "archive_passphrase_change_unsupported",
                "Passphrase changes must use the archive re-keying operation so prior key envelopes are removed.",
            );
        }
        if self.source.size() != self.published_end_offset {
            return err(
                "archive_recovery_required",
                "This archive has uncommitted trailing data. Review or recover it before making changes.",
            );
        }
        let prepared = prepare_transaction(self, changes)?;
        write_transaction(self, prepared)
    }
}
