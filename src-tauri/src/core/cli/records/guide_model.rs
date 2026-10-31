use super::*;

// ---------------------------------------------------------------------------
// Guides
// ---------------------------------------------------------------------------

pub(crate) const DEFAULT_GUIDE_SECTIONS: [&str; 4] = ["Summary", "Key points", "Practice", "Next steps"];

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
            blocks.push(GuideBlock {
                kind: record
                    .field(&format!("{block_prefix}kind"))
                    .unwrap_or("paragraph")
                    .to_owned(),
                text: record
                    .field(&format!("{block_prefix}text"))
                    .unwrap_or("")
                    .to_owned(),
                source_ids: split_ids(
                    record
                        .field(&format!("{block_prefix}source_ids"))
                        .unwrap_or(""),
                ),
                stale: record.field(&format!("{block_prefix}stale")) == Some("true"),
                origin: record
                    .field(&format!("{block_prefix}origin"))
                    .unwrap_or("unknown")
                    .to_owned(),
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

pub(crate) fn set_guide_sections(record: &mut ArchiveRecord, sections: &[GuideSection]) {
    let keys: Vec<String> = record
        .fields
        .keys()
        .filter(|key| key.starts_with("section."))
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
        record.fields.insert(
            format!("{prefix}id"),
            if section.id.is_empty() {
                crate::core::archive::new_uuid()
            } else {
                section.id.clone()
            },
        );
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

pub(crate) fn guide_context(snapshot: &ArchiveSnapshot, session_id: &str) -> Result<String> {
    let mut lines = Vec::new();
    for annotation in snapshot.list_records(RecordType::ANNOTATION, false)? {
        if annotation.field("session_id").map(str::to_lowercase).as_deref()
            != Some(session_id)
        {
            continue;
        }
        let title = annotation.field("title").unwrap_or("");
        let content = annotation.field("content").unwrap_or("");
        if !content.is_empty() {
            lines.push(format!("{title}: {content}"));
        }
    }
    for transcript in snapshot.list_records(RecordType::TRANSCRIPT_SEGMENT, false)? {
        if transcript.field("session_id").map(str::to_lowercase).as_deref()
            != Some(session_id)
        {
            continue;
        }
        let text = transcript.field("text").unwrap_or("");
        if !text.is_empty() {
            lines.push(text.to_owned());
        }
    }
    Ok(lines.join("\n"))
}

pub(crate) fn make_guide(
    snapshot: &ArchiveSnapshot,
    session_id: &str,
    template_id: &str,
    title: &str,
) -> Result<ArchiveRecord> {
    let session = snapshot
        .get_record(RecordType::SESSION, session_id)?
        .ok_or_else(|| CoreError::new("session_missing", "Session was not found."))?;
    let timestamp = now_us().to_string();
    let headings: Vec<String> = if template_id.is_empty() || template_id == "auto" {
        let inferred = infer_template_id(session.field("subject").unwrap_or(""));
        find_builtin(&inferred)
            .map(|(_, _, _, _, _, sections)| sections.iter().map(|value| (*value).to_owned()).collect())
            .unwrap_or_else(|| DEFAULT_GUIDE_SECTIONS.iter().map(|value| value.to_string()).collect())
    } else {
        find_builtin(template_id)
            .map(|(_, _, _, _, _, sections)| sections.iter().map(|value| (*value).to_owned()).collect())
            .or_else(|| {
                snapshot
                    .list_records(RecordType::SETTINGS, false)
                    .ok()
                    .and_then(|records| {
                        records
                            .into_iter()
                            .find(|record| {
                                record.field("record_role") == Some("guide-template")
                                    && (record.id.to_lowercase() == template_id.to_lowercase()
                                        || record.field("name").map(str::to_lowercase)
                                            == Some(template_id.to_lowercase()))
                            })
                            .map(|record| template_sections(record.field("sections").unwrap_or("")))
                    })
            })
            .filter(|sections| !sections.is_empty())
            .unwrap_or_else(|| DEFAULT_GUIDE_SECTIONS.iter().map(|value| value.to_string()).collect())
    };
    let context = guide_context(snapshot, session_id)?;
    let annotations = snapshot.list_records(RecordType::ANNOTATION, false)?;
    let source_ids: Vec<String> = annotations
        .iter()
        .filter(|record| record.field("session_id").map(str::to_lowercase).as_deref() == Some(session_id))
        .map(|record| record.id.to_lowercase())
        .collect();
    let mut sections = Vec::new();
    for heading in headings {
        let text = if context.is_empty() {
            format!("No observations were recorded yet for {heading}.")
        } else {
            context.clone()
        };
        sections.push(GuideSection {
            id: crate::core::archive::new_uuid(),
            heading,
            blocks: vec![GuideBlock {
                kind: "paragraph".to_owned(),
                text,
                source_ids: source_ids.clone(),
                stale: false,
                origin: "tutor-authored".to_owned(),
            }],
        });
    }
    let resolved_template = if template_id.is_empty() || template_id == "auto" {
        infer_template_id(session.field("subject").unwrap_or(""))
    } else {
        template_id.to_lowercase()
    };
    let mut record = ArchiveRecord::new(
        RecordType::GUIDE,
        crate::core::archive::new_uuid(),
        [
            ("session_id", session_id.to_owned()),
            ("entry_id", session.fields.get("entry_id").cloned().unwrap_or_default()),
            (
                "title",
                if title.is_empty() {
                    format!(
                        "{} — Study Guide",
                        session.field("title").unwrap_or("Tutoring Session")
                    )
                } else {
                    title.to_owned()
                },
            ),
            ("template_id", resolved_template),
            ("approval_state", "draft".to_owned()),
            ("created_at_us", timestamp.clone()),
            ("updated_at_us", timestamp),
        ],
    );
    set_guide_sections(&mut record, &sections);
    Ok(record)
}

pub(crate) fn infer_template_id(subject: &str) -> String {
    let value = subject.to_lowercase();
    if ["english", "writing", "literature", "rhetoric", "essay"]
        .iter()
        .any(|term| value.contains(term))
    {
        return "english".to_owned();
    }
    if ["math", "algebra", "geometry", "calculus", "arithmetic"]
        .iter()
        .any(|term| value.contains(term))
    {
        return "mathematics".to_owned();
    }
    if ["programming", "coding", "software", "computer science"]
        .iter()
        .any(|term| value.contains(term))
    {
        return "programming".to_owned();
    }
    if ["language", "spanish", "french", "german", "chinese", "japanese"]
        .iter()
        .any(|term| value.contains(term))
    {
        return "language-learning".to_owned();
    }
    if ["science", "biology", "chemistry", "physics"].iter().any(|term| value.contains(term)) {
        return "science".to_owned();
    }
    "general".to_owned()
}

pub(crate) fn guide_export_text(record: &ArchiveRecord, format: &str) -> String {
    let title = record.field("title").unwrap_or("Study guide");
    let sections = guide_sections(record);
    match format {
        "html" => {
            let mut output = format!("<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title></head><body><h1>{}</h1>", escape_html(title), escape_html(title));
            for section in sections {
                output.push_str(&format!("<h2>{}</h2>", escape_html(&section.heading)));
                for block in section.blocks {
                    output.push_str(&format!("<p>{}</p>", escape_html(&block.text)));
                }
            }
            output.push_str("</body></html>");
            output
        }
        "json" => format!(
            "{}\n",
            serde_json::to_string_pretty(&plain(record)).unwrap_or_else(|_| "{}".to_owned())
        ),
        _ => render_guide_markdown(record),
    }
}

pub(crate) fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub(crate) fn guide_block_label(kind: &str, origin: &str) -> String {
    match origin {
        "ai-generated" => match kind {
            "recommendation" => "AI recommendation".to_owned(),
            "instruction" => "AI-drafted instruction".to_owned(),
            "example" | "worked-example" => "AI-generated example".to_owned(),
            _ => {
                let semantic = guide_block_label(kind, "tutor-authored");
                if semantic.is_empty() {
                    "AI-generated content".to_owned()
                } else {
                    format!("AI-generated {}", semantic.to_lowercase())
                }
            }
        },
        "human-edited" => match kind {
            "instruction" => "Tutor-edited instruction".to_owned(),
            "recommendation" => "Tutor-edited recommendation".to_owned(),
            "example" | "worked-example" => "Tutor-edited example".to_owned(),
            _ => "Tutor-edited content".to_owned(),
        },
        "uncertain" => "Uncertain interpretation".to_owned(),
        "system-generated" => "Tutorux-generated notice".to_owned(),
        "unknown" => "Content with unverified provenance".to_owned(),
        _ => match kind {
            "instruction" => "Tutor instruction".to_owned(),
            "recommendation" => "AI recommendation".to_owned(),
            "worked-example" => "Worked example".to_owned(),
            _ => String::new(),
        },
    }
}

pub(crate) fn render_guide_markdown(record: &ArchiveRecord) -> String {
    let mut sections = Vec::new();
    for section in guide_sections(record) {
        let mut blocks = Vec::new();
        for block in section.blocks {
            let prefix_text = if block.kind == "list-item" {
                "- "
            } else if block.kind == "quote" {
                "> "
            } else {
                ""
            };
            let stale_text = if block.stale {
                "**Source changed — review this block.** "
            } else {
                ""
            };
            let label = guide_block_label(&block.kind, &block.origin);
            let label_text = if label.is_empty() {
                String::new()
            } else {
                format!("**{label}:** ")
            };
            let text = block.text.replace("[[source:", "[source:");
            let citations: Vec<String> = block
                .source_ids
                .iter()
                .map(|value| format!("`{value}`"))
                .collect();
            let source_line = if citations.is_empty() {
                String::new()
            } else {
                format!("  \n_Source: {}_", citations.join(", "))
            };
            blocks.push(format!("{prefix_text}{stale_text}{label_text}{text}{source_line}"));
        }
        sections.push(format!("## {}\n\n{}", section.heading, blocks.join("\n\n")));
    }
    let title = record.field("title").unwrap_or("");
    let template = record.field("template_id").unwrap_or("general");
    let approval = record.field("approval_state").unwrap_or("draft");
    format!(
        "# {title}\n\n_Tutorux study guide · {template} template · {approval}_\n\n{}{}",
        sections.join("\n\n"),
        if sections.is_empty() { "" } else { "\n" }
    )
}

pub(crate) fn validate_guide(record: &ArchiveRecord) -> std::result::Result<(), String> {
    if record.field("title").unwrap_or("").trim().is_empty() {
        return Err("Cannot export a guide without a title.".to_owned());
    }
    let section_count = record
        .field("section_count")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if section_count == 0 {
        return Err("A guide must contain at least one section.".to_owned());
    }
    const KINDS: [&str; 12] = [
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
    const ORIGINS: [&str; 7] = [
        "tutor-authored",
        "session-evidence",
        "ai-generated",
        "human-edited",
        "uncertain",
        "system-generated",
        "unknown",
    ];
    for section in guide_sections(record) {
        if section.heading.trim().is_empty() {
            return Err("Every guide section needs a heading.".to_owned());
        }
        for block in section.blocks {
            if !KINDS.contains(&block.kind.as_str()) {
                return Err(format!(
                    "Guide block kind “{}” is not supported for export.",
                    block.kind
                ));
            }
            if !ORIGINS.contains(&block.origin.as_str()) {
                return Err(format!(
                    "Guide block provenance “{}” is not supported for export.",
                    block.origin
                ));
            }
        }
    }
    Ok(())
}

