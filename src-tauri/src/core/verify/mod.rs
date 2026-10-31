use std::collections::BTreeMap;

use crate::core::archive::ArchiveRecord;
use crate::core::index::primary_index_key;

mod assets;
mod full;
mod guide;
mod helpers;
mod history;
mod references;
mod secondary;
mod tree;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FullVerificationResult {
    pub generation: u64,
    pub current_records: usize,
    pub live_records: usize,
    pub deleted_records: usize,
    pub index_entries: usize,
    pub records_checked: usize,
    pub index_pages_checked: usize,
    pub valid: bool,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryVerificationResult {
    pub current: FullVerificationResult,
    pub historical_revisions: usize,
    pub verified_commits: usize,
    pub verified_generation_records: usize,
}

type SpanMap = BTreeMap<u64, (u64, String)>;

pub use full::verify_full;
pub use history::verify_history;

pub(crate) struct VerificationLookup<'a> {
    pub(crate) live: &'a BTreeMap<String, ArchiveRecord>,
    pub(crate) revisions: &'a BTreeMap<String, Vec<ArchiveRecord>>,
    pub(crate) any_live: bool,
}

impl<'a> VerificationLookup<'a> {
    pub(crate) fn get(&self, record_type: u16, id: &str) -> Option<&'a ArchiveRecord> {
        let key = primary_index_key(record_type, id);
        if self.any_live {
            self.revisions
                .get(&key)?
                .iter()
                .find(|record| !record.deleted())
        } else {
            self.live.get(&key)
        }
    }

    pub(crate) fn live(&self, record_type: u16, id: &str) -> Option<&'a ArchiveRecord> {
        self.live.get(&primary_index_key(record_type, id))
    }
}

pub(crate) fn add_span(
    spans: &mut SpanMap,
    issues: &mut Vec<String>,
    offset: u64,
    end: u64,
    label: String,
) {
    match spans.get(&offset) {
        None => {
            spans.insert(offset, (end, label));
        }
        Some((existing_end, existing_label)) if *existing_end != end => {
            issues.push(format!(
                "One archive offset resolves to inconsistent frame spans: {existing_label} and {label}."
            ));
        }
        Some(_) => {}
    }
}

#[cfg(test)]
mod tests;
