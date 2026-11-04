use crate::core::format::ArchiveRecord;
use crate::core::verify::guide::{
    parse_asset_image_reference, parse_bounded_count, parse_inline_sources,
};

use super::types::{field, lower, parse_uuid};

pub(crate) fn private_annotation(record: &ArchiveRecord) -> bool {
    for (name, raw_value) in &record.fields {
        let field_name = lower(name);
        if !field_name.contains("private")
            && !field_name.contains("privacy")
            && !field_name.contains("visibility")
        {
            continue;
        }
        let value = lower(raw_value);
        if ["true", "yes", "1", "private", "restricted"].contains(&value.as_str()) {
            return true;
        }
    }
    false
}

pub(crate) fn recording_asset(record: &ArchiveRecord) -> bool {
    let role = lower(&field(record, "record_role"));
    let mime = lower(&field(record, "mime_type"));
    role == "recording-take"
        || role.contains("audio")
        || role.contains("waveform")
        || role.contains("seek-index")
        || !field(record, "capture_source").is_empty()
        || mime.starts_with("audio/")
}

pub(crate) fn guide_references(record: &ArchiveRecord) -> Option<(Vec<String>, Vec<String>)> {
    let mut sources = Vec::new();
    let mut images = Vec::new();
    let section_count = parse_bounded_count(record, "section_count", "Guide section").ok()?;
    for section_index in 0..section_count {
        let prefix = format!("section.{section_index}.");
        let block_count =
            parse_bounded_count(record, &format!("{prefix}block_count"), "Guide block").ok()?;
        for block_index in 0..block_count {
            let block_prefix = format!("{prefix}block.{block_index}.");
            let text = field(record, &format!("{block_prefix}text"));
            let mut raw_sources: Vec<String> = field(record, &format!("{block_prefix}source_ids"))
                .split(|character: char| {
                    character.is_whitespace() || character == ',' || character == ';'
                })
                .map(|id| id.trim().to_owned())
                .filter(|id| !id.is_empty())
                .collect();
            let (inline, valid) = parse_inline_sources(&text);
            if !valid {
                return None;
            }
            raw_sources.extend(inline);
            for id in raw_sources {
                sources.push(parse_uuid(&id)?);
            }
            let kind = field(record, &format!("{block_prefix}kind"));
            if kind == "image" || kind == "figure" || text.starts_with("![") {
                let asset = parse_asset_image_reference(&text)?;
                images.push(asset.clone());
                sources.push(asset);
            }
        }
    }
    sources.sort();
    sources.dedup();
    images.sort();
    images.dedup();
    Some((sources, images))
}

#[cfg(test)]
mod tests {
    use super::guide_references;
    use crate::core::archive::RecordType;
    use crate::core::format::ArchiveRecord;

    fn guide(fields: [(&str, &str); 3]) -> ArchiveRecord {
        ArchiveRecord::new(RecordType::GUIDE, crate::core::archive::new_uuid(), fields)
    }

    #[test]
    fn inline_source_parser_does_not_split_a_multibyte_character() {
        let record = guide([
            ("section_count", "1"),
            ("section.0.block_count", "1"),
            (
                "section.0.block.0.text",
                "[[source:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa€]]",
            ),
        ]);
        assert!(guide_references(&record).is_none());
    }

    #[test]
    fn oversized_section_and_block_counts_are_rejected_quickly() {
        let maximum = u64::MAX.to_string();
        let record = guide([
            ("section_count", "1"),
            ("section.0.block_count", maximum.as_str()),
            ("section.0.block.0.text", ""),
        ]);
        assert!(guide_references(&record).is_none());
        let record = guide([
            ("section_count", maximum.as_str()),
            ("section.0.block_count", "0"),
            ("section.0.block.0.text", ""),
        ]);
        assert!(guide_references(&record).is_none());
    }
}
