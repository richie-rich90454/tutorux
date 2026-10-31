use super::*;

#[path = "guide_templates.rs"]
mod guide_templates;
pub(crate) use guide_templates::*;

#[path = "guide_source.rs"]
mod guide_source;
pub(crate) use guide_source::*;

#[path = "guide_render.rs"]
mod guide_render;
pub(crate) use guide_render::*;

#[path = "guide_generate.rs"]
mod guide_generate;
pub(crate) use guide_generate::*;

#[path = "guide_export.rs"]
mod guide_export;
pub(crate) use guide_export::*;

#[path = "guide_record.rs"]
mod guide_record;
pub(crate) use guide_record::*;

// ---------------------------------------------------------------------------
// Guides
// ---------------------------------------------------------------------------

pub(crate) const GUIDE_BLOCK_KINDS: [&str; 12] = [
    "paragraph",
    "list-item",
    "quote",
    "code",
    "equation",
    "table",
    "image",
    "figure",
    "example",
    "instruction",
    "recommendation",
    "worked-example",
];

pub(crate) const GUIDE_BLOCK_ORIGINS: [&str; 7] = [
    "tutor-authored",
    "session-evidence",
    "ai-generated",
    "human-edited",
    "uncertain",
    "system-generated",
    "unknown",
];

#[derive(Clone)]
pub(crate) struct GuideBlock {
    pub(crate) kind: String,
    pub(crate) text: String,
    pub(crate) source_ids: Vec<String>,
    pub(crate) stale: bool,
    pub(crate) origin: String,
}

#[derive(Clone)]
pub(crate) struct GuideSection {
    pub(crate) id: String,
    pub(crate) heading: String,
    pub(crate) blocks: Vec<GuideBlock>,
}

#[derive(Clone)]
pub(crate) struct GuideDraft {
    pub(crate) title: String,
    pub(crate) session_id: String,
    pub(crate) entry_id: String,
    pub(crate) template_id: String,
    pub(crate) sections: Vec<GuideSection>,
}

pub(crate) struct GuideScope {
    pub(crate) session: Option<ArchiveRecord>,
    pub(crate) entry: Option<ArchiveRecord>,
    pub(crate) records: Vec<ArchiveRecord>,
}

pub(crate) fn guide_sections(record: &ArchiveRecord) -> Vec<GuideSection> {
    let count = record
        .field("section_count")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut sections = Vec::new();
    for index in 0..count {
        let prefix = format!("section.{index}.");
        let block_count = record
            .field(&format!("{prefix}block_count"))
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let mut blocks = Vec::new();
        for block_index in 0..block_count {
            let block_prefix = format!("{prefix}block.{block_index}.");
            let origin = record
                .field(&format!("{block_prefix}origin"))
                .filter(|value| !value.is_empty())
                .unwrap_or("unknown");
            blocks.push(GuideBlock {
                kind: record
                    .field(&format!("{block_prefix}kind"))
                    .unwrap_or("")
                    .to_owned(),
                text: record
                    .field(&format!("{block_prefix}text"))
                    .unwrap_or("")
                    .to_owned(),
                source_ids: parse_stored_source_ids(
                    record
                        .field(&format!("{block_prefix}source_ids"))
                        .unwrap_or(""),
                ),
                stale: record.field(&format!("{block_prefix}stale")) == Some("true"),
                origin: origin.to_owned(),
            });
        }
        sections.push(GuideSection {
            id: record
                .field(&format!("{prefix}id"))
                .unwrap_or("")
                .to_owned(),
            heading: record
                .field(&format!("{prefix}heading"))
                .unwrap_or("")
                .to_owned(),
            blocks,
        });
    }
    sections
}

fn parse_stored_source_ids(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_lowercase)
        .collect()
}

