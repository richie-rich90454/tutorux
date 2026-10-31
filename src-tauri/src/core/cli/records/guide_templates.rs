use super::*;

#[derive(Clone)]
pub(crate) struct GuideTemplate {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) subject: String,
    pub(crate) description: String,
    pub(crate) sections: Vec<String>,
    pub(crate) body: String,
}

fn template(
    id: &str,
    name: &str,
    subject: &str,
    description: &str,
    body: &str,
    sections: &[&str],
) -> GuideTemplate {
    GuideTemplate {
        id: id.to_owned(),
        name: name.to_owned(),
        subject: subject.to_owned(),
        description: description.to_owned(),
        body: body.to_owned(),
        sections: sections.iter().map(|value| (*value).to_owned()).collect(),
    }
}

pub(crate) fn built_in_guide_templates() -> Vec<GuideTemplate> {
    vec![
        template(
            "general",
            "General tutoring",
            "general",
            "Concepts, explanations, corrections, instructions, examples, and next steps.",
            "Explain important concepts clearly, preserve corrections and explicit tutor instructions, and end with evidence-based next steps.",
            &[
                "Session overview", "Learning objectives", "Key concepts", "Detailed explanations",
                "Terminology", "Student misconceptions", "Errors and corrections", "Tutor instructions",
                "Worked examples", "Important notices", "Supporting materials", "Practice recommendations",
                "Progress since previous lessons", "Next-session priorities", "Sources",
            ],
        ),
        template(
            "english",
            "English",
            "English",
            "Argumentative writing, rhetorical analysis, commentary, grammar, evidence, and revision.",
            "For writing, connect rhetorical choices to audience and purpose. Distinguish a claim from its evidence and commentary. Preserve grammar corrections and show revision examples only when supported by the session.",
            &[
                "Session overview", "Learning objectives", "Argumentative writing", "Rhetorical analysis",
                "Commentary", "Grammar", "Evidence integration", "Revision examples",
                "Student misconceptions", "Errors and corrections", "Tutor instructions",
                "Practice recommendations", "Next-session priorities", "Sources",
            ],
        ),
        template(
            "mathematics",
            "Mathematics",
            "mathematics",
            "Concepts, formulas, derivations, step-by-step solutions, misconceptions, and practice.",
            "Preserve formulas and notation. Explain each solution step and why it is valid. Separate verified session examples from newly suggested practice.",
            &[
                "Session overview", "Learning objectives", "Concepts", "Formulas", "Derivations",
                "Step-by-step solutions", "Student misconceptions", "Errors and corrections",
                "Worked examples", "Practice recommendations", "Next-session priorities", "Sources",
            ],
        ),
        template(
            "science",
            "Science",
            "science",
            "Definitions, relationships, experiments, reasoning, calculations, and limitations.",
            "State definitions and relationships precisely. Preserve experimental conditions, calculation steps, uncertainty, and scientific limitations present in the evidence.",
            &[
                "Session overview", "Learning objectives", "Definitions", "Relationships", "Experiments",
                "Scientific reasoning", "Calculations", "Limitations", "Student misconceptions",
                "Errors and corrections", "Practice recommendations", "Next-session priorities", "Sources",
            ],
        ),
        template(
            "programming",
            "Programming",
            "programming",
            "Errors, debugging, algorithms, code, alternatives, and complexity.",
            "Explain observed errors and the debugging process. Keep code examples tied to session evidence; identify generated examples as new examples. Discuss complexity only when the session supports it.",
            &[
                "Session overview", "Learning objectives", "Errors", "Debugging steps",
                "Algorithm explanations", "Code examples", "Alternative implementations", "Complexity",
                "Student misconceptions", "Corrections", "Practice recommendations",
                "Next-session priorities", "Sources",
            ],
        ),
        template(
            "language-learning",
            "Language learning",
            "language-learning",
            "Vocabulary, pronunciation, grammar, usage, corrections, and practice.",
            "Preserve vocabulary and usage in the language studied. Mark uncertain pronunciation or transcription explicitly, and distinguish observed corrections from suggested practice.",
            &[
                "Session overview", "Learning objectives", "Vocabulary", "Pronunciation", "Grammar",
                "Usage", "Corrections", "Worked examples", "Practice recommendations",
                "Next-session priorities", "Sources",
            ],
        ),
    ]
}

