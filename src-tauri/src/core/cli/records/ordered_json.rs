use crate::core::format::{record_type_name, ArchiveRecord};
use serde::ser::{Serialize, SerializeMap, Serializer};

// CLI lists mirror the TypeScript record order (id, type, revision, fields) so
// order-insensitive parity comparisons can sort equivalent records alike.
struct OrderedRecord<'a>(&'a ArchiveRecord);

impl Serialize for OrderedRecord<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let record = self.0;
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("id", &record.id)?;
        map.serialize_entry(
            "type",
            record
                .field("type")
                .unwrap_or_else(|| record_type_name(record.record_type)),
        )?;
        map.serialize_entry("revision", &record.revision.to_string())?;
        for (name, value) in &record.fields {
            if name == "type" {
                continue;
            }
            map.serialize_entry(name, value)?;
        }
        map.end()
    }
}

pub(crate) fn records_json(records: &[ArchiveRecord]) -> String {
    let rows: Vec<OrderedRecord<'_>> = records.iter().map(OrderedRecord).collect();
    serde_json::to_string_pretty(&rows).unwrap_or_else(|_| "null".to_owned())
}
