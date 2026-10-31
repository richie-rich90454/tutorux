use serde_json::Value;

use crate::core::archive::new_uuid;
use crate::core::cli::records::{GuideBlock, GuideDraft, GuideSection, GUIDE_BLOCK_KINDS};

const MAX_GUIDE_SECTIONS: usize = 500;
const MAX_GUIDE_BLOCKS: usize = 5000;
const MAX_BLOCK_TEXT_BYTES: usize = 4 * 1024 * 1024;

pub(super) struct Proposal {
    pub(super) draft: GuideDraft,
    pub(super) schema_valid: bool,
    pub(super) warnings: Vec<String>,
}

pub(super) fn create(response_text: &str, session_id: &str, template_id: &str) -> Proposal {
    let fallback = |warning: &str| Proposal {
        draft: GuideDraft {
            title: "AI response — review required".to_owned(),
            session_id: session_id.to_owned(),
            entry_id: String::new(),
            template_id: template_id.to_owned(),
            sections: vec![GuideSection {
                id: new_uuid(),
                heading: "Unstructured response — review required".to_owned(),
                blocks: vec![GuideBlock {
                    kind: "paragraph".to_owned(),
                    text: response_text.to_owned(),
                    source_ids: Vec::new(),
                    stale: false,
                    origin: "ai-generated".to_owned(),
                }],
            }],
        },
        schema_valid: false,
        warnings: vec![warning.to_owned()],
    };

    let json_text = strip_code_fence(response_text.trim());
    let Ok(value) = serde_json::from_str::<Value>(&json_text) else {
        return fallback(
            "The response did not match the guide JSON schema; it was kept as editable text.",
        );
    };
    if json_depth_exceeded(&value, 0) {
        return fallback(
            "The response did not match the guide JSON schema; it was kept as editable text.",
        );
    }
    let Some(object) = value.as_object() else {
        return fallback(
            "The response did not contain a guide object; it was kept as editable text.",
        );
    };
    let title = object.get("title").and_then(Value::as_str).unwrap_or("");
    let response_template = object
        .get("template_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let Some(sections) = object.get("sections").and_then(Value::as_array) else {
        return fallback(
            "The response did not match the guide JSON schema; it was kept as editable text.",
        );
    };
    if title.is_empty()
        || title.len() > 1024
        || response_template.is_empty()
        || response_template.len() > 128
        || sections.is_empty()
        || sections.len() > MAX_GUIDE_SECTIONS
    {
        return fallback(
            "The response did not match the guide JSON schema; it was kept as editable text.",
        );
    }

    let mut warnings = Vec::new();
    if response_template != template_id {
        warnings.push(
            "The response named a different guide template; Tutorux kept the selected template."
                .to_owned(),
        );
    }
    let mut total_blocks = 0usize;
    let mut draft_sections = Vec::new();
    for section in sections {
        let Some(section) = section.as_object() else {
            return fallback(
                "The response contained an invalid guide section and was kept as editable text.",
            );
        };
        let heading = section.get("heading").and_then(Value::as_str).unwrap_or("");
        let Some(blocks) = section.get("blocks").and_then(Value::as_array) else {
            return fallback(
                "The response contained invalid guide sections and was kept as editable text.",
            );
        };
        total_blocks += blocks.len();
        if heading.is_empty() || heading.len() > 2048 || total_blocks > MAX_GUIDE_BLOCKS {
            return fallback(
                "The response contained invalid guide sections and was kept as editable text.",
            );
        }
        let mut draft_blocks = Vec::new();
        for block in blocks {
            let Some(block) = block.as_object() else {
                return fallback(
                    "The response contained an invalid guide block and was kept as editable text.",
                );
            };
            let kind = block.get("kind").and_then(Value::as_str).unwrap_or("");
            let text = block.get("text").and_then(Value::as_str).unwrap_or("");
            let Some(source_ids) = block.get("source_ids").and_then(Value::as_array) else {
                return fallback(
                    "The response contained invalid guide blocks and was kept as editable text.",
                );
            };
            if !GUIDE_BLOCK_KINDS.contains(&kind)
                || text.len() > MAX_BLOCK_TEXT_BYTES
                || source_ids.len() > 500
                || source_ids.iter().any(|id| !id.is_string())
            {
                return fallback(
                    "The response contained invalid guide blocks and was kept as editable text.",
                );
            }
            draft_blocks.push(GuideBlock {
                kind: kind.to_owned(),
                text: text.to_owned(),
                source_ids: source_ids
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
                stale: false,
                origin: "ai-generated".to_owned(),
            });
        }
        draft_sections.push(GuideSection {
            id: new_uuid(),
            heading: heading.to_owned(),
            blocks: draft_blocks,
        });
    }
    Proposal {
        draft: GuideDraft {
            title: title.to_owned(),
            session_id: session_id.to_owned(),
            entry_id: String::new(),
            template_id: template_id.to_owned(),
            sections: draft_sections,
        },
        schema_valid: true,
        warnings,
    }
}

fn strip_code_fence(value: &str) -> String {
    if !value.starts_with("```") {
        return value.to_owned();
    }
    let Some(first_line) = value.find('\n') else {
        return value.to_owned();
    };
    let Some(last_fence) = value.rfind("```") else {
        return value.to_owned();
    };
    if last_fence > first_line {
        value[first_line + 1..last_fence].trim().to_owned()
    } else {
        value.to_owned()
    }
}

fn json_depth_exceeded(value: &Value, depth: usize) -> bool {
    if depth > 32 {
        return true;
    }
    match value {
        Value::Array(items) => items.iter().any(|item| json_depth_exceeded(item, depth + 1)),
        Value::Object(object) => object.values().any(|item| json_depth_exceeded(item, depth + 1)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::create;

    #[test]
    fn invalid_guides_become_reviewable_text() {
        let proposal = create("{\"title\":\"x\"}", "session", "general");
        assert!(!proposal.schema_valid);
        assert_eq!(proposal.draft.title, "AI response — review required");
        assert_eq!(proposal.draft.sections[0].blocks[0].text, "{\"title\":\"x\"}");
        assert_eq!(proposal.warnings.len(), 1);
    }

    #[test]
    fn valid_guides_keep_the_selected_template() {
        let proposal = create(
            "```json\n{\"title\":\"Guide\",\"template_id\":\"other\",\"sections\":[{\"heading\":\"H\",\"blocks\":[{\"kind\":\"paragraph\",\"text\":\"T\",\"source_ids\":[]}]}]}\n```",
            "session",
            "general",
        );
        assert!(proposal.schema_valid);
        assert_eq!(proposal.draft.template_id, "general");
        assert_eq!(proposal.warnings.len(), 1);
    }
}
