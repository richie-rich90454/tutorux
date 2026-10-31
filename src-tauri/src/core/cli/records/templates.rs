use super::*;

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

pub(crate) const BUILTIN_TEMPLATES: [(&str, &str, &str, &str, &str, &[&str]); 6] = [
    (
        "general",
        "General tutoring",
        "general",
        "Concepts, explanations, corrections, instructions, examples, and next steps.",
        "Explain important concepts clearly, preserve corrections and explicit tutor instructions, and end with evidence-based next steps.",
        &[
            "Session overview",
            "Learning objectives",
            "Key concepts",
            "Detailed explanations",
            "Terminology",
            "Student misconceptions",
            "Errors and corrections",
            "Tutor instructions",
            "Worked examples",
            "Important notices",
            "Supporting materials",
            "Practice recommendations",
            "Progress since previous lessons",
            "Next-session priorities",
            "Sources",
        ],
    ),
    (
        "english",
        "English",
        "English",
        "Argumentative writing, rhetorical analysis, commentary, grammar, evidence, and revision.",
        "For writing, connect rhetorical choices to audience and purpose. Distinguish a claim from its evidence and commentary. Preserve grammar corrections and show revision examples only when supported by the session.",
        &[
            "Session overview",
            "Learning objectives",
            "Argumentative writing",
            "Rhetorical analysis",
            "Commentary",
            "Grammar",
            "Evidence integration",
            "Revision examples",
            "Student misconceptions",
            "Errors and corrections",
            "Tutor instructions",
            "Practice recommendations",
            "Next-session priorities",
            "Sources",
        ],
    ),
    (
        "mathematics",
        "Mathematics",
        "mathematics",
        "Concepts, formulas, derivations, step-by-step solutions, misconceptions, and practice.",
        "Preserve formulas and notation. Explain each solution step and why it is valid. Separate verified session examples from newly suggested practice.",
        &[
            "Session overview",
            "Learning objectives",
            "Concepts",
            "Formulas",
            "Derivations",
            "Step-by-step solutions",
            "Student misconceptions",
            "Errors and corrections",
            "Worked examples",
            "Practice recommendations",
            "Next-session priorities",
            "Sources",
        ],
    ),
    (
        "science",
        "Science",
        "science",
        "Definitions, relationships, experiments, reasoning, calculations, and limitations.",
        "State definitions and relationships precisely. Preserve experimental conditions, calculation steps, uncertainty, and scientific limitations present in the evidence.",
        &[
            "Session overview",
            "Learning objectives",
            "Definitions",
            "Relationships",
            "Experiments",
            "Scientific reasoning",
            "Calculations",
            "Limitations",
            "Student misconceptions",
            "Errors and corrections",
            "Practice recommendations",
            "Next-session priorities",
            "Sources",
        ],
    ),
    (
        "programming",
        "Programming",
        "programming",
        "Errors, debugging, algorithms, code, alternatives, and complexity.",
        "Explain observed errors and the debugging process. Keep code examples tied to session evidence; identify generated examples as new examples. Discuss complexity only when the session supports it.",
        &[
            "Session overview",
            "Learning objectives",
            "Errors",
            "Debugging steps",
            "Algorithm explanations",
            "Code examples",
            "Alternative implementations",
            "Complexity",
            "Student misconceptions",
            "Corrections",
            "Practice recommendations",
            "Next-session priorities",
            "Sources",
        ],
    ),
    (
        "language-learning",
        "Language learning",
        "language-learning",
        "Vocabulary, pronunciation, grammar, usage, corrections, and practice.",
        "Preserve vocabulary and usage in the language studied. Mark uncertain pronunciation or transcription explicitly, and distinguish observed corrections from suggested practice.",
        &[
            "Session overview",
            "Learning objectives",
            "Vocabulary",
            "Pronunciation",
            "Grammar",
            "Usage",
            "Corrections",
            "Worked examples",
            "Practice recommendations",
            "Next-session priorities",
            "Sources",
        ],
    ),
];

pub(crate) fn builtin_templates() -> Vec<(&'static str, &'static str, &'static str, &'static str, &'static str, &'static [&'static str])> {
    BUILTIN_TEMPLATES.to_vec()
}

pub(crate) fn template_sections(value: &str) -> Vec<String> {
    if value.contains('\n') || value.contains('\r') {
        value
            .split(['\r', '\n'])
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect()
    } else if value.trim().is_empty() {
        Vec::new()
    } else {
        vec![value.trim().to_owned()]
    }
}

pub(crate) fn template_value(id: &str, name: &str, subject: &str, description: &str, body: &str, sections: &[&str]) -> Value {
    json!({
        "id": id,
        "name": name,
        "origin": "built-in",
        "subject": subject,
        "description": description,
        "sections": sections,
        "body": body,
    })
}

pub(crate) fn custom_template_value(record: &ArchiveRecord) -> Value {
    json!({
        "id": record.id,
        "name": record.field("name").unwrap_or(""),
        "origin": if record.field("builtin_template_id").is_some() { "built-in override" } else { "custom" },
        "subject": record.field("subject").unwrap_or(""),
        "description": record.field("description").unwrap_or(""),
        "sections": template_sections(record.field("sections").unwrap_or("")),
        "body": record.field("body").unwrap_or(""),
    })
}

pub(crate) fn parse_template_sections(value: &str) -> CliResult<Vec<String>> {
    let sections: Vec<String> = value
        .split(['\r', '\n', ',', ';'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect();
    if sections.len() > 250 {
        return Err(CliError("A template can contain at most 250 sections.".to_owned()).into());
    }
    Ok(sections)
}

pub(crate) fn find_builtin(id: &str) -> Option<(&'static str, &'static str, &'static str, &'static str, &'static str, &'static [&'static str])> {
    builtin_templates()
        .into_iter()
        .find(|(template_id, _, _, _, _, _)| template_id.to_lowercase() == id.to_lowercase())
}

pub fn run_builtin_templates(args: ParsedArguments, output: &mut dyn CliOutput) -> CliResult<i32> {
    let rows: Vec<Value> = builtin_templates()
        .into_iter()
        .map(|(id, name, subject, description, body, sections)| {
            template_value(id, name, subject, description, body, sections)
        })
        .collect();
    emit(
        output,
        Value::Array(rows.clone()),
        &format!("{} study-guide template(s) from the built-in catalog.", rows.len()),
        args.json(),
    );
    Ok(0)
}

