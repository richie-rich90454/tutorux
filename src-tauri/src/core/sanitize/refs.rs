use crate::core::format::ArchiveRecord;

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
    let section_count: u64 = field(record, "section_count").parse().ok()?;
    for section_index in 0..section_count {
        let prefix = format!("section.{section_index}.");
        let block_count: u64 = field(record, &format!("{prefix}block_count"))
            .parse()
            .ok()?;
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
            let (inline, valid) = inline_sources(&text)?;
            if !valid {
                return None;
            }
            raw_sources.extend(inline);
            for id in raw_sources {
                sources.push(parse_uuid(&id)?);
            }
            let kind = field(record, &format!("{block_prefix}kind"));
            if kind == "image" || kind == "figure" || text.starts_with("![") {
                let asset = asset_image_reference(&text)?;
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

fn inline_sources(text: &str) -> Option<(Vec<String>, bool)> {
    let lower = text.to_lowercase();
    let mut ids = Vec::new();
    let mut cursor = 0usize;
    while let Some(start) = lower[cursor..].find("[[source:") {
        let start = cursor + start;
        let id_start = start + "[[source:".len();
        let Some(id_end) = id_start.checked_add(36) else {
            return None;
        };
        if id_end + 2 > lower.len() || &lower[id_end..id_end + 2] != "]]" {
            return None;
        }
        let id = parse_uuid(&lower[id_start..id_end])?;
        ids.push(id);
        cursor = id_end + 2;
    }
    Some((ids, true))
}

fn asset_image_reference(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let bytes = lower.as_bytes();
    if !lower.starts_with("![") {
        return None;
    }
    let mut index = 2usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b']' => break,
            _ => index += 1,
        }
    }
    if index >= bytes.len() {
        return None;
    }
    let rest = lower[index + 1..].strip_prefix("(asset:")?;
    let id = rest.strip_suffix(')')?;
    parse_uuid(id)
}
