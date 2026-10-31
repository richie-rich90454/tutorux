use super::*;

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
    let draft = guide_draft(record);
    let sections: Vec<String> = draft
        .sections
        .iter()
        .map(|section| {
            let blocks: Vec<String> = section
                .blocks
                .iter()
                .map(|block| {
                    let prefix = match block.kind.as_str() {
                        "list-item" => "- ",
                        "quote" => "> ",
                        _ => "",
                    };
                    let stale = if block.stale {
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
                    let text = replace_inline_sources(&block.text);
                    let citations: Vec<String> = block
                        .source_ids
                        .iter()
                        .map(|id| format!("`{id}`"))
                        .collect();
                    let source_line = if citations.is_empty() {
                        String::new()
                    } else {
                        format!("  \n_Source: {}_", citations.join(", "))
                    };
                    format!("{prefix}{stale}{label_text}{text}{source_line}")
                })
                .collect();
            format!("## {}\n\n{}", section.heading, blocks.join("\n\n"))
        })
        .collect();
    let approval = record.field("approval_state").unwrap_or("draft");
    format!(
        "# {}\n\n_Tutorux study guide · {} template · {approval}_\n\n{}{}",
        draft.title,
        draft.template_id,
        sections.join("\n\n"),
        if sections.is_empty() { "" } else { "\n" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_renders_labels_sources_and_inline_citations() {
        let mut fields = BTreeMap::new();
        fields.insert("title".to_owned(), "Guide".to_owned());
        fields.insert("template_id".to_owned(), "general".to_owned());
        fields.insert("approval_state".to_owned(), "draft".to_owned());
        fields.insert("section_count".to_owned(), "1".to_owned());
        fields.insert("section.0.id".to_owned(), "s1".to_owned());
        fields.insert("section.0.heading".to_owned(), "Overview".to_owned());
        fields.insert("section.0.block_count".to_owned(), "1".to_owned());
        fields.insert("section.0.block.0.kind".to_owned(), "list-item".to_owned());
        fields.insert(
            "section.0.block.0.text".to_owned(),
            "Use [[source:00000000-0000-0000-0000-000000000001]]".to_owned(),
        );
        fields.insert(
            "section.0.block.0.source_ids".to_owned(),
            "00000000-0000-0000-0000-000000000001".to_owned(),
        );
        fields.insert("section.0.block.0.stale".to_owned(), "true".to_owned());
        fields.insert(
            "section.0.block.0.origin".to_owned(),
            "uncertain".to_owned(),
        );
        let record = ArchiveRecord {
            record_type: RecordType::GUIDE,
            id: "00000000-0000-0000-0000-000000000020".to_owned(),
            revision: 0,
            previous_offset: 0,
            fields,
            blob: Vec::new(),
        };
        let markdown = render_guide_markdown(&record);
        assert!(markdown.starts_with("# Guide\n\n_Tutorux study guide · general template · draft_"));
        assert!(markdown.contains("## Overview"));
        assert!(markdown.contains(
            "- **Source changed — review this block.** **Uncertain interpretation:** Use [source: 0000"
        ));
        assert!(markdown.contains("  \n_Source: `0000"));
    }
}