pub(crate) fn set_guide_sections(record: &mut ArchiveRecord, sections: &[GuideSection]) {
    let keys: Vec<String> = record
        .fields
        .keys()
        .filter(|key| is_guide_field_key(key))
        .cloned()
        .collect();
    for key in keys {
        record.fields.remove(&key);
    }
    record
        .fields
        .insert("section_count".to_owned(), sections.len().to_string());
    record.fields.insert(
        "stale_block_count".to_owned(),
        sections
            .iter()
            .flat_map(|section| section.blocks.iter())
            .filter(|block| block.stale)
            .count()
            .to_string(),
    );
    for (index, section) in sections.iter().enumerate() {
        let prefix = format!("section.{index}.");
        let id = if section.id.is_empty() {
            crate::core::archive::new_uuid()
        } else {
            section.id.clone()
        };
        record.fields.insert(format!("{prefix}id"), id);
        record
            .fields
            .insert(format!("{prefix}heading"), section.heading.clone());
        record.fields.insert(
            format!("{prefix}block_count"),
            section.blocks.len().to_string(),
        );
        for (block_index, block) in section.blocks.iter().enumerate() {
            let block_prefix = format!("{prefix}block.{block_index}.");
            record
                .fields
                .insert(format!("{block_prefix}kind"), block.kind.clone());
            record
                .fields
                .insert(format!("{block_prefix}text"), block.text.clone());
            record.fields.insert(
                format!("{block_prefix}source_ids"),
                block.source_ids.join(","),
            );
            record.fields.insert(
                format!("{block_prefix}stale"),
                if block.stale { "true" } else { "false" }.to_owned(),
            );
            record
                .fields
                .insert(format!("{block_prefix}origin"), block.origin.clone());
        }
    }
}

pub(crate) fn is_guide_field_key(key: &str) -> bool {
    let Some(rest) = key.strip_prefix("section.") else {
        return false;
    };
    let mut parts = rest.split('.');
    let Some(index) = parts.next() else {
        return false;
    };
    if index.is_empty() || !index.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some("block"), Some(block), Some(_), None) => {
            !block.is_empty() && block.bytes().all(|byte| byte.is_ascii_digit())
        }
        (Some(_), None, None, None) => true,
        _ => false,
    }
}

pub(crate) fn guide_draft(record: &ArchiveRecord) -> GuideDraft {
    GuideDraft {
        title: record.field("title").unwrap_or("").to_owned(),
        session_id: record.field("session_id").unwrap_or("").to_owned(),
        entry_id: record.field("entry_id").unwrap_or("").to_owned(),
        template_id: record
            .field("template_id")
            .filter(|value| !value.is_empty())
            .unwrap_or("general")
            .to_owned(),
        sections: guide_sections(record),
    }
}

pub(crate) fn create_guide_draft_from_sections(
    session: &ArchiveRecord,
    template_id: &str,
    headings: &[String],
) -> GuideDraft {
    GuideDraft {
        title: format!(
            "{} — Study Guide",
            session.field("title").unwrap_or("Tutoring Session")
        ),
        session_id: session.id.clone(),
        entry_id: session.field("entry_id").unwrap_or("").to_owned(),
        template_id: template_id.to_owned(),
        sections: headings
            .iter()
            .map(|heading| GuideSection {
                id: crate::core::archive::new_uuid(),
                heading: heading.clone(),
                blocks: Vec::new(),
            })
            .collect(),
    }
}

pub(crate) fn create_guide_draft(session: &ArchiveRecord, template_id: Option<&str>) -> GuideDraft {
    let template = template_id.and_then(|id| {
        resolve_guide_templates(&[]).into_iter().find(|template| {
            template.id.to_lowercase() == id.to_lowercase()
                || template.name.to_lowercase() == id.to_lowercase()
        })
    });
    let template = template.unwrap_or_else(|| {
        get_guide_template(&infer_template_id(session.field("subject").unwrap_or("")))
    });
    create_guide_draft_from_sections(session, &template.id, &template.sections)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guide_field_keys_are_bounded() {
        assert!(is_guide_field_key("section.0.id"));
        assert!(is_guide_field_key("section.12.block.3.text"));
        assert!(!is_guide_field_key("section.summary"));
        assert!(!is_guide_field_key("section.0.block.x.text"));
    }

    #[test]
    fn stored_sections_round_trip() {
        let mut record = ArchiveRecord::new(RecordType::GUIDE, "id", [("section_count", "0")]);
        let sections = vec![GuideSection {
            id: "s1".to_owned(),
            heading: "Overview".to_owned(),
            blocks: vec![GuideBlock {
                kind: "paragraph".to_owned(),
                text: "Text".to_owned(),
                source_ids: vec!["a".to_owned()],
                stale: true,
                origin: "tutor-authored".to_owned(),
            }],
        }];
        set_guide_sections(&mut record, &sections);
        let parsed = guide_sections(&record);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].blocks[0].text, "Text");
        assert!(parsed[0].blocks[0].stale);
        assert_eq!(record.field("stale_block_count"), Some("1"));
    }
}