fn stored_template_sections(value: &str) -> Vec<String> {
    value
        .split(['\r', '\n'])
        .map(str::trim)
        .filter(|section| !section.is_empty())
        .map(str::to_owned)
        .collect()
}

fn apply_template_override(template: &GuideTemplate, records: &[ArchiveRecord]) -> GuideTemplate {
    let Some(override_record) = records.iter().find(|record| {
        record.record_type == RecordType::SETTINGS
            && record.field("_deleted") != Some("true")
            && record.field("record_role") == Some("guide-template")
            && record.field("builtin_template_id") == Some(template.id.as_str())
    }) else {
        return template.clone();
    };
    let sections = stored_template_sections(override_record.field("sections").unwrap_or(""));
    let fallback = |key: &str, value: &str| {
        override_record
            .field(key)
            .filter(|stored| !stored.is_empty())
            .unwrap_or(value)
            .to_owned()
    };
    GuideTemplate {
        id: template.id.clone(),
        name: fallback("name", &template.name),
        subject: fallback("subject", &template.subject),
        description: fallback("description", &template.description),
        sections: if sections.is_empty() {
            template.sections.clone()
        } else {
            sections
        },
        body: fallback("body", &template.body),
    }
}

pub(crate) fn custom_guide_templates(records: &[ArchiveRecord]) -> Vec<GuideTemplate> {
    records
        .iter()
        .filter(|record| {
            record.record_type == RecordType::SETTINGS
                && record.field("_deleted") != Some("true")
                && record.field("record_role") == Some("guide-template")
                && record
                    .field("builtin_template_id")
                    .map(str::is_empty)
                    .unwrap_or(true)
        })
        .map(|record| GuideTemplate {
            id: record.id.clone(),
            name: record
                .field("name")
                .unwrap_or("Untitled template")
                .to_owned(),
            subject: record.field("subject").unwrap_or("general").to_owned(),
            description: record.field("description").unwrap_or("").to_owned(),
            sections: stored_template_sections(record.field("sections").unwrap_or("")),
            body: record.field("body").unwrap_or("").to_owned(),
        })
        .collect()
}

pub(crate) fn resolve_guide_templates(records: &[ArchiveRecord]) -> Vec<GuideTemplate> {
    let mut resolved: Vec<GuideTemplate> = built_in_guide_templates()
        .iter()
        .map(|template| apply_template_override(template, records))
        .collect();
    let mut known: BTreeSet<String> = resolved
        .iter()
        .map(|template| template.id.to_lowercase())
        .collect();
    for custom in custom_guide_templates(records) {
        if known.insert(custom.id.to_lowercase()) {
            resolved.push(custom);
        }
    }
    resolved
}

pub(crate) fn get_guide_template(id: &str) -> GuideTemplate {
    built_in_guide_templates()
        .into_iter()
        .find(|template| template.id == id)
        .unwrap_or_else(|| built_in_guide_templates().remove(0))
}

pub(crate) fn infer_template_id(subject: &str) -> String {
    let value = subject.to_lowercase();
    let matches = |terms: &[&str]| terms.iter().any(|term| value.contains(term));
    if matches(&["english", "writing", "literature", "rhetoric", "essay"]) {
        return "english".to_owned();
    }
    if matches(&["math", "algebra", "geometry", "calculus", "arithmetic"]) {
        return "mathematics".to_owned();
    }
    if matches(&["programming", "coding", "software", "computer science"]) {
        return "programming".to_owned();
    }
    if matches(&[
        "language",
        "spanish",
        "french",
        "mandarin",
        "chinese",
        "german",
        "japanese",
        "italian",
        "pronunciation",
        "vocabulary",
    ]) {
        return "language-learning".to_owned();
    }
    if matches(&["science", "biology", "chemistry", "physics", "experiment"]) {
        return "science".to_owned();
    }
    "general".to_owned()
}
